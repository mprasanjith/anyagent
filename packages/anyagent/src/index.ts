export { AnyAgentError, type AnyAgentErrorCode } from "./errors.js";
export { create } from "./internal/agent.js";
export { ndjsonParser, type NdjsonSpec } from "./ndjson.js";
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
} from "./types.js";
