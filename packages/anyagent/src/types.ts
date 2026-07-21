import type { ChildProcess } from "node:child_process";

/**
 * How a capability is provided, for each gated field of
 * {@link Capabilities}:
 *
 * - `"native"` — the CLI itself implements it, and the adapter maps your
 *   request onto the CLI's own flags.
 * - `"emulated"` — the CLI has no such flag, so AnyAgent provides the
 *   behavior, identically on every agent that declares it. You ask for it the
 *   same way regardless; the result is uniform across agents.
 * - `false` — unavailable. Requesting it throws `AnyAgentError`
 *   (`code: "UnsupportedCapability"`) before anything spawns.
 *
 * Both `"native"` and `"emulated"` are truthy, so a `caps.x ? … : …` check
 * still reads as "is this available".
 */
export type CapabilitySupport = "native" | "emulated" | false;

/**
 * How a discovery question — {@link Agent.authStatus}, {@link Agent.models} —
 * is answered:
 *
 * - `"native"` — the CLI answers itself, so the answer is authoritative.
 * - `"probed"` — best-effort heuristics over the CLI's credential files and
 *   environment variables. Useful, but drift-prone: treat the answer as a
 *   hint, not a guarantee.
 * - `false` — no answer exists. Calling the method throws `AnyAgentError`
 *   (`code: "UnsupportedCapability"`).
 */
export type DiscoverySupport = "native" | "probed" | false;

/**
 * How hard the model should think, in the shared cross-agent vocabulary. The
 * named levels autocomplete, but any string is accepted and passed through,
 * because several CLIs take provider-defined names AnyAgent cannot enumerate.
 * Where an agent's own vocabulary is closed, its
 * {@link Capabilities.reasoningEfforts} lists the accepted values and
 * anything else fails fast; elsewhere the CLI is the authority and rejects a
 * bad value itself.
 */
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | (string & Record<never, never>);

/**
 * A tool name in the shared cross-agent vocabulary: the common tools every
 * coding agent ships normalize to these names (Claude Code's `Bash` and
 * codex's `shell` both surface as `"bash"`), so a consumer can match on one
 * name across agents. Tools outside the shared vocabulary keep their native
 * name — any string is valid. The untranslated name is always on the event's
 * `nativeName`.
 */
export type ToolName =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "grep"
  | "glob"
  | "webSearch"
  | (string & Record<never, never>);

/**
 * What one agent CLI can do. Read it from {@link Agent.capabilities} (or a
 * {@link DetectResult}) to find out what you can ask for before you ask:
 *
 * ```ts
 * const opts = agent.capabilities.effort ? { effort: "high" } : {};
 * const result = await agent.run(prompt, opts);
 * ```
 *
 * Most fields guard the matching {@link RunOptions} field or {@link Agent}
 * method — requesting something declared `false` throws
 * `AnyAgentError` (`code: "UnsupportedCapability"`) before anything spawns.
 */
