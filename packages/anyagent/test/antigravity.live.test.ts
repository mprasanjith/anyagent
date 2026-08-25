import { expect, test } from "bun:test";

import { antigravity } from "../src/antigravity.js";
import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("agy")));

const PROMPT = "Reply with exactly the word: pong";
// The default `auto` model can spiral on trivial prompts; live runs pin the
// cheapest listed model.
const MODEL = "gemini-3.5-flash-low";

live(
  "live: antigravity answers a trivial prompt",
  async () => {
    const agent = create(antigravity());
    const res = await agent.run(PROMPT, { model: MODEL });
    expect(res.text.toLowerCase()).toContain("pong");
    // Real-output check: the parser extracted usage from the result event.
    expect(typeof res.usage?.outputTokens).toBe("number");
    // The conversation id must be reachable for resume.
    expect(typeof res.sessionId).toBe("string");
  },
  300_000
);

// The drift canary: production parsing is lenient, but the live tests run the
// real CLI's fresh output through strict mode so an upstream format change
// (renamed event, new step type, moved field) throws instead of silently
// emitting empty text. Asserts shape, never content — LLM output is
// non-deterministic.
live(
  "live: real output parses clean under strict mode",
  async () => {
    const adapter = antigravity();
    const inv = adapter.buildInvocation(PROMPT, { model: MODEL });
    const source = spawnAndStream(inv);
    let sawText = false;
    let finalText: string | undefined;
    const stream = adapter.parse(source, { strict: true });
    for await (const ev of stream) {
      if (ev.type === "text-delta") {
        sawText = true;
      }
      if (ev.type === "done") {
        finalText = ev.result.text;
      }
    }
    expect(sawText).toBe(true);
    expect(typeof finalText).toBe("string");
  },
  300_000
);

// Discovery is free: no model call is ever made for auth or listing.
live(
  "live: authStatus and models answer without a paid run",
  async () => {
    const agent = create(antigravity());
    const status = await agent.authStatus();
    expect(["authenticated", "unauthenticated", "unknown"]).toContain(
      status.state
    );
    const models = await agent.models();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(typeof m.id).toBe("string");
    }
  },
  60_000
);

// The quota drift canary. Loopback needs no opt-in, but it does need a
// running product: with none up this is indistinguishable from a reshaped
// payload, so it reports that rather than failing.
live(
  "live: the local language server still answers the quota RPC",
  async () => {
    const status = await create(antigravity()).usageStatus();
    if (status.state === "unknown") {
      console.warn(
        "no Antigravity product is running; open `agy` to exercise this"
      );
      return;
    }
    expect(status.windows?.length).toBeGreaterThan(0);
    for (const window of status.windows ?? []) {
      expect(typeof window.label).toBe("string");
      expect(window.usedPercent).toBeGreaterThanOrEqual(0);
      expect(window.usedPercent).toBeLessThanOrEqual(100);
    }
    // Scoping never invents a window the unscoped answer lacked.
    const scoped = await create(antigravity()).usageStatus({
      model: "claude-opus-4-6-thinking",
    });
    expect(scoped.windows?.length ?? 0).toBeLessThanOrEqual(
      status.windows?.length ?? 0
    );
  },
  30_000
);
