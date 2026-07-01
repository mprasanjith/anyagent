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
  permissionLevels: ["read-only", "edit", "full-auto"],
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

const fullAgent = adapterWith(full);
const limited = adapterWith(
  {
    ...full,
    modelSelection: false,
    permissionLevels: ["edit", "full-auto"],
    sessionResume: false,
  },
  "opencode"
);

test("default permission is edit", () => {
  expect(resolvePermission({})).toBe("edit");
  expect(resolvePermission({ permission: "full-auto" })).toBe("full-auto");
});

test("passes when all requested caps supported", () => {
  expect(() =>
    validateOptions(fullAgent, {
      model: "x",
      permission: "read-only",
      resume: "s",
    })
  ).not.toThrow();
});

test("throws UnsupportedCapability naming the adapter", () => {
  expect(() => validateOptions(limited, { model: "x" })).toThrow(
    expect.objectContaining({
      code: "UnsupportedCapability",
      message: expect.stringContaining("opencode"),
    })
  );
});

test("throws when requesting a permission level not offered", () => {
  expect(() => validateOptions(limited, { permission: "read-only" })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});
