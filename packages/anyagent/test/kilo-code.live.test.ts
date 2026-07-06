import { expect, test } from "bun:test";

import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { kiloCode } from "../src/kilo-code/index.js";
import { liveEnabled } from "./live-helper.js";

const PROMPT = "Reply with exactly the word: pong";
// e.g. ANYAGENT_KILO_MODEL=openrouter/openai/gpt-4o-mini with an
// OPENROUTER_API_KEY in the environment.
const MODEL = process.env.ANYAGENT_KILO_MODEL;

test("live: kilo answers a trivial prompt", async () => {
  if (!(await liveEnabled("kilo"))) {
    // biome-ignore lint/suspicious/noConsole: test skip notice.
    console.warn("skipping live test (set ANYAGENT_LIVE=1)");
    return;
  }
  const agent = create(kiloCode());
  const res = await agent.run(PROMPT, MODEL ? { model: MODEL } : {});
  expect(res.text.toLowerCase()).toContain("pong");
  expect(typeof res.usage?.outputTokens).toBe("number");
  expect(typeof (res.raw as { sessionId?: string }).sessionId).toBe("string");
}, 120_000);

// The drift canary; see opencode.live.test.ts — kilo runs the same check
// against its own binary so a fork-side format change is caught here.
test("live: real output parses clean under strict mode", async () => {
  if (!(await liveEnabled("kilo"))) {
    return;
  }
  const adapter = kiloCode();
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
