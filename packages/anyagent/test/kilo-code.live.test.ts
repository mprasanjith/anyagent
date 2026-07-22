import { expect, test } from "bun:test";

import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { kiloCode } from "../src/kilo-code.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("kilo")));

const PROMPT = "Reply with exactly the word: pong";
// e.g. ANYAGENT_KILO_MODEL=openrouter/openai/gpt-4o-mini with an
// OPENROUTER_API_KEY in the environment.
const MODEL = process.env.ANYAGENT_KILO_MODEL;

live(
  "live: kilo answers a trivial prompt",
  async () => {
    const agent = create(kiloCode());
    const res = await agent.run(PROMPT, MODEL ? { model: MODEL } : {});
    expect(res.text.toLowerCase()).toContain("pong");
    expect(typeof res.usage?.outputTokens).toBe("number");
    expect(typeof res.sessionId).toBe("string");
  },
  120_000
);

// The drift canary; see opencode.live.test.ts — kilo runs the same check
// against its own binary so a fork-side format change is caught here.
live(
  "live: real output parses clean under strict mode",
  async () => {
    const adapter = kiloCode();
    const inv = adapter.buildInvocation(PROMPT, MODEL ? { model: MODEL } : {});
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
  },
  120_000
);
