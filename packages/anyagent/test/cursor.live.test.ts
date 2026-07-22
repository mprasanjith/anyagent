import { expect, test } from "bun:test";

import { cursor } from "../src/cursor.js";
import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("agent")));

const PROMPT = "Reply with exactly the word: pong";

live(
  "live: cursor answers a trivial prompt",
  async () => {
    const agent = create(cursor());
    const res = await agent.run(PROMPT, { readOnly: true });
    expect(res.text.toLowerCase()).toContain("pong");
    // Real-output check: the parser extracted the camelCase usage block.
    expect(typeof res.usage?.inputTokens).toBe("number");
    // The chat id must be reachable for resume.
    expect(typeof res.sessionId).toBe("string");
  },
  120_000
);

// The drift canary: production parsing is lenient, but the live tier runs the
// real CLI's fresh output through strict mode so an upstream format change
// (renamed event, new type, moved field) throws instead of silently emitting
// empty text. Asserts shape, never content — LLM output is non-deterministic.
live(
  "live: real output parses clean under strict mode",
  async () => {
    const adapter = cursor();
    const inv = adapter.buildInvocation(PROMPT, { readOnly: true });
    const source = spawnAndStream(inv);
    let sawText = false;
    let finalText: string | undefined;
    const stream = adapter.parse(source, { strict: true });
    for await (const ev of stream) {
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

// Discovery is free: no model call is ever made for auth or listing.
live(
  "live: authStatus and models answer without a paid run",
  async () => {
    const agent = create(cursor());
    const status = await agent.authStatus();
    expect(["authenticated", "unauthenticated", "unknown"]).toContain(
      status.state
    );
    const models = await agent.models();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(typeof m.id).toBe("string");
    }
  },
  30_000
);
