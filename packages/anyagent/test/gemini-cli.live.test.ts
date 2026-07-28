import { expect, test } from "bun:test";

import { geminiCli } from "../src/gemini-cli.js";
import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("gemini")));

const PROMPT = "Reply with exactly the word: pong";
// Always pin a model: Gemini's automatic routing can spend minutes
// self-investigating a trivial prompt. Flash-lite is the free tier's
// cheapest surviving alias.
const MODEL = process.env.ANYAGENT_GEMINI_MODEL ?? "gemini-3.5-flash-lite";

live(
  "live: gemini answers a trivial prompt",
  async () => {
    const agent = create(geminiCli());
    const res = await agent.run(PROMPT, { model: MODEL, readOnly: true });
    expect(res.text.toLowerCase()).toContain("pong");
    // Real-output check: stats from the terminal result event.
    expect(typeof res.usage?.outputTokens).toBe("number");
    expect(typeof res.usage?.cacheReadTokens).toBe("number");
    // The session id must be reachable for resume.
    expect(typeof res.sessionId).toBe("string");
  },
  180_000
);

// The drift canary: production parsing is lenient, but the live tests run the
// real CLI's fresh output through strict mode so an upstream format change
// throws instead of silently emitting empty text.
live(
  "live: real output parses clean under strict mode",
  async () => {
    const adapter = geminiCli();
    const inv = adapter.buildInvocation(PROMPT, {
      model: MODEL,
      readOnly: true,
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
  180_000
);

// The readOnly guarantee is structural: the default approval mode registers
// no write or shell tools headless, so a requested mutation cannot happen.
// This guards against upstream re-registering them (which would also revive
// the plan-mode escape this adapter avoids).
live(
  "live: readOnly leaves no file behind on a write request",
  async () => {
    const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/anyagent-gemini-ro-`);
    try {
      const agent = create(geminiCli());
      await agent.run(
        "Create a file named out.txt containing the word done. Do not ask for confirmation.",
        { cwd: dir, model: MODEL, readOnly: true }
      );
      expect(existsSync(`${dir}/out.txt`)).toBe(false);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  },
  180_000
);
