import { expect, test } from "bun:test";

import { goose } from "../src/goose.js";
import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("goose")));

const PROMPT = "Reply with exactly the word: pong";
// The model splits at the first slash into --provider/--model, e.g.
// ANYAGENT_GOOSE_MODEL=openrouter/openai/gpt-4o-mini (with the provider's
// key env var set); a bare model leaves the provider to goose's config.
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

// The drift canary: production parsing is lenient, but the live tests run the
// real CLI's fresh output through strict mode so an upstream format change
// (new content block, renamed event) throws instead of silently emitting
// empty text. Asserts shape, never content — LLM output is non-deterministic.
live(
  "live: real output parses clean under strict mode",
  async () => {
    const adapter = goose();
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

// Free (no LLM call): `goose info -v` is the probe behind authStatus.
live(
  "live: authStatus answers from goose info without a paid run",
  async () => {
    const status = await create(goose()).authStatus();
    expect(["authenticated", "unauthenticated", "unknown"]).toContain(
      status.state
    );
  },
  30_000
);
