import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { cursor } from "../src/cursor.js";
import { create } from "../src/index.js";
import { liveEnabled } from "./live-helper.js";

const live = test.skipIf(!(await liveEnabled("agent")));

const PROMPT = "Reply with exactly the word: pong";

live(
  "live: cursor answers a trivial prompt",
  async () => {
    const agent = create(cursor());
    const res = await agent.run(PROMPT, { readOnly: true });
    expect(res.text.toLowerCase()).toContain("pong");
    // The chat id must be reachable for resume.
    expect(typeof res.sessionId).toBe("string");
  },
  120_000
);

// The drift canary: the endpoint's config options are the adapter's whole
// mapping, and a renamed id silently stops applying. A live turn that asks for
// a file under `readOnly` proves `mode: plan` still reaches the real CLI and
// still refuses writes. Asserts shape, never content — LLM output is
// non-deterministic.
live(
  "live: an ACP session still maps readOnly onto enforced plan mode",
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "anyagent-cursor-"));
    const session = create(cursor()).session({ cwd: dir });
    try {
      let sawText = false;
      const run = session.run(
        "Create a file named canary.txt containing the word hi",
        { readOnly: true }
      );
      for await (const ev of run) {
        if (ev.type === "text-delta") {
          sawText = true;
        }
      }
      const res = await run;
      expect(sawText).toBe(true);
      expect(typeof res.text).toBe("string");
      expect(typeof session.id).toBe("string");
      expect(existsSync(path.join(dir, "canary.txt"))).toBe(false);
    } finally {
      await session.close();
      rmSync(dir, { force: true, recursive: true });
    }
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
