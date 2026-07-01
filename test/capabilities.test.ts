import { expect, test } from "bun:test";

import {
  resolvePermission,
  validateOptions,
} from "../src/internal/capabilities.js";
import type { CapabilityTable } from "../src/internal/types.js";

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
const limited: CapabilityTable = {
  ...full,
  modelSelection: false,
  permissionLevels: ["edit", "full-auto"],
  sessionResume: false,
};

test("default permission is edit", () => {
  expect(resolvePermission({})).toBe("edit");
  expect(resolvePermission({ permission: "full-auto" })).toBe("full-auto");
});

test("passes when all requested caps supported", () => {
  expect(() =>
    validateOptions(full, { model: "x", permission: "read-only", resume: "s" })
  ).not.toThrow();
});

test("throws UnsupportedCapability for unsupported model", () => {
  expect(() => validateOptions(limited, { model: "x" })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});

test("throws when requesting a permission level not offered", () => {
  expect(() => validateOptions(limited, { permission: "read-only" })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});
