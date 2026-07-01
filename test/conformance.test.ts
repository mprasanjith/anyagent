import { test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { claudeCode } from "../src/claude-code/index.js";
import { runConformance } from "../src/internal/conformance/suite.js";
import { fakeStreaming, fakeText } from "./fake-adapter.js";

const read = (p: string) =>
  readFileSync(path.join(import.meta.dir, p), "utf-8");

test("claude-code passes conformance", async () => {
  await runConformance(claudeCode(), {
    fixtures: { simple: read("fixtures/claude-code/simple.jsonl") },
  });
});

test("fakeStreaming passes conformance", async () => {
  await runConformance(fakeStreaming, {
    fixtures: { simple: '{"t":"text","v":"Hi"}\n{"t":"end"}' },
  });
});

test("fakeText (non-streaming) passes conformance", async () => {
  await runConformance(fakeText, {
    fixtures: { simple: "plain answer" },
  });
});
