import { expect, test } from "bun:test";

import { claudeCode } from "../src/claude-code.js";
import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("claude")));

const PROMPT = "Reply with exactly the word: pong";

live(
  "live: claude answers a trivial prompt",
  async () => {
    const agent = create(claudeCode());
    const res = await agent.run(PROMPT, { readOnly: true });
    expect(res.text.toLowerCase()).toContain("pong");
    // Real-output check: the parser extracted usage and the session id from
    // the result event.
    expect(typeof res.usage?.outputTokens).toBe("number");
    expect(typeof res.sessionId).toBe("string");
  },
  60_000
);

// The drift canary: production parsing is lenient, but the live tests run the
// real CLI's fresh output through strict mode so an upstream format change
// (renamed event, new type, moved field) throws instead of silently emitting
// empty text. Asserts shape, never content — LLM output is non-deterministic.
live(
  "live: real output parses clean under strict mode",
  async () => {
    const adapter = claudeCode();
    const inv = adapter.buildInvocation(PROMPT, { readOnly: true });
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
  60_000
);

// The usage drift canary. `usageStatus` degrades to `{ state: "unknown" }` on
// every failure, which is right for callers but hides an upstream reshape from
// us — so this asserts the live endpoint actually produced windows, and that
// each one carries the fields the normalization promises. Percentages and
// reset times are real numbers that move, so only shape is asserted.
live(
  "live: the usage endpoint still answers in the shape we parse",
  async () => {
    const agent = create(claudeCode(), { network: true });
    const status = await agent.usageStatus();
    expect(status.state).not.toBe("unknown");
    expect(status.windows?.length).toBeGreaterThan(0);
    // Live means now; a cache fallback would stamp an older `asOf`.
    expect(status.asOf?.getTime()).toBeGreaterThan(Date.now() - 60_000);
    for (const window of status.windows ?? []) {
      expect(typeof window.label).toBe("string");
      expect(window.usedPercent).toBeGreaterThanOrEqual(0);
      expect(window.usedPercent).toBeLessThanOrEqual(100);
    }
    // A model-scoped query never invents a window the unscoped one lacked.
    const scoped = await agent.usageStatus({ model: "opus" });
    expect(scoped.windows?.length ?? 0).toBeLessThanOrEqual(
      status.windows?.length ?? 0
    );
  },
  30_000
);
