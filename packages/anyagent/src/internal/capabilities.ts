import { AnyAgentError } from "../errors.js";
import type { Adapter, Capabilities, RunOptions } from "../types.js";

type GuardedCap = keyof Pick<
  Capabilities,
  | "attachments"
  | "cwd"
  | "effort"
  | "mcp"
  | "modelSelection"
  | "session"
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
  ["resume", "session", "session resume"],
  ["mcp", "mcp", "MCP config"],
  ["cwd", "cwd", "a working directory"],
  ["schema", "structuredOutput", "structured output"],
  ["effort", "effort", "reasoning effort"],
  ["attachments", "attachments", "file attachments"],
];

// Throw `AnyAgentError` (`code: "UnsupportedCapability"`) when `opts` asks
// for anything the adapter's declared capabilities do not include, and
// `code: "InvalidOptions"` for a dependent option missing its prerequisite.
// Runs before any process spawns, so a wrong assumption fails fast.
export const validateOptions = (adapter: Adapter, opts: RunOptions): void => {
  const agent = adapter.meta.id;
  const caps = adapter.capabilities;

  // Dependent-option rule first: this call could never be valid on any
  // agent, so the error is InvalidOptions, not a capability gap.
  if (opts.forkSession && opts.resume === undefined) {
    throw new AnyAgentError(
      "InvalidOptions",
      "forkSession requires resume: only an existing conversation can branch"
    );
  }
  if (opts.schemaRetries !== undefined && opts.schema === undefined) {
    throw new AnyAgentError(
      "InvalidOptions",
      "schemaRetries requires schema: there is nothing to correct against without one"
    );
  }

  for (const [option, cap, label] of GUARDED_OPTIONS) {
    if (opts[option] !== undefined && !caps[cap]) {
      throw new AnyAgentError(
        "UnsupportedCapability",
        `${agent} does not support ${label}`
      );
    }
  }

  // `readOnly: false` and `forkSession: false` are the defaults spelled out,
  // so only `true` is gated.
  if (opts.readOnly && !caps.readOnly) {
    throw new AnyAgentError(
      "UnsupportedCapability",
      `${agent} cannot guarantee a read-only run`
    );
  }
  if (opts.forkSession && !caps.sessionFork) {
    throw new AnyAgentError(
      "UnsupportedCapability",
      `${agent} cannot fork a session`
    );
  }

  if (
    opts.effort !== undefined &&
    caps.reasoningEfforts &&
    !caps.reasoningEfforts.includes(opts.effort)
  ) {
    throw new AnyAgentError(
      "UnsupportedCapability",
      `${agent} does not accept effort "${opts.effort}" (accepts: ${caps.reasoningEfforts.join(", ")})`
    );
  }
};
