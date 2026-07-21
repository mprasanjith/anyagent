import { AnyAgentError } from "../errors.js";
import type {
  Adapter,
  CapabilityTable,
  PermissionLevel,
  RunOptions,
} from "../types.js";

const DEFAULT_PERMISSION: PermissionLevel = "edit";

export const resolvePermission = (opts: RunOptions): PermissionLevel =>
  opts.permission ?? DEFAULT_PERMISSION;

type GuardedCap = keyof Pick<
  CapabilityTable,
  | "cwd"
  | "mcp"
  | "modelSelection"
  | "sessionResume"
  | "structuredOutput"
  | "systemPrompt"
>;

const GUARDED_OPTIONS: readonly (readonly [
  keyof RunOptions,
  GuardedCap,
  string,
])[] = [
  ["model", "modelSelection", "model selection"],
  ["systemPrompt", "systemPrompt", "a system prompt"],
  ["resume", "sessionResume", "session resume"],
  ["mcp", "mcp", "MCP config"],
  ["cwd", "cwd", "a working directory"],
  ["schema", "structuredOutput", "structured output"],
];

// Throw `AnyAgentError` (`code: "UnsupportedCapability"`) when `opts` asks
// for anything the adapter's capability table does not declare. Runs before
// any process spawns, so a wrong assumption fails fast.
export const validateOptions = (adapter: Adapter, opts: RunOptions): void => {
  const agent = adapter.meta.id;
  const caps = adapter.capabilities;
  for (const [option, cap, label] of GUARDED_OPTIONS) {
    if (opts[option] !== undefined && !caps[cap]) {
      throw new AnyAgentError(
        "UnsupportedCapability",
        `${agent} does not support ${label}`
      );
    }
  }

  const level = resolvePermission(opts);
  if (!caps.permissionLevels.includes(level)) {
    throw new AnyAgentError(
      "UnsupportedCapability",
      `${agent} does not support permission level "${level}" (offers: ${caps.permissionLevels.join(", ")})`
    );
  }
};
