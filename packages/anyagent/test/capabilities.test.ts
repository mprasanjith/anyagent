import { expect, test } from "bun:test";

import { validateOptions } from "../src/internal/capabilities.js";
import type { Adapter, Capabilities } from "../src/types.js";

const full: Capabilities = {
  attachments: false,
  authStatus: "native",
  cwd: "native",
  effort: "native",
  mcp: "native",
  modelListing: "native",
  modelSelection: "native",
  readOnly: "native",
  session: "emulated",
  sessionFork: false,
  streaming: "native",
  structuredOutput: "native",
  systemPrompt: "native",
};

const adapterWith = (caps: Capabilities, id = "demo"): Adapter =>
  ({
    capabilities: caps,
    meta: { bin: [id], id, name: id },
  }) as Adapter;

const fullAdapter = adapterWith(full);

const bare = adapterWith(
  {
    attachments: false,
    authStatus: false,
    cwd: false,
    effort: false,
    mcp: false,
    modelListing: false,
    modelSelection: false,
    readOnly: false,
    session: false,
    sessionFork: false,
    streaming: "native",
    structuredOutput: false,
    systemPrompt: false,
  },
  "bare"
);

test("accepts a request the adapter fully supports", () => {
  expect(() =>
    validateOptions(fullAdapter, {
      cwd: "/tmp",
      effort: "high",
      mcp: {},
      model: "x",
      readOnly: true,
      resume: "s",
      schema: {},
      systemPrompt: "s",
    })
  ).not.toThrow();
});

const gated = [
  ["model", { model: "x" }],
  ["systemPrompt", { systemPrompt: "s" }],
  ["resume", { resume: "s" }],
  ["mcp", { mcp: {} }],
  ["cwd", { cwd: "/tmp" }],
  ["schema", { schema: {} }],
  ["effort", { effort: "high" }],
] as const;

for (const [name, opts] of gated) {
  test(`${name} on a false capability throws UnsupportedCapability`, () => {
    expect(() => validateOptions(bare, opts)).toThrow(
      expect.objectContaining({ code: "UnsupportedCapability" })
    );
  });
}

test("an emulated capability admits its option like a native one", () => {
  const emulated = adapterWith({ ...bare.capabilities, effort: "emulated" });
  expect(() => validateOptions(emulated, { effort: "high" })).not.toThrow();
});

test("readOnly: true on a false capability throws UnsupportedCapability", () => {
  expect(() => validateOptions(bare, { readOnly: true })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});

test("readOnly: false or omitted never throws, even without the capability", () => {
  expect(() => validateOptions(bare, { readOnly: false })).not.toThrow();
  expect(() => validateOptions(bare, {})).not.toThrow();
});

const closed = adapterWith(
  { ...full, reasoningEfforts: ["low", "high"] },
  "closed"
);

test("effort outside a declared closed vocabulary throws UnsupportedCapability", () => {
  expect(() => validateOptions(closed, { effort: "medium" })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});

test("effort inside the closed vocabulary passes", () => {
  expect(() => validateOptions(closed, { effort: "low" })).not.toThrow();
});

test("an open vocabulary passes any effort through to the CLI", () => {
  expect(() =>
    validateOptions(fullAdapter, { effort: "provider-specific-name" })
  ).not.toThrow();
});
