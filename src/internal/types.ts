import type { ChildProcess } from "node:child_process";

export type PermissionLevel = "read-only" | "edit" | "full-auto";

export interface CapabilityTable {
  streaming: boolean;
  permissionLevels: PermissionLevel[];
  structuredOutput: boolean;
  modelSelection: boolean;
  sessionResume: boolean;
  mcp: boolean;
  systemPrompt: boolean;
  cwd: boolean;
}

export interface Usage {
  /**
   * Uncached input tokens, matching the underlying provider's accounting (e.g.
   * Anthropic reports cache reads/writes as separate line items, not folded in
   * here). For exact cost, read the native payload on the event/result `raw`.
   */
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface McpServer {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}
export type McpConfig = Record<string, McpServer>;

export interface RunOptions {
  cwd?: string;
  model?: string;
  permission?: PermissionLevel;
  systemPrompt?: string;
  resume?: string;
  mcp?: McpConfig;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /**
   * Escape hatch: extra native CLI flags appended verbatim to the argv, so you
   * can reach a harness capability the unified surface does not model while
   * keeping normalized events. Adapter-specific — the caller owns correctness.
   *
   * These bypass capability validation and the permission mapping: a flag here
   * can override what `permission` set. Prefer the typed options; reach for this
   * only when nothing else exposes the flag you need.
   */
  extraArgs?: string[];
}

export type AgentEvent =
  | { type: "text-delta"; text: string; raw?: unknown }
  | { type: "tool-call"; name: string; input: unknown; raw?: unknown }
  | { type: "tool-result"; name: string; output: unknown; raw?: unknown }
  | { type: "usage"; usage: Usage; raw?: unknown }
  | { type: "done"; result: RunResult };

export interface RunResult {
  text: string;
  events: AgentEvent[];
  usage?: Usage;
  exitCode: number;
  raw: unknown;
}

export interface Invocation {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  input?: string;
}

/**
 * The process output an adapter's `parse` reads. Consume EITHER `lines()`
 * (NDJSON adapters) OR `text()` (plain-text adapters), never both — the
 * underlying stdout stream is read once.
 */
export interface OutputSource {
  lines: () => AsyncIterable<string>;
  text: () => Promise<string>;
  stderr: () => Promise<string>;
  exitCode: Promise<number>;
}

export interface VersionProbe {
  which: (bin: string) => Promise<string | null>;
  exec: (
    bin: string,
    args: string[]
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface DetectionSpec {
  versionCommand?: string[];
  versionRegex?: RegExp;
}

export interface AdapterMeta {
  id: string;
  name: string;
  bin: string[];
}

export interface DetectResult {
  adapter: Adapter;
  id: string;
  name: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  capabilities: CapabilityTable;
}

export interface Adapter {
  meta: AdapterMeta;
  detection: DetectionSpec;
  capabilities: CapabilityTable;
  detect?: (probe: VersionProbe) => Promise<DetectResult>;
  buildInvocation: (prompt: string, opts: RunOptions) => Invocation;
  parse: (
    source: OutputSource,
    opts: { strict: boolean }
  ) => AsyncGenerator<AgentEvent, RunResult>;
}

export interface RawHandle {
  buildInvocation: (prompt: string, opts?: RunOptions) => Invocation;
  spawn: (prompt: string, opts?: RunOptions) => ChildProcess;
}

export interface Agent {
  readonly adapter: Adapter;
  readonly capabilities: CapabilityTable;
  run: (prompt: string, opts?: RunOptions) => Promise<RunResult>;
  runStream: (
    prompt: string,
    opts?: RunOptions
  ) => AsyncGenerator<AgentEvent, RunResult>;
  readonly raw: RawHandle;
}
