import { expect, test } from "bun:test";

import { geminiCli } from "../src/gemini-cli.js";
import { create } from "../src/index.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("gemini")));

const PROMPT = "Reply with exactly the word: pong";
// Always pin a model: Gemini's automatic routing can spend minutes
// self-investigating a trivial prompt. Flash-lite is the free tier's
// cheapest surviving alias.
const MODEL = process.env.ANYAGENT_GEMINI_MODEL ?? "gemini-3.5-flash-lite";

// The endpoint is spoken by the core's ACP client, so an upstream format
// change breaks the protocol, not an adapter parser: there is no strict-mode
// drift canary to run here.
live(
  "live: gemini answers a trivial prompt",
  async () => {
    const agent = create(geminiCli());
    const res = await agent.run(PROMPT, { model: MODEL, readOnly: true });
    expect(res.text.toLowerCase()).toContain("pong");
    // The session id the endpoint opened must reach the result.
    expect(typeof res.sessionId).toBe("string");
  },
  180_000
);

// readOnly is the core denying every mutating tool the endpoint asks about,
// so this guards the permission path end to end against the real CLI.
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
