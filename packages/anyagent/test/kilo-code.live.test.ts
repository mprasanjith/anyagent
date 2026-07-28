import { expect, test } from "bun:test";

import { create } from "../src/index.js";
import { kiloCode } from "../src/kilo-code.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("kilo")));

const PROMPT = "Reply with exactly the word: pong";
// e.g. ANYAGENT_KILO_MODEL=openai/gpt-5.4-mini with a credential for that
// provider in kilo's auth store.
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
// against its own endpoint so a fork-side protocol change is caught here.
live(
  "live: a real session streams its turn as events",
  async () => {
    const session = create(kiloCode()).session(MODEL ? { model: MODEL } : {});
    let sawText = false;
    try {
      for await (const event of session.run(PROMPT)) {
        if (event.type === "text-delta") {
          sawText = true;
        }
      }
    } finally {
      await session.close();
    }
    expect(sawText).toBe(true);
  },
  120_000
);
