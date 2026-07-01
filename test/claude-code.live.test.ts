import { expect, test } from "bun:test";

import { claudeCode } from "../src/claude-code/index.js";
import { create } from "../src/index.js";
import { liveEnabled } from "./live-helper.js";

test("live: claude answers a trivial prompt", async () => {
  if (!(await liveEnabled("claude"))) {
    // biome-ignore lint/suspicious/noConsole: test skip notice.
    console.warn("skipping live test (set ANYAGENT_LIVE=1)");
    return;
  }
  const agent = create(claudeCode());
  const res = await agent.run("Reply with exactly the word: pong", {
    permission: "read-only",
  });
  expect(res.text.toLowerCase()).toContain("pong");
  expect(res.exitCode).toBe(0);
  // Real-output check: the parser extracted usage from the result event.
  expect(typeof res.usage?.outputTokens).toBe("number");
}, 60_000);
