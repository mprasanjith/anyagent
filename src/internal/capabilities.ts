import { AnyAgentError } from "./errors.js";
import type { CapabilityTable, PermissionLevel, RunOptions } from "./types.js";

export const DEFAULT_PERMISSION: PermissionLevel = "edit";

export const resolvePermission = (opts: RunOptions): PermissionLevel =>
  opts.permission ?? DEFAULT_PERMISSION;

const requireCap = (requested: boolean, cap: boolean, name: string): void => {
  if (requested && !cap) {
    throw new AnyAgentError(
      "UnsupportedCapability",
      `adapter does not support ${name}`
    );
  }
};

export const validateOptions = (
  caps: CapabilityTable,
  opts: RunOptions
): void => {
  requireCap(opts.model !== undefined, caps.modelSelection, "model selection");
  requireCap(
    opts.systemPrompt !== undefined,
    caps.systemPrompt,
    "system prompt"
  );
  requireCap(opts.resume !== undefined, caps.sessionResume, "session resume");
  requireCap(opts.mcp !== undefined, caps.mcp, "MCP config");
  requireCap(opts.cwd !== undefined, caps.cwd, "working directory");

  const level = resolvePermission(opts);
  if (!caps.permissionLevels.includes(level)) {
    throw new AnyAgentError(
      "UnsupportedCapability",
      `adapter does not support permission level "${level}" (offers: ${caps.permissionLevels.join(", ")})`
    );
  }
};
