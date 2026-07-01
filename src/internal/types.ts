import type { ChildProcess } from "node:child_process";

export type PermissionLevel = "read-only" | "edit" | "full-auto";

export interface CapabilityTable {
  /**
   * Informational (feature detection), never validated against a request:
   * `true` means `runStream` relays the harness's native event stream;
   * `false` means the CLI emits plain text or a single final object, and
   * `parse` synthesizes one `text-delta` followed by `done`.
   */
  streaming: boolean;
  permissionLevels: PermissionLevel[];
  /**
   * Informational (feature detection), never validated against a request:
   * the harness can emit schema-constrained output, but the unified surface
   * does not model it — reach it via `extraArgs` or `agent.raw`.
   */
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

/**
 * A normalized run event. `text-delta` granularity is adapter-dependent — one
 * delta may be a token, a chunk, or a whole assistant message (claude-code
 * emits whole messages). The guaranteed invariant, enforced by the conformance
 * suite: concatenating every delta's `text` equals the final `RunResult.text`.
 */
export type AgentEvent =
  | { type: "text-delta"; text: string; raw?: unknown }
  | { type: "tool-call"; name: string; input: unknown; raw?: unknown }
  | { type: "tool-result"; name: string; output: unknown; raw?: unknown }
  | { type: "usage"; usage: Usage; raw?: unknown }
  | { type: "done"; result: RunResult };

export interface RunResult {
  text: string;
  /**
   * Every normalized event the run produced (the terminal `done` excluded),
   * buffered in full — unbounded for very long agentic runs; stream via
   * `runStream` when that matters.
   */
  events: AgentEvent[];
  usage?: Usage;
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
  /**
   * Resolves with the stderr captured so far — complete only once `exitCode`
   * has settled.
   */
  stderr: () => Promise<string>;
  exitCode: Promise<number>;
  /**
   * Terminate the underlying process. The core calls this when a consumer
   * abandons a stream early, so a half-read agent isn't left running. A no-op
   * once the process has already exited.
   */
  close?: () => void;
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
