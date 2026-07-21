import { expect, test } from "bun:test";

import { claudeCode } from "../src/claude-code.js";
import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { liveEnabled } from "./live-helper.js";

const PROMPT = "Reply with exactly the word: pong";

test("live: claude answers a trivial prompt", async () => {
  if (!(await liveEnabled("claude"))) {
    console.warn("skipping live test (set ANYAGENT_LIVE=1)");
    return;
  }
  const agent = create(claudeCode());
  const res = await agent.run(PROMPT, { permission: "read" });
  expect(res.text.toLowerCase()).toContain("pong");
  // Real-output check: the parser extracted usage from the result event.
  expect(typeof res.usage?.outputTokens).toBe("number");
}, 60_000);

// The drift canary: production parsing is lenient, but the live tier runs the
// real CLI's fresh output through strict mode so an upstream format change
// (renamed event, new type, moved field) throws instead of silently emitting
// empty text. Asserts shape, never content — LLM output is non-deterministic.
test("live: real output parses clean under strict mode", async () => {
  if (!(await liveEnabled("claude"))) {
    return;
  }
  const adapter = claudeCode();
  const inv = adapter.buildInvocation(PROMPT, { permission: "read" });
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
}, 60_000);
