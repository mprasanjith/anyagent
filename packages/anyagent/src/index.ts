export { AnyAgentError, type AnyAgentErrorCode } from "./internal/errors.js";
export { create } from "./internal/agent.js";
export { ndjsonParser, type NdjsonSpec } from "./internal/ndjson.js";
export { detect, type DetectOptions } from "./internal/registry.js";
export type {
  Adapter,
  AdapterMeta,
  Agent,
  AgentEvent,
  AgentId,
  CapabilitySupport,
  CapabilityTable,
  Detection,
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
