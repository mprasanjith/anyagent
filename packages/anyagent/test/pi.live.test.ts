import { expect, test } from "bun:test";

import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { pi } from "../src/pi.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("pi")));

const PROMPT = "Reply with exactly the word: pong";
// e.g. ANYAGENT_PI_MODEL=openrouter/openai/gpt-4o-mini with an
// OPENROUTER_API_KEY in the environment (pi is BYOK).
const MODEL = process.env.ANYAGENT_PI_MODEL;

live(
  "live: pi answers a trivial prompt",
  async () => {
    const agent = create(pi());
    const res = await agent.run(PROMPT, {
      ...(MODEL ? { model: MODEL } : {}),
      permission: "read",
    });
    expect(res.text.toLowerCase()).toContain("pong");
    // Real-output check: usage summed from turn_end events.
    expect(typeof res.usage?.outputTokens).toBe("number");
    // The session id must be reachable for resume.
    expect(typeof (res.raw as { sessionId?: string }).sessionId).toBe("string");
  },
  120_000
);

// The drift canary: production parsing is lenient, but the live tier runs the
// real CLI's fresh output through strict mode so an upstream format change
// throws instead of silently emitting empty text. This also guards pi's
// exit-code quirk: a failed turn must throw despite the zero exit.
live(
  "live: real output parses clean under strict mode",
  async () => {
    const adapter = pi();
    const inv = adapter.buildInvocation(PROMPT, {
      ...(MODEL ? { model: MODEL } : {}),
      permission: "read",
    });
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
