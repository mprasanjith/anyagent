import { test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { claudeCode } from "../src/claude-code.js";
import { cline } from "../src/cline.js";
import { codex } from "../src/codex.js";
import { goose } from "../src/goose.js";
import { runConformance } from "../src/internal/conformance/suite.js";
import { kiloCode } from "../src/kilo-code.js";
import { opencode } from "../src/opencode.js";
import { pi } from "../src/pi.js";
import { fakeStreaming, fakeText } from "./fake-adapter.js";

const read = (p: string) =>
  readFileSync(path.join(import.meta.dir, p), "utf-8");

test("claude-code passes conformance", async () => {
  await runConformance(claudeCode(), {
    fixtures: { simple: read("fixtures/claude-code/simple.jsonl") },
  });
});

test("codex passes conformance", async () => {
  await runConformance(codex(), {
    fixtures: {
      edit: read("fixtures/codex/edit.jsonl"),
      simple: read("fixtures/codex/simple.jsonl"),
      tools: read("fixtures/codex/tools.jsonl"),
    },
  });
});

const SCENARIOS = ["edit", "simple", "tools"] as const;

const fixturesFor = (id: string): Record<string, string> =>
  Object.fromEntries(
    SCENARIOS.map((s) => [s, read(`fixtures/${id}/${s}.jsonl`)])
  );

test("opencode passes conformance", async () => {
  await runConformance(opencode(), { fixtures: fixturesFor("opencode") });
});

test("kilo-code passes conformance", async () => {
  await runConformance(kiloCode(), { fixtures: fixturesFor("kilo-code") });
});

test("pi passes conformance", async () => {
  await runConformance(pi(), { fixtures: fixturesFor("pi") });
});

test("goose passes conformance", async () => {
  await runConformance(goose(), { fixtures: fixturesFor("goose") });
});

test("cline passes conformance", async () => {
  await runConformance(cline(), { fixtures: fixturesFor("cline") });
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
