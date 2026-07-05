export { AnyAgentError, type AnyAgentErrorCode } from "./internal/errors.js";
export { create } from "./internal/agent.js";
export { detect, type DetectOptions } from "./internal/registry.js";
export type {
  Adapter,
  AdapterMeta,
  Agent,
  AgentEvent,
  AgentId,
  CapabilityTable,
  DetectionSpec,
  DetectResult,
  Invocation,
  KnownAgents,
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
