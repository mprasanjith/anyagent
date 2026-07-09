import { expect, test } from "bun:test";

import {
  resolvePermission,
  validateOptions,
} from "../src/internal/capabilities.js";
import type { Adapter, CapabilityTable } from "../src/internal/types.js";

const full: CapabilityTable = {
  cwd: true,
  mcp: true,
  modelSelection: true,
  permissionLevels: ["read", "edit", "auto"],
  sessionResume: true,
  streaming: true,
  structuredOutput: true,
  systemPrompt: true,
};

const adapterWith = (caps: CapabilityTable, id = "demo"): Adapter =>
  ({
    capabilities: caps,
    meta: { bin: [id], id, name: id },
  }) as Adapter;

const fullAdapter = adapterWith(full);
const limited = adapterWith(
  {
    ...full,
    modelSelection: false,
    permissionLevels: ["edit", "auto"],
    sessionResume: false,
  },
  "opencode"
);

test("default permission is edit", () => {
  expect(resolvePermission({})).toBe("edit");
  expect(resolvePermission({ permission: "auto" })).toBe("auto");
});

test("validateOptions accepts a request the adapter fully supports", () => {
  expect(() =>
    validateOptions(fullAdapter, {
      model: "x",
      permission: "read",
      resume: "s",
    })
  ).not.toThrow();
});

test("unsupported model selection throws UnsupportedCapability naming the adapter", () => {
  expect(() => validateOptions(limited, { model: "x" })).toThrow(
    expect.objectContaining({
      code: "UnsupportedCapability",
      message: expect.stringContaining("opencode"),
    })
  );
});

test("throws when requesting a permission level not offered", () => {
  expect(() => validateOptions(limited, { permission: "read" })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});

const bare = adapterWith(
  {
    cwd: false,
    mcp: false,
    modelSelection: false,
    permissionLevels: ["edit"],
    sessionResume: false,
    streaming: true,
    structuredOutput: false,
    systemPrompt: false,
  },
  "bare"
);

const rejects = [
  ["a system prompt", { systemPrompt: "s" }],
  ["session resume", { resume: "s" }],
  ["MCP config", { mcp: {} }],
  ["a working directory", { cwd: "/tmp" }],
] as const;

for (const [name, opts] of rejects) {
  test(`throws UnsupportedCapability for ${name}`, () => {
    expect(() => validateOptions(bare, opts)).toThrow(
      expect.objectContaining({
        code: "UnsupportedCapability",
        message: expect.stringContaining(name),
      })
    );
  });
}
