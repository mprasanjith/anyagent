import { expect, test } from "bun:test";

import { goose } from "../src/goose.js";
import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("goose")));

const PROMPT = "Reply with exactly the word: pong";
// Goose reads its provider from GOOSE_PROVIDER/config; the model rides the
// --model flag, e.g. GOOSE_PROVIDER=openrouter OPENROUTER_API_KEY=…
// ANYAGENT_GOOSE_MODEL=openai/gpt-4o-mini.
const MODEL = process.env.ANYAGENT_GOOSE_MODEL;

live(
  "live: goose answers a trivial prompt",
  async () => {
    const agent = create(goose());
    const res = await agent.run(PROMPT, MODEL ? { model: MODEL } : {});
    expect(res.text.toLowerCase()).toContain("pong");
    // Real-output check: the parser read token counts from `complete`.
    expect(typeof res.usage?.outputTokens).toBe("number");
  },
  120_000
);

// The drift canary: production parsing is lenient, but the live tier runs the
// real CLI's fresh output through strict mode so an upstream format change
// (new content block, renamed event) throws instead of silently emitting
// empty text. Asserts shape, never content — LLM output is non-deterministic.
live(
  "live: real output parses clean under strict mode",
  async () => {
    const adapter = goose();
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
  },
  120_000
);