export interface Capabilities {
  /**
   * Whether {@link Agent.authStatus} can tell if this CLI's credentials are
   * configured, and how trustworthy the answer is.
   */
  authStatus: DiscoverySupport;
  /**
   * Whether you can choose the directory the agent works in. See
   * {@link BaselineRunOptions.cwd}.
   */
  cwd: CapabilitySupport;
  /**
   * Whether you can set the reasoning effort for a run. See
   * {@link ExtensionOptions.effort}.
   */
  effort: CapabilitySupport;
  /**
   * Whether you can attach MCP servers to a run. See
   * {@link ExtensionOptions.mcp}.
   */
  mcp: CapabilitySupport;
  /**
   * Whether {@link Agent.models} can list the models this CLI accepts, and
   * how trustworthy the list is.
   */
  modelListing: DiscoverySupport;
  /**
   * Whether you can pick the model for a run. See
   * {@link BaselineRunOptions.model}.
   */
  modelSelection: CapabilitySupport;
  /**
   * Whether a run can be confined to reading. See
   * {@link ExtensionOptions.readOnly}. `false` means the CLI has no way to
   * guarantee nothing changes, and asking for `readOnly: true` throws rather
   * than pretending.
   */
  readOnly: CapabilitySupport;
  /**
   * The accepted {@link ExtensionOptions.effort} values, present only when
   * this agent's vocabulary is closed — a value outside the list fails fast.
   * Absent when the CLI accepts open-ended, provider-defined names; then the
   * CLI itself is the authority on validity.
   */
  reasoningEfforts?: readonly string[];
  /**
   * Whether the agent can pick up an earlier conversation. See
   * {@link ExtensionOptions.resume}.
   */
  sessionResume: CapabilitySupport;
  /**
   * Whether the agent streams its work as it goes. When truthy, `runStream`
   * relays the agent's own live events. When `false`, the CLI only prints a
   * final answer, so you get it all at once — one `text-delta` with the whole
   * reply, then `done`. Either way `runStream` works; this just tells you
   * whether to expect progressive output.
   */
  streaming: CapabilitySupport;
  /**
   * Whether the agent can return output shaped to a schema, guarding
   * {@link BaselineRunOptions.schema}. `"emulated"` means the schema
   * instructions travel in the prompt; `"native"` means the CLI has its own
   * structured-output flag. Either way the contract is identical: a
   * validated value on {@link RunResult.json}, with one retry.
   */
  structuredOutput: CapabilitySupport;
  /**
   * Whether you can add to the agent's system prompt. See
   * {@link BaselineRunOptions.systemPrompt}. `"native"` means the CLI has an
   * append-system-prompt flag; `"emulated"` means your text reaches the
   * model as a prompt preamble — observably weaker adherence, same call.
   */
  systemPrompt: CapabilitySupport;
}

/**
 * Whether an agent CLI's credentials are configured:
 *
 * - `"authenticated"` — credentials are present (or the CLI says it is
 *   logged in).
 * - `"unauthenticated"` — no credentials found.
 * - `"unknown"` — the question could not be answered (for example, the key
 *   lives in an OS keyring the probe cannot read). Worth trying a run anyway.
 */
export type AuthState = "authenticated" | "unauthenticated" | "unknown";

/**
 * The answer to {@link Agent.authStatus}: whether this CLI looks ready to
 * run. `method` names how it authenticates when known (`"oauth"`,
 * `"api-key"`, a subscription tier); `providers` lists the model providers
 * with credentials on BYOK CLIs. `raw` is the CLI's own payload, untouched,
 * when one exists.
 *
 * This is "are credentials configured", never "were they verified live" — no
 * paid call is ever made on your behalf.
 */
export interface AuthStatus {
  method?: string;
  providers?: string[];
  raw?: unknown;
  state: AuthState;
}

/**
 * One model an agent accepts, from {@link Agent.models}. The contract that
 * makes the list useful: `id` is valid verbatim as
 * {@link BaselineRunOptions.model} on the same agent. `reasoningEfforts`
 * lists the {@link ExtensionOptions.effort} values this model accepts, when
 * the CLI reports them.
 */
export interface ModelInfo {
  id: string;
  provider?: string;
  raw?: unknown;
  reasoningEfforts?: string[];
}

/**
 * Token and cost accounting for a run, normalized across agents. Every
 * field is optional because each CLI reports a different subset — check for
 * `undefined` rather than assuming a field is present. The CLI's exact
 * native accounting is always available on the event's or result's `raw`.
 */
export interface Usage {
  /** Input tokens served from the provider's prompt cache. */
  cacheReadTokens?: number;
  /** Input tokens written to the provider's prompt cache. */
  cacheWriteTokens?: number;
  costUsd?: number;
  /**
   * Input tokens, matching the underlying provider's accounting — some
   * providers report cache reads/writes as separate line items, others fold
   * them in here. For exact cost, read the native payload on the
   * event/result `raw`.
   */
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens the model spent thinking, where the provider reports them. */
  reasoningTokens?: number;
}

/**
 * One MCP (Model Context Protocol) server to make available to the agent
 * during a run. Set `command`, `args`, and optionally `env` for a local stdio
 * server, or `url` for a remote one. The adapter translates this into
 * whatever config format its CLI expects.
 */
