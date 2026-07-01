export { AnyAgentError, type AnyAgentErrorCode } from "./internal/errors.js";
export { create, type CreateOptions } from "./internal/agent.js";
export { BUILTINS, detect, type DetectOptions } from "./internal/registry.js";
export type {
  Adapter,
  AdapterMeta,
  Agent,
  AgentEvent,
  CapabilityTable,
  DetectionSpec,
  DetectResult,
  Invocation,
  McpConfig,
  McpServer,
  OutputSource,
  PermissionLevel,
  RawHandle,
  RunOptions,
  RunResult,
  Usage,
  VersionProbe,
} from "./internal/types.js";
