import { expect, test } from "bun:test";

import { codex } from "../src/codex/index.js";
import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { liveEnabled } from "./live-helper.js";

const PROMPT = "Reply with exactly the word: pong";

test("live: codex answers a trivial prompt", async () => {
  if (!(await liveEnabled("codex"))) {
    // biome-ignore lint/suspicious/noConsole: test skip notice.
    console.warn("skipping live test (set ANYAGENT_LIVE=1)");
    return;
  }
  const agent = create(codex());
  const res = await agent.run(PROMPT, { permission: "read" });
  expect(res.text.toLowerCase()).toContain("pong");
  // Real-output check: the parser extracted usage from turn.completed.
  expect(typeof res.usage?.outputTokens).toBe("number");
  // The thread id must be reachable for resume.
  expect(typeof (res.raw as { threadId?: string }).threadId).toBe("string");
}, 120_000);

// The drift canary: production parsing is lenient, but the live tier runs the
// real CLI's fresh output through strict mode so an upstream format change
// (renamed event, new type, moved field) throws instead of silently emitting
// empty text. Asserts shape, never content — LLM output is non-deterministic.
test("live: real output parses clean under strict mode", async () => {
  if (!(await liveEnabled("codex"))) {
    return;
  }
  const adapter = codex();
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
}, 120_000);