export interface McpServer {
  args?: string[];
  command?: string;
  env?: Record<string, string>;
  url?: string;
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
 * The run options every supported agent honors — the portable contract. Code
 * that types against `BaselineRunOptions` runs unchanged on any agent
 * AnyAgent can drive; the compiler enforces the portability. Everything
 * beyond this is an {@link ExtensionOptions} field, gated per agent.
 *
 * A baseline run is unattended: `run()` and `runStream()` have no channel
 * for answering an approval prompt, so every agent runs with the most
 * autonomy its CLI offers. To keep a run from changing anything, see
 * {@link ExtensionOptions.readOnly}.
 */
export interface BaselineRunOptions {
  /** Directory the agent works in. Defaults to the current process's cwd. */
  cwd?: string;
  /** Extra environment variables, merged over the parent's environment. */
  env?: Record<string, string>;
  /**
   * Escape hatch: extra native CLI flags appended verbatim to the argv, so you
   * can reach a native capability the unified surface does not model while
   * keeping normalized events. Adapter-specific — the caller owns correctness.
   *
   * These flags are never validated and are appended after the flags the
   * adapter builds, so one here can override what a typed option set. Prefer
   * the typed options; reach for this only when nothing else exposes the
   * flag you need.
   */
  extraArgs?: string[];
  /** Model name in the CLI's own vocabulary (e.g. `"opus"` for claude-code). */
  model?: string;
  /**
   * A plain JSON Schema object describing the shape you want the reply in.
   * Works on every adapter (see {@link Capabilities.structuredOutput}).
   * With {@link Agent.run}, the reply is parsed and validated against the
   * schema and the parsed value lands on {@link RunResult.json}. With
   * {@link Agent.runStream}, the schema still shapes the run, but you get raw
   * text events and no parsing.
   */
  schema?: Record<string, unknown>;
  /** Aborting terminates the process; the run throws `code: "Aborted"`. */
  signal?: AbortSignal;
  /**
   * Extra system-level instructions for the run, appended to the CLI's own
   * system prompt where the CLI has a flag for that
   * (`systemPrompt: "native"`), and folded into the prompt text as a
   * preamble where it does not (`"emulated"`) — same call, observably
   * weaker adherence. It never replaces the CLI's built-in prompt.
   */
  systemPrompt?: string;
}

/**
 * The run options that exist only on some agents, each gated by the
 * {@link Capabilities} field of the same shape. Requesting one an agent
 * does not support throws `AnyAgentError` (`code: "UnsupportedCapability"`)
 * before anything spawns. On an agent typed from a specific adapter factory,
 * unsupported fields are compile errors too; after `detect()`, unlock them
 * with {@link Agent.supports}.
 */
export interface ExtensionOptions {
  /**
   * How hard the model should think. Gated by {@link Capabilities.effort};
   * where {@link Capabilities.reasoningEfforts} is present the value is
   * checked against it, otherwise it passes through and the CLI judges it.
   */
  effort: ReasoningEffort;
  /** MCP servers to attach for this run. */
  mcp: McpConfig;
  /**
   * `true` confines the run to reading: nothing on the machine changes — no
   * file writes, no shell. Gated by {@link Capabilities.readOnly}; an
   * agent that cannot guarantee it throws rather than approximating.
   *
   * The default (`false` or omitted) is a fully unattended run with the most
   * autonomy the CLI offers — file edits and shell included. There is no
   * middle setting: nothing in `run()`/`runStream()` can answer an approval
   * prompt, so a level that waits for one cannot exist here. Harness-specific
   * modes between the two remain reachable via
   * {@link BaselineRunOptions.extraArgs}.
   */
  readOnly: boolean;
  /** A session id from a previous run, to continue that conversation. */
  resume: string;
}

/**
 * Which {@link Capabilities} field gates each {@link ExtensionOptions}
 * field.
 */
export const EXTENSION_CAPABILITY = {
  effort: "effort",
  mcp: "mcp",
  readOnly: "readOnly",
  resume: "sessionResume",
} as const satisfies Record<keyof ExtensionOptions, keyof Capabilities>;

/** The name of one gated run option — the keys of {@link ExtensionOptions}. */
export type ExtensionKey = keyof ExtensionOptions;

type Available = Exclude<CapabilitySupport, false>;

/**
 * The capability-table shape {@link Agent.supports} narrows to: the named
 * extensions' gates, known truthy.
 */
export type SupportedCapabilities<K extends ExtensionKey> = {
  [P in (typeof EXTENSION_CAPABILITY)[K]]: Available;
};

type EnabledExtensionKeys<C extends Capabilities> = {
  [K in ExtensionKey]: C[(typeof EXTENSION_CAPABILITY)[K]] extends Available
    ? K
    : never;
}[ExtensionKey];

/**
 * The run options one specific agent accepts, derived from its capability
 * capabilities: the baseline plus every extension declared available.
 * From an adapter factory (`create(claudeCode())`) the capabilities are literal, so
 * an unsupported option is a compile error; from `detect()` they are
 * dynamic and only the baseline is typed until {@link Agent.supports}
 * narrows it.
 */
export type RunOptionsFor<C extends Capabilities> = BaselineRunOptions &
  Partial<Pick<ExtensionOptions, EnabledExtensionKeys<C>>>;

/**
 * Everything you can tune about a single run; all fields are optional. The
 * {@link BaselineRunOptions} fields work on every agent; the
 * {@link ExtensionOptions} fields are validated against the adapter's
 * {@link Capabilities} up front, so asking for something this agent's CLI
 * cannot do throws `AnyAgentError` (`code: "UnsupportedCapability"`) before
 * any process spawns — a wrong assumption fails fast instead of mid-run.
 */
export type RunOptions = BaselineRunOptions & Partial<ExtensionOptions>;

/**
 * One normalized event from a running agent, as yielded by
 * {@link Agent.runStream}:
 *
 * - `session` — the CLI assigned this run a session id (also on
 *   {@link RunResult.sessionId}); emitted once, early, so you can persist it
 *   before the run ends.
 * - `text-delta` — a piece of the agent's answer text.
 * - `reasoning-delta` — a piece of the model's visible thinking, on CLIs
 *   that stream it. Never part of `RunResult.text`.
 * - `tool-call` / `tool-result` — the agent invoked a tool and got its
 *   result. `name` is the shared vocabulary ({@link ToolName}), `nativeName`
 *   the CLI's own; `callId` pairs a result with its call where the CLI
 *   correlates them.
 * - `file-change` — the agent created, modified, or deleted a file, on CLIs
 *   that report it.
 * - `usage` — token/cost accounting became available.
 * - `done` — the run finished; carries the final {@link RunResult}.
 *
 * How much text one `text-delta` carries depends on the CLI: a token, a
 * chunk, or a whole assistant message. What you can rely on — enforced by
 * the conformance suite — is that concatenating every delta's `text`
 * reproduces `RunResult.text` exactly. `raw` on each event except `done` is
 * the CLI's untouched native payload for it.
 */
export type AgentEvent =
  | { type: "session"; sessionId: string; raw?: unknown }
  | { type: "text-delta"; text: string; raw?: unknown }
  | { type: "reasoning-delta"; text: string; raw?: unknown }
  | {
      type: "tool-call";
      name: ToolName;
      nativeName: string;
      callId?: string;
      input: unknown;
      raw?: unknown;
    }
  | {
      type: "tool-result";
      name: ToolName;
      nativeName: string;
      callId?: string;
      output: unknown;
      raw?: unknown;
    }
  | {
      type: "file-change";
      kind: "create" | "modify" | "delete";
      path: string;
      raw?: unknown;
    }
  | { type: "usage"; usage: Usage; raw?: unknown }
  | { type: "done"; result: RunResult };

/**
 * What a finished run gives you back. Holding a `RunResult` means the run
 * succeeded — the CLI exited cleanly and reported no agent-level error; every
 * failure path throws `AnyAgentError` instead, so you never inspect a result
 * to learn whether it worked.
 *
 * `text` is the agent's final answer with all text output concatenated. `raw`
 * is the CLI's own final payload, untouched, for anything the normalized
 * fields leave out.
 */
export interface RunResult {
  /**
   * Every normalized event the run produced, in order (the terminal `done` is
   * excluded). The whole list is held in memory, so for very long agentic
   * runs prefer consuming {@link Agent.runStream} as events arrive.
   */
  events: AgentEvent[];
  /**
   * The reply parsed as JSON, present only when a
   * {@link BaselineRunOptions.schema} was passed to {@link Agent.run}. It has
   * been validated against that schema before landing here; a reply that
   * could not be parsed or validated (even after one retry) throws
   * `AnyAgentError` (`code: "Parse"`) instead.
   */
  json?: unknown;
  raw: unknown;
  /**
   * The session id this run can be resumed under (pass it back as
   * {@link ExtensionOptions.resume}). Absent on CLIs that never reveal one
   * headless — absence is honest, not an error.
   */
  sessionId?: string;
  text: string;
  usage?: Usage;
}

/**
 * A fully-resolved command line: what an adapter's `buildInvocation` returns
 * and what the core (or you, via {@link RawHandle}) spawns. `env` is merged
 * over the parent process's environment rather than replacing it. `input`,
 * when present, is written to the child's stdin, which is then closed — this
 * is how prompts reach CLIs that read them from a pipe.
 */
export interface Invocation {
  args: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
}

/**
 * The process output an adapter's `parse` reads. Consume EITHER `lines()`
 * (NDJSON adapters) OR `text()` (plain-text adapters), never both — the
 * underlying stdout stream is read once.
 */
export interface OutputSource {
  /**
   * Terminate the underlying process. The core calls this when a consumer
   * abandons a stream early, so a half-read agent isn't left running. A no-op
   * once the process has already exited.
   */
  close?: () => void;
  exitCode: Promise<number>;
  lines: () => AsyncIterable<string>;
  /**
   * Resolves with the stderr captured so far — complete only once `exitCode`
   * has settled.
   */
  stderr: () => Promise<string>;
  text: () => Promise<string>;
}

/**
 * The two I/O operations detection needs: `which` resolves a binary name to
 * its path on `PATH` (or `undefined` when absent), and `exec` runs a binary
 * and captures its output. `detect()` uses a real implementation by default;
 * tests pass a fake via `detect({ probe })` to simulate any machine without
 * spawning processes.
 */
export interface VersionProbe {
  exec: (
    bin: string,
    args: string[]
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  which: (bin: string) => Promise<string | undefined>;
}

/**
 * Everything discovery reads from the machine: the {@link VersionProbe}
 * operations plus the environment, the home directory, and file contents —
 * what {@link Agent.authStatus} and {@link Agent.models} consult. The real
 * one is the default; tests pass a fake via `create(source, { probe })` to
 * simulate any machine, credentials included, with zero subprocesses.
 * `readFile` resolves `undefined` for a missing or unreadable file.
 */
export interface SystemProbe extends VersionProbe {
  env: Record<string, string | undefined>;
  homedir: () => string;
  readFile: (path: string) => Promise<string | undefined>;
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
 * declare module "anyagent/types" {
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
  bin: string[];
  id: AgentId;
  name: string;
}

/**
 * One coding agent found on the machine and ready to run. `detect()` gives you
 * one of these for each installed agent; hand it straight to `create()` to get
 * a runnable {@link Agent}.
 */
export interface DetectResult {
  /**
   * The adapter that knows how to drive this agent. `create()` uses it; you
   * won't normally reach for it yourself.
   */
  adapter: Adapter;
  /** What this agent can and can't do, so you can tailor a run to it. */
  capabilities: Capabilities;
  /**
   * The stable id of the agent tool, e.g. `"claude-code"`. Use this
   * to programmatically identify a specific agent tool.
   */
  id: AgentId;
  /** The human-readable agent tool name, e.g. `"Claude Code"`. */
  name: string;
  /** The full path to the agent's program on disk. */
  path: string;
  /**
   * The installed version, e.g. `"2.0.31"`, absent when the agent doesn't
   * report one.
   */
  version?: string;
}

/**
 * The raw result of checking for one agent, produced by built-in detection or
 * a custom {@link Adapter.detect}. Unlike {@link DetectResult} it also covers
 * the not-found case — that's why `path` can be absent: when the agent's
 * program isn't on `PATH`, `installed` is `false` and `path` is missing.
 * `detect()` drops those and hands you only {@link DetectResult}s, so you
 * won't meet this type unless you're writing an adapter.
 */
export interface Detection {
  /** The adapter that knows how to drive this agent. */
  adapter: Adapter;
  /** What this agent can and can't do. */
  capabilities: Capabilities;
  /** A short, stable id for the agent, e.g. `"claude-code"`. */
  id: AgentId;
  /** Whether the agent's program was found on the user's `PATH`. */
  installed: boolean;
  /** The agent's display name, e.g. `"Claude Code"`. */
  name: string;
  /** The full path to the program on disk, absent when it wasn't found. */
  path?: string;
  /** The installed version, absent when none was reported. */
  version?: string;
}

/**
 * The contract for supporting one agent CLI. An adapter is data plus pure
 * functions: it describes how to invoke its CLI and how to read its output,
 * while the core does all actual I/O (spawning, stream handling, validation,
 * lifecycle). That split keeps adapters testable offline against recorded
 * fixtures, with zero subprocesses.
 *
 * Declare `capabilities` with `as const satisfies Capabilities` so the
 * table's literal types reach {@link Agent} and unsupported options become
 * compile errors for your consumers.
 *
 * To add one, implement this interface (use `ndjsonParser` when the CLI
 * emits NDJSON), record real fixtures, and run `runConformance` over them.
 */
export interface Adapter<C extends Capabilities = Capabilities> {
  /**
   * Answer {@link Agent.authStatus} from the probe. Required when `authStatus` is declared
   * available; read files and env, or run a
   * credential-status subcommand — never anything that costs a model call.
   */
  authStatus?: (probe: SystemProbe) => Promise<AuthStatus>;
  /**
   * Map a prompt plus validated options to the exact process to spawn. Pure:
   * build the {@link Invocation}, never launch it.
   */
  buildInvocation: (prompt: string, opts: RunOptions) => Invocation;
  capabilities: C;
  /** Replace default detection entirely; most adapters omit this. */
  detect?: (probe: VersionProbe) => Promise<Detection>;
  detection: DetectionSpec;
  /**
   * Answer {@link Agent.models} from the probe. Required when `modelListing` is declared
   * available. Every returned id must be valid
   * verbatim as {@link BaselineRunOptions.model} on this agent.
   */
  listModels?: (probe: SystemProbe) => Promise<ModelInfo[]>;
  meta: AdapterMeta;
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
 * not model (bidirectional sessions, CLI-specific output modes, …).
 *
 * `buildInvocation` returns the exact command AnyAgent would run — useful for
 * logging, or for running it yourself somewhere else. `spawn` launches it and
 * hands you the Node `ChildProcess` to drive: you read stdout, you handle
 * exit, and you get no normalized events and no lifecycle management. The
 * prompt is already wired to stdin.
 *
 * Neither call validates options against the declared capabilities — an option
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
 * The options a specific agent accepts follow its capabilities `C`: from
 * an adapter factory the capabilities are literal and unsupported options fail to
 * compile; from `detect()` only the {@link BaselineRunOptions} are typed
 * until {@link Agent.supports} unlocks the extensions it confirms.
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
export interface Agent<C extends Capabilities = Capabilities> {
  readonly adapter: Adapter<C>;
  /**
   * Whether this agent's CLI has credentials configured — never verified
   * with a paid call. See {@link AuthStatus}; `"unknown"` is a first-class
   * answer. Throws `UnsupportedCapability` on
   * `authStatus: false`.
   */
  authStatus: () => Promise<AuthStatus>;
  readonly capabilities: C;
  /**
   * The models this agent accepts, each id usable verbatim as
   * {@link BaselineRunOptions.model}. Throws `UnsupportedCapability` on
   * `modelListing: false` — some CLIs simply have no list.
   */
  models: () => Promise<ModelInfo[]>;
  readonly raw: RawHandle;
  run: (prompt: string, opts?: RunOptionsFor<C>) => Promise<RunResult>;
  runStream: (
    prompt: string,
    opts?: RunOptionsFor<C>
  ) => AsyncGenerator<AgentEvent, RunResult>;
  /**
   * Check extension support and unlock the matching options in one gesture:
   * at runtime it answers whether every named extension is available on this
   * agent; to the compiler, a `true` branch narrows the agent's type so
   * those options typecheck.
   *
   * ```ts
   * if (agent.supports("readOnly", "effort")) {
   *   await agent.run(prompt, { effort: "high", readOnly: true });
   * }
   * ```
   */
  supports: <K extends ExtensionKey[]>(
    ...keys: K
  ) => this is Agent<C & SupportedCapabilities<K[number]>>;
}
