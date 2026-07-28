import { expect, test } from "bun:test";

import { goose } from "../src/goose.js";
import { create } from "../src/index.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("goose")));

const PROMPT = "Reply with exactly the word: pong";
// A model id the configured provider serves, e.g.
// ANYAGENT_GOOSE_MODEL=anthropic/claude-sonnet-4.5 on openrouter; unset leaves
// the session on goose's own configured model.
const MODEL = process.env.ANYAGENT_GOOSE_MODEL;

live(
  "live: goose answers a trivial prompt over ACP",
  async () => {
    const agent = create(goose());
    const res = await agent.run(PROMPT, MODEL ? { model: MODEL } : {});
    expect(res.text.toLowerCase()).toContain("pong");
    // A live turn opens on the endpoint's own session id.
    expect(typeof res.sessionId).toBe("string");
  },
  120_000
);

// The drift canary: the adapter's whole settings surface is two config options,
// and the endpoint rejects a configId it no longer publishes, so a turn
// carrying both fails loud if either is renamed or dropped.
live(
  "live: the endpoint still accepts model and thinking_effort",
  async () => {
    const session = create(goose()).session({
      effort: "low",
      ...(MODEL ? { model: MODEL } : {}),
    });
    try {
      const res = await session.run(PROMPT);
      expect(typeof res.text).toBe("string");
    } finally {
      await session.close();
    }
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
