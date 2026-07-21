import { expect, test } from "bun:test";

import { applyEmulations } from "../src/internal/emulate.js";
import type {
  Adapter,
  CapabilitySupport,
  CapabilityTable,
} from "../src/types.js";

const adapterWith = (
  systemPrompt: CapabilitySupport,
  structuredOutput: CapabilitySupport
): Adapter => {
  const caps: CapabilityTable = {
    cwd: "native",
    mcp: "native",
    modelSelection: "native",
    permissionLevels: ["edit"],
    sessionResume: "native",
    streaming: "native",
    structuredOutput,
    systemPrompt,
  };
  return { capabilities: caps } as Adapter;
};

test("emulated systemPrompt folds a preamble and strips the option", () => {
  const { opts, prompt } = applyEmulations(
    adapterWith("emulated", "native"),
    "do the thing",
    { systemPrompt: "be terse" }
  );
  expect(prompt).toBe(
    "<system-instructions>\nbe terse\n</system-instructions>\n\ndo the thing"
  );
  expect(opts.systemPrompt).toBeUndefined();
});

test("native systemPrompt passes through untouched", () => {
  const { opts, prompt } = applyEmulations(
    adapterWith("native", "native"),
    "do the thing",
    { systemPrompt: "be terse" }
  );
  expect(prompt).toBe("do the thing");
  expect(opts.systemPrompt).toBe("be terse");
});

test("emulated schema renders an appendix and strips the option", () => {
  const schema = { type: "object" };
  const { opts, prompt } = applyEmulations(
    adapterWith("native", "emulated"),
    "answer",
    { schema }
  );
  expect(prompt).toBe(
    `answer\n\nRespond with a single JSON value that matches this JSON Schema. Output only the JSON, with no prose and no code fences.\n\n<json-schema>\n${JSON.stringify(
      schema,
      null,
      2
    )}\n</json-schema>`
  );
  expect(opts.schema).toBeUndefined();
});

test("both emulations apply with the system preamble first, schema last", () => {
  const schema = { type: "string" };
  const { prompt } = applyEmulations(
    adapterWith("emulated", "emulated"),
    "answer",
    { schema, systemPrompt: "be terse" }
  );
  expect(prompt.indexOf("<system-instructions>")).toBe(0);
  expect(prompt).toContain("<system-instructions>\nbe terse");
  expect(prompt.indexOf("<system-instructions>")).toBeLessThan(
    prompt.indexOf("<json-schema>")
  );
  expect(prompt).toContain("answer");
});
