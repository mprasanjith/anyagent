import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { cline } from "../src/cline.js";
import { create } from "../src/index.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("cline")));

const PROMPT = "Reply with exactly the word: pong";
// cline's ACP session inherits its stored model unless one is pinned, and the
// stored choice need not be one the signed-in provider serves, e.g.
// ANYAGENT_CLINE_MODEL=gpt-5.4-mini.
const MODEL = process.env.ANYAGENT_CLINE_MODEL;
const settings = MODEL ? { model: MODEL } : {};

// The drift canary: the endpoint's own handshake and config ids are recorded in
// test/fixtures/acp/cline.jsonl, so a live turn is what catches the recording
// going stale.
live(
  "live: cline answers a trivial prompt over its acp endpoint",
  async () => {
    const res = await create(cline()).run(PROMPT, settings);
    expect(res.text.toLowerCase()).toContain("pong");
    // ACP mode names every conversation, one-shot runs included.
    expect(typeof res.sessionId).toBe("string");
  },
  120_000
);

// What backs the readOnly capability: cline has no read-only mode of its own,
// so the guarantee is permission denial, and only a real mutating turn proves
// it holds.
live(
  "live: a read-only turn leaves the disk untouched",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "anyagent-cline-ro-"));
    await create(cline())
      .run(`Create a file named proof.txt containing the word pong in ${cwd}`, {
        ...settings,
        cwd,
        readOnly: true,
      })
      .catch(() => undefined);
    expect(existsSync(path.join(cwd, "proof.txt"))).toBe(false);
  },
  180_000
);
