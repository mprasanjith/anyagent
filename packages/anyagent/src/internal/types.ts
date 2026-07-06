import type { ChildProcess } from "node:child_process";

/**
 * How much autonomy the agent gets over your working directory:
 *
 * - `"read"` — the agent can inspect files and answer, but not change
 *   anything.
 * - `"edit"` (the default) — the agent can create and modify files, while its
 *   CLI's own guardrails still apply to riskier actions like shell commands.
 * - `"auto"` — every permission prompt is auto-approved and the agent runs
 *   unattended. Use with care.
 *
 * These three levels are the whole surface; the enum never widens. Each
 * adapter maps your chosen level onto its CLI's native flags (Claude Code's
 * `--permission-mode`, for example). If a CLI cannot honor the level you ask
 * for, the run throws `AnyAgentError` with `code: "UnsupportedCapability"`
 * rather than silently downgrading — check
 * `agent.capabilities.permissionLevels` to see what an agent offers. CLIs
 * with finer-grained native levels expose them only through
 * {@link RunOptions.extraArgs} or {@link RawHandle}.
 */
export type PermissionLevel = "read" | "edit" | "auto";

/**
 * What one agent CLI can do. Read it from {@link Agent.capabilities} (or a
 * {@link DetectResult}) to find out what you can ask for before you ask:
 *
 * ```ts
 * const opts = agent.capabilities.modelSelection ? { model: "opus" } : {};
 * const result = await agent.run(prompt, opts);
 * ```
 *
 * Most fields guard the matching {@link RunOptions} field — requesting an
 * option the table does not declare throws `AnyAgentError`
 * (`code: "UnsupportedCapability"`) before anything spawns. The two
 * exceptions, `streaming` and `structuredOutput`, are purely informational;
 * see their docs.
 */
export interface CapabilityTable {
  /**
   * Whether the agent streams its work as it goes. When `true`, `runStream`
   * relays the agent's own live events. When `false`, the CLI only prints a
   * final answer, so you get it all at once — one `text-delta` with the whole
   * reply, then `done`. Either way `runStream` works; this just tells you
   * whether to expect progressive output.
   */
  streaming: boolean;
  /**
   * The {@link PermissionLevel}s this agent supports. Asking for one that
   * isn't listed fails fast, rather than quietly giving the agent more or less
   * freedom than you asked for.
   */
  permissionLevels: PermissionLevel[];
  /**
   * Whether the agent can return output shaped to a schema. AnyAgent doesn't
   * model this yet, so it's informational: to use it, pass the CLI's own flag
   * via {@link RunOptions.extraArgs} or drive the process through
   * {@link RawHandle}.
   */
  structuredOutput: boolean;
  /** Whether you can pick the model for a run. See {@link RunOptions.model}. */
  modelSelection: boolean;
  /**
   * Whether the agent can pick up an earlier conversation. See
   * {@link RunOptions.resume}.
   */
  sessionResume: boolean;
  /** Whether you can attach MCP servers to a run. See {@link RunOptions.mcp}. */
  mcp: boolean;
  /**
   * Whether you can add to the agent's system prompt. See
   * {@link RunOptions.systemPrompt}.
   */
  systemPrompt: boolean;
  /**
   * Whether you can choose the directory the agent works in. See
   * {@link RunOptions.cwd}.
   */
  cwd: boolean;
}

/**
 * Token and cost accounting for a run, normalized across harnesses. Every
 * field is optional because each CLI reports a different subset — check for
 * `undefined` rather than assuming a field is present. The harness's exact
 * native accounting is always available on the event's or result's `raw`.
 */
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

/**
 * One MCP (Model Context Protocol) server to make available to the agent
 * during a run. Set `command`, `args`, and optionally `env` for a local stdio
 * server, or `url` for a remote one. The adapter translates this into
 * whatever config format its CLI expects.
 */
