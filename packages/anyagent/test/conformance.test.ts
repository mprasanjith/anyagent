import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { claudeCode } from "../src/claude-code.js";
import { cline } from "../src/cline.js";
import { codex } from "../src/codex.js";
import { runConformance } from "../src/conformance.js";
import { cursor } from "../src/cursor.js";
import { geminiCli } from "../src/gemini-cli.js";
import { goose } from "../src/goose.js";
import { kiloCode } from "../src/kilo-code.js";
import { opencode } from "../src/opencode.js";
import { pi } from "../src/pi.js";
import type { Adapter, RunResult } from "../src/types.js";
import { fakeClosedEffort, fakeStreaming, fakeText } from "./fake-adapter.js";

const read = (p: string) =>
  readFileSync(path.join(import.meta.dir, p), "utf-8");

const transcript = (id: string): Record<string, string> => ({
  recorded: read(`fixtures/acp/${id}.jsonl`),
});

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
  await runConformance(opencode(), {
    fixtures: fixturesFor("opencode"),
    transcripts: transcript("opencode"),
  });
});

test("cursor passes conformance", async () => {
  await runConformance(cursor(), {
    fixtures: {
      shell: read("fixtures/cursor/shell.jsonl"),
      simple: read("fixtures/cursor/simple.jsonl"),
      tools: read("fixtures/cursor/tools.jsonl"),
    },
    transcripts: transcript("cursor"),
  });
});

test("gemini-cli passes conformance", async () => {
  await runConformance(geminiCli(), {
    fixtures: {
      readonly: read("fixtures/gemini-cli/readonly.jsonl"),
      simple: read("fixtures/gemini-cli/simple.jsonl"),
      tools: read("fixtures/gemini-cli/tools.jsonl"),
    },
    transcripts: transcript("gemini-cli"),
  });
});

test("kilo-code passes conformance", async () => {
  await runConformance(kiloCode(), { fixtures: fixturesFor("kilo-code") });
});

test("pi passes conformance", async () => {
  await runConformance(pi(), { fixtures: fixturesFor("pi") });
});

test("goose passes conformance", async () => {
  await runConformance(goose(), {
    fixtures: fixturesFor("goose"),
    transcripts: transcript("goose"),
  });
});

test("cline passes conformance", async () => {
  await runConformance(cline(), {
    fixtures: fixturesFor("cline"),
    transcripts: transcript("cline"),
  });
});

const toyFixture = '{"t":"text","v":"Hi"}\n{"t":"end"}';

test("fakeStreaming passes conformance, session event included", async () => {
  await runConformance(fakeStreaming, {
    fixtures: {
      simple: toyFixture,
      withSession: `{"t":"session","v":"s1"}\n${toyFixture}`,
    },
  });
});

test("fakeText (non-streaming) passes conformance", async () => {
  await runConformance(fakeText, {
    fixtures: { simple: "plain answer" },
  });
});

test("fakeClosedEffort passes conformance, closed vocabulary included", async () => {
  await runConformance(fakeClosedEffort, {
    fixtures: { simple: toyFixture },
  });
});

// Negative cases: each liar differs from a passing adapter in exactly one
// respect, so the rejection proves the matching new assertion can fail.

test("conformance rejects two session events in one stream", async () => {
  await expect(
    runConformance(fakeStreaming, {
      fixtures: {
        twoSessions: `{"t":"session","v":"a"}\n{"t":"session","v":"a"}\n${toyFixture}`,
      },
    })
  ).rejects.toThrow();
});

test("conformance rejects a result.sessionId that contradicts the session event", async () => {
  const sessionLiar: Adapter = {
    ...fakeStreaming,
    async *parse(source) {
      await source.text();
      const result: RunResult = {
        events: [],
        raw: undefined,
        sessionId: "b",
        text: "",
      };
      yield { sessionId: "a", type: "session" };
      yield { result, type: "done" };
      return result;
    },
  };
  await expect(
    runConformance(sessionLiar, { fixtures: { simple: "" } })
  ).rejects.toThrow();
});

test("conformance rejects a transcript on an adapter with no ACP mode", async () => {
  await expect(
    runConformance(fakeStreaming, {
      fixtures: {},
      transcripts: transcript("opencode"),
    })
  ).rejects.toThrow();
});

test("conformance rejects a transcript whose recorded turn never completed", async () => {
  const refused = read("fixtures/acp/goose.jsonl").replace(
    '"stopReason":"end_turn"',
    '"stopReason":"refusal"'
  );
  await expect(
    runConformance(goose(), { fixtures: {}, transcripts: { refused } })
  ).rejects.toThrow();
});

test("conformance rejects a native systemPrompt on an ACP-mode adapter", async () => {
  const adapter = cursor();
  const liar: Adapter = {
    ...adapter,
    capabilities: { ...adapter.capabilities, systemPrompt: "native" },
  };
  await expect(
    runConformance(liar, { fixtures: {}, transcripts: transcript("cursor") })
  ).rejects.toThrow();
});

test("conformance rejects a declared authStatus capability without an implementation", async () => {
  const { authStatus: _drop, ...rest } = fakeStreaming;
  await expect(
    runConformance(rest, { fixtures: { simple: toyFixture } })
  ).rejects.toThrow();
});

test("conformance rejects a declared modelListing capability without an implementation", async () => {
  const { listModels: _drop, ...rest } = fakeStreaming;
  await expect(
    runConformance(rest, { fixtures: { simple: toyFixture } })
  ).rejects.toThrow();
});

test("conformance rejects reasoningEfforts declared without the effort capability", async () => {
  const liar: Adapter = {
    ...fakeClosedEffort,
    capabilities: { ...fakeClosedEffort.capabilities, effort: false },
  };
  await expect(
    runConformance(liar, { fixtures: { simple: toyFixture } })
  ).rejects.toThrow();
});

test("conformance rejects an empty closed effort vocabulary", async () => {
  const liar: Adapter = {
    ...fakeClosedEffort,
    capabilities: { ...fakeClosedEffort.capabilities, reasoningEfforts: [] },
  };
  await expect(
    runConformance(liar, { fixtures: { simple: toyFixture } })
  ).rejects.toThrow();
});
