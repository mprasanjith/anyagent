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

// The drift canary: production parsing is lenient, but the live tier runs the
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
