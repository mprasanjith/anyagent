import { expect, test } from "bun:test";

import { cline } from "../src/cline.js";
import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("cline")));

// Multi-word on purpose: cline misparses a single-word prompt as a command.
const PROMPT = "Reply with exactly the word: pong";
// cline uses the provider configured via `cline auth`; the model rides -m,
// e.g. ANYAGENT_CLINE_MODEL=openai/gpt-4o-mini.
const MODEL = process.env.ANYAGENT_CLINE_MODEL;

live(
  "live: cline answers a trivial prompt",
  async () => {
    const agent = create(cline());
    const res = await agent.run(PROMPT, MODEL ? { model: MODEL } : {});
    expect(res.text.toLowerCase()).toContain("pong");
    // Real-output check: usage came from run_result's aggregate accounting.
    expect(typeof res.usage?.outputTokens).toBe("number");
    expect(typeof res.usage?.costUsd).toBe("number");
  },
  120_000
);

// The drift canary: production parsing is lenient, but the live tier runs the
// real CLI's fresh output through strict mode so an upstream format change
// throws instead of silently emitting empty text. The stray plain-text
// notices cline prints are filtered before parsing, in strict mode too.
live(
  "live: real output parses clean under strict mode",
  async () => {
    const adapter = cline();
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
