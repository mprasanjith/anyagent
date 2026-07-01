import { AnyAgentError } from "./errors.js";
import type { Adapter, PermissionLevel, RunOptions } from "./types.js";

export const DEFAULT_PERMISSION: PermissionLevel = "edit";

export const resolvePermission = (opts: RunOptions): PermissionLevel =>
  opts.permission ?? DEFAULT_PERMISSION;

const requireCap = (
  agent: string,
  requested: boolean,
  cap: boolean,
  name: string
): void => {
  if (requested && !cap) {
    throw new AnyAgentError(
      "UnsupportedCapability",
      `${agent} does not support ${name}`
    );
  }
};

export const validateOptions = (adapter: Adapter, opts: RunOptions): void => {
  const agent = adapter.meta.id;
  const caps = adapter.capabilities;
  requireCap(
    agent,
    opts.model !== undefined,
    caps.modelSelection,
    "model selection"
  );
  requireCap(
    agent,
    opts.systemPrompt !== undefined,
    caps.systemPrompt,
    "a system prompt"
  );
  requireCap(
    agent,
    opts.resume !== undefined,
    caps.sessionResume,
    "session resume"
  );
  requireCap(agent, opts.mcp !== undefined, caps.mcp, "MCP config");
  requireCap(agent, opts.cwd !== undefined, caps.cwd, "a working directory");

  const level = resolvePermission(opts);
  if (!caps.permissionLevels.includes(level)) {
    throw new AnyAgentError(
      "UnsupportedCapability",
      `${agent} does not support permission level "${level}" (offers: ${caps.permissionLevels.join(", ")})`
    );
  }
};
