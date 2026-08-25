import { expect, test } from "bun:test";

import { create } from "../src/index.js";
import { opencode } from "../src/opencode.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("opencode")));

const PROMPT = "Reply with exactly the word: pong";
// Live runs use the CLI's own configured default model unless overridden,
// e.g. ANYAGENT_OPENCODE_MODEL=openrouter/openai/gpt-4o-mini with an
// OPENROUTER_API_KEY in the environment.
const MODEL = process.env.ANYAGENT_OPENCODE_MODEL;

live(
  "live: opencode answers a trivial prompt",
  async () => {
    const agent = create(opencode());
    const res = await agent.run(PROMPT, MODEL ? { model: MODEL } : {});
    expect(res.text.toLowerCase()).toContain("pong");
    // Real-output check: the endpoint's own usage reached the result.
    expect(typeof res.usage?.outputTokens).toBe("number");
    // The session id must be reachable for resume.
    expect(typeof res.sessionId).toBe("string");
  },
  120_000
);

// The drift canary: a live turn's notifications are translated as they arrive,
// so an upstream protocol change surfaces here instead of as an empty answer.
// Asserts shape, never content — LLM output is non-deterministic.
live(
  "live: a real session streams its turn as events",
  async () => {
    const session = create(opencode()).session(MODEL ? { model: MODEL } : {});
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

// The Zen quota drift canary. Only asserts where a Zen credential is present
// — a BYOK-only opencode has no gateway meter to read.
live(
  "live: the Zen gateway still answers in the shape we parse",
  async () => {
    const status = await create(opencode(), { network: true }).usageStatus();
    if (status.state === "unknown") {
      console.warn("no opencode Zen credential; skipping the quota canary");
      return;
    }
    expect(status.windows?.length).toBeGreaterThan(0);
    for (const window of status.windows ?? []) {
      expect(["monthly", "rolling", "weekly"]).toContain(window.label);
      expect(window.usedPercent).toBeGreaterThanOrEqual(0);
      expect(window.usedPercent).toBeLessThanOrEqual(100);
      expect(window.resetsAt?.getTime()).toBeGreaterThan(
        Date.now() - 86_400_000
      );
    }
  },
  30_000
);
