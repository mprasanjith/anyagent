import { expect, test } from "bun:test";

import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { opencode } from "../src/opencode/index.js";
import { liveEnabled } from "./live-helper.js";

const PROMPT = "Reply with exactly the word: pong";
// Live runs use the CLI's own configured default model unless overridden,
// e.g. ANYAGENT_OPENCODE_MODEL=openrouter/openai/gpt-4o-mini with an
// OPENROUTER_API_KEY in the environment.
const MODEL = process.env.ANYAGENT_OPENCODE_MODEL;

test("live: opencode answers a trivial prompt", async () => {
  if (!(await liveEnabled("opencode"))) {
    console.warn("skipping live test (set ANYAGENT_LIVE=1)");
    return;
  }
  const agent = create(opencode());
  const res = await agent.run(PROMPT, MODEL ? { model: MODEL } : {});
  expect(res.text.toLowerCase()).toContain("pong");
  // Real-output check: the parser summed usage from step_finish events.
  expect(typeof res.usage?.outputTokens).toBe("number");
  // The session id must be reachable for resume.
  expect(typeof (res.raw as { sessionId?: string }).sessionId).toBe("string");
}, 120_000);

// The drift canary: production parsing is lenient, but the live tier runs the
// real CLI's fresh output through strict mode so an upstream format change
// (renamed event, new type, moved field) throws instead of silently emitting
// empty text. Asserts shape, never content — LLM output is non-deterministic.
test("live: real output parses clean under strict mode", async () => {
  if (!(await liveEnabled("opencode"))) {
    return;
  }
  const adapter = opencode();
  const inv = adapter.buildInvocation(
    PROMPT,
    MODEL ? { model: MODEL, permission: "edit" } : { permission: "edit" }
  );
  const source = spawnAndStream(inv);
  let sawText = false;
  let finalText: string | undefined;
  for await (const ev of adapter.parse(source, { strict: true })) {
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