export interface McpServer {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

/**
 * The MCP servers for a run, keyed by the name the agent will see them under:
 *
 * ```ts
 * await agent.run(prompt, {
 *   mcp: { db: { args: ["my-mcp-server"], command: "npx" } },
 * });
 * ```
 */
export type McpConfig = Record<string, McpServer>;

/**
 * Everything you can tune about a single run; all fields are optional. Each
 * option is validated against the adapter's {@link CapabilityTable} up front,
 * so asking for something this agent's CLI cannot do (say, `resume` on a
 * harness without sessions) throws `AnyAgentError`
 * (`code: "UnsupportedCapability"`) before any process spawns — a wrong
 * assumption fails fast instead of mid-run.
 */
export interface RunOptions {
  /** Directory the agent works in. Defaults to the current process's cwd. */
  cwd?: string;
  /** Model name in the CLI's own vocabulary (e.g. `"opus"` for claude-code). */
  model?: string;
  /** How much autonomy the agent gets. Defaults to `"edit"`. */
  permission?: PermissionLevel;
  /** Appended to (not replacing) the CLI's own system prompt. */
  systemPrompt?: string;
  /** A session id from a previous run, to continue that conversation. */
  resume?: string;
  /** MCP servers to attach for this run. */
  mcp?: McpConfig;
  /** Aborting terminates the process; the run throws `code: "Aborted"`. */
  signal?: AbortSignal;
  /** Extra environment variables, merged over the parent's environment. */
  env?: Record<string, string>;
  /**
   * Escape hatch: extra native CLI flags appended verbatim to the argv, so you
   * can reach a harness capability the unified surface does not model while
   * keeping normalized events. Adapter-specific — the caller owns correctness.
   *
   * These flags are never validated and are appended after the flags the
   * adapter builds, so one here can override what `permission` set. Prefer
   * the typed options; reach for this only when nothing else exposes the
   * flag you need.
   */
  extraArgs?: string[];
}

/**
 * One normalized event from a running agent, as yielded by
 * {@link Agent.runStream}:
 *
 * - `text-delta` — a piece of the agent's answer text.
 * - `tool-call` / `tool-result` — the agent invoked a tool and got its result.
 * - `usage` — token/cost accounting became available.
 * - `done` — the run finished; carries the final {@link RunResult}.
 *
 * How much text one `text-delta` carries depends on the harness: a token, a
 * chunk, or a whole assistant message (claude-code emits whole messages).
 * What you can rely on — enforced by the conformance suite — is that
 * concatenating every delta's `text` reproduces `RunResult.text` exactly.
 * `raw` on each event except `done` is the harness's untouched native
 * payload for it.
 */
export type AgentEvent =
  | { type: "text-delta"; text: string; raw?: unknown }
  | { type: "tool-call"; name: string; input: unknown; raw?: unknown }
  | { type: "tool-result"; name: string; output: unknown; raw?: unknown }
  | { type: "usage"; usage: Usage; raw?: unknown }
  | { type: "done"; result: RunResult };

/**
 * What a finished run gives you back. Holding a `RunResult` means the run
 * succeeded — the CLI exited cleanly and reported no agent-level error; every
 * failure path throws `AnyAgentError` instead, so you never inspect a result
 * to learn whether it worked.
 *
 * `text` is the agent's final answer with all text output concatenated. `raw`
 * is the harness's own final payload, untouched, for anything the normalized
 * fields leave out (exact cache accounting, session ids, …).
 */
export interface RunResult {
  text: string;
  /**
   * Every normalized event the run produced, in order (the terminal `done` is
   * excluded). The whole list is held in memory, so for very long agentic
   * runs prefer consuming {@link Agent.runStream} as events arrive.
   */
  events: AgentEvent[];
  usage?: Usage;
  raw: unknown;
}

/**
 * A fully-resolved command line: what an adapter's `buildInvocation` returns
 * and what the core (or you, via {@link RawHandle}) spawns. `env` is merged
 * over the parent process's environment rather than replacing it. `input`,
 * when present, is written to the child's stdin, which is then closed — this
 * is how prompts reach CLIs that read them from a pipe.
 */
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

/**
 * The two I/O operations detection needs: `which` resolves a binary name to
 * its path on `PATH` (or `null` when absent), and `exec` runs a binary and
 * captures its output. `detect()` uses a real implementation by default;
 * tests pass a fake via `detect({ probe })` to simulate any machine without
 * spawning processes.
 */
export interface VersionProbe {
  which: (bin: string) => Promise<string | null>;
  exec: (
    bin: string,
    args: string[]
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
}

/**
 * How detection reads a CLI's version once its binary is found: run
 * `versionCommand` (default `["--version"]`) and take the first match of
 * `versionRegex` (default: the first `x.y.z` triple) from whatever it prints.
 * An adapter only sets these when its CLI deviates from those defaults.
 */
export interface DetectionSpec {
  versionCommand?: string[];
  versionRegex?: RegExp;
}

/**
 * The ids of the agents AnyAgent ships with, as a lookup whose keys feed
 * {@link AgentId}. A third-party adapter can teach the id type about its own
 * agent by adding to this interface through module augmentation:
 *
 * ```ts
 * declare module "anyagent" {
 *   interface KnownAgents {
 *     "my-cli": true;
 *   }
 * }
 * ```
 */
export interface KnownAgents {
  "claude-code": true;
  cline: true;
  codex: true;
  goose: true;
  "kilo-code": true;
  opencode: true;
  pi: true;
}

/**
 * The id of a coding agent. The built-in ids (`keyof {@link KnownAgents}`)
 * autocomplete, but any string is accepted, so custom adapters fit too — an
 * `AgentId` is still just a `string` you can store or compare freely.
 */
export type AgentId = keyof KnownAgents | (string & Record<never, never>);

/**
 * How an adapter identifies itself: `id` is the stable machine name
 * (`"claude-code"`), `name` the human-readable one (`"Claude Code"`), and
 * `bin` the executable names to look for on `PATH` in priority order — the
 * first one found wins, even if a later one also exists.
 */
export interface AdapterMeta {
  id: AgentId;
  name: string;
  bin: string[];
}

/**
 * One coding agent found on the machine and ready to run. `detect()` gives you
 * one of these for each installed agent; hand it straight to `create()` to get
 * a runnable {@link Agent}.
 */
export interface DetectResult {
  /**
   * The stable id of the agent tool, e.g. `"claude-code"`. Use this
   * to programmatically identify a specific agent tool.
   */
  id: AgentId;
  /** The human-readable agent tool name, e.g. `"Claude Code"`. */
  name: string;
  /**
   * The installed version, e.g. `"2.0.31"`, or `null` when the agent doesn't
   * report one.
   */
  version: string | null;
  /** The full path to the agent's program on disk. */
  path: string;
  /** What this agent can and can't do, so you can tailor a run to it. */
  capabilities: CapabilityTable;
  /**
   * The adapter that knows how to drive this agent. `create()` uses it; you
   * won't normally reach for it yourself.
   */
  adapter: Adapter;
}

/**
 * The raw result of checking for one agent, produced by built-in detection or
 * a custom {@link Adapter.detect}. Unlike {@link DetectResult} it also covers
 * the not-found case — that's why `path` can be `null`: when the agent's
 * program isn't on `PATH`, `installed` is `false` and `path` is `null`.
 * `detect()` drops those and hands you only {@link DetectResult}s, so you
 * won't meet this type unless you're writing an adapter.
 */
export interface Detection {
  /** Whether the agent's program was found on the user's `PATH`. */
  installed: boolean;
  /** The full path to the program on disk, or `null` when it wasn't found. */
  path: string | null;
  /** A short, stable id for the agent, e.g. `"claude-code"`. */
  id: AgentId;
  /** The agent's display name, e.g. `"Claude Code"`. */
  name: string;
  /** The installed version, or `null` when none was reported. */
  version: string | null;
  /** What this agent can and can't do. */
  capabilities: CapabilityTable;
  /** The adapter that knows how to drive this agent. */
  adapter: Adapter;
}

/**
 * The contract for supporting one agent CLI. An adapter is data plus pure
 * functions: it describes how to invoke its CLI and how to read its output,
 * while the core does all actual I/O (spawning, stream handling, validation,
 * lifecycle). That split keeps adapters testable offline against recorded
 * fixtures, with zero subprocesses.
 *
 * To add one, implement this interface in `src/<id>/index.ts` (use
 * `ndjsonParser` when the CLI emits NDJSON), record real fixtures, and run
 * `runConformance` over them. `src/claude-code/index.ts` is the reference
 * implementation.
 */
export interface Adapter {
  meta: AdapterMeta;
  detection: DetectionSpec;
  capabilities: CapabilityTable;
  /** Replace default detection entirely; most adapters omit this. */
  detect?: (probe: VersionProbe) => Promise<Detection>;
  /**
   * Map a prompt plus validated options to the exact process to spawn. Pure:
   * build the {@link Invocation}, never launch it.
   */
  buildInvocation: (prompt: string, opts: RunOptions) => Invocation;
  /**
   * Map the process output to normalized events, ending with exactly one
   * `done`. Under `strict`, throw `AnyAgentError` (`code: "Parse"`) on any
   * unrecognized shape — the live drift check relies on strict mode to catch
   * upstream format changes.
   */
  parse: (
    source: OutputSource,
    opts: { strict: boolean }
  ) => AsyncGenerator<AgentEvent, RunResult>;
}

/**
 * Direct access to the native CLI, for capabilities the unified surface does
 * not model (bidirectional sessions, harness-specific output modes, …).
 *
 * `buildInvocation` returns the exact command AnyAgent would run — useful for
 * logging, or for running it yourself somewhere else. `spawn` launches it and
 * hands you the Node `ChildProcess` to drive: you read stdout, you handle
 * exit, and you get no normalized events and no lifecycle management. The
 * prompt is already wired to stdin.
 *
 * Neither call validates options against the capability table — an option
 * the CLI does not support is silently left out of the argv rather than
 * throwing `UnsupportedCapability`.
 */
export interface RawHandle {
  buildInvocation: (prompt: string, opts?: RunOptions) => Invocation;
  spawn: (prompt: string, opts?: RunOptions) => ChildProcess;
}

/**
 * A ready-to-run handle on one installed coding agent; get one from
 * `create()`.
 *
 * `run` is the one-shot call — it resolves with the final {@link RunResult}
 * when the agent finishes. `runStream` yields {@link AgentEvent}s as the
 * agent works and ends with a `done` event carrying that same result. If you
 * `break` out of the stream early, the underlying process is killed for you,
 * so abandoning a stream never leaks a running agent.
 *
 * ```ts
 * const agent = create(claudeCode());
 * for await (const ev of agent.runStream("explain this repo")) {
 *   if (ev.type === "text-delta") {
 *     process.stdout.write(ev.text);
 *   }
 * }
 * ```
 */
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
