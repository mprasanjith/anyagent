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
 * How {@link Agent.usageStatus} is answered. The {@link DiscoverySupport}
 * values carry their usual meaning, plus one this question alone has:
 *
 * - `"remote"` — the harness keeps no local answer at all; only the vendor's
 *   own API knows. Answering costs a network request with the credential the
 *   CLI already stores, so it happens only when the caller opts in via
 *   {@link CreateOptions.network}. Without that opt-in the answer is
 *   `{ state: "unknown" }` — the same shape `false` gives, reached for a
 *   different reason.
 *
 * `"native"` and `"probed"` never require the opt-in; an adapter declaring
 * either may still *sharpen* its answer when network is enabled (a live
 * figure in place of a cached one), which is why freshness is read from
 * {@link UsageStatus.asOf} rather than inferred from this field.
 */
export type UsageSupport = DiscoverySupport | "remote";

/**
 * The slice of `fetch` an adapter actually uses: a GET with headers, an
 * abort signal, and manual redirect handling.
 *
 * Deliberately narrower than `typeof globalThis.fetch`. The platform type
 * carries properties (`preconnect`) that a hand-written stub or a proxy
 * wrapper has no reason to implement, so requiring it would make the common
 * cases — a test double, a fetch with a custom agent — fail to typecheck for
 * no benefit. The real `fetch` satisfies this.
 */
export type FetchLike = (
  input: string,
  init?: {
    body?: string;
    headers?: Record<string, string>;
    method?: "POST";
    redirect?: "manual";
    signal?: AbortSignal;
  }
) => Promise<Response>;

/**
 * How runs are paid for: a rolling-window `"subscription"` (marginal cost is
 * zero until the window fills), a metered `"api-key"`, or `"unknown"`.
 * Always the adapter's own assertion, from the same signals that answer
 * {@link Agent.authStatus} — never inferred downstream from
 * {@link AuthStatus.method} strings.
 */
export type BillingMode = "subscription" | "api-key" | "unknown";

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
   * Whether files can be attached to a prompt. See
   * {@link ExtensionOptions.attachments}.
   */
  attachments: CapabilitySupport;
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
   * Whether a conversation can be continued from a persisted id, gating
   * {@link ExtensionOptions.resume} and {@link SessionOptions.resume}.
   */
  resume: CapabilitySupport;
  /**
   * Whether resuming can branch into a new conversation instead of
   * continuing the old one. See {@link SessionOptions.fork} and
   * {@link ExtensionOptions.forkSession}.
   */
  sessionFork: CapabilitySupport;
  /**
   * Whether the agent streams its work as it goes. When truthy, iterating a
   * {@link Run} relays the agent's own live events. When `false`, the CLI
   * only prints a final answer, so you get it all at once — one `text-delta`
   * with the whole reply, then `done`. Iteration works either way; this just
   * tells you whether to expect progressive output.
   */
  streaming: CapabilitySupport;
  /**
   * Whether the agent can return output shaped to a schema, guarding
   * {@link BaselineRunOptions.schema}. Either way a validated value lands on
   * {@link RunResult.json}. `"native"` means the CLI enforces the shape
   * itself; `"emulated"` is a weaker guarantee — AnyAgent validates the reply
   * and, unless {@link BaselineRunOptions.schemaRetries} is `0`, re-asks once
   * before giving up.
   */
  structuredOutput: CapabilitySupport;
  /**
   * Whether you can add to the agent's system prompt. See
   * {@link BaselineRunOptions.systemPrompt}. Your text always reaches the
   * model and never replaces the CLI's built-in prompt; `"emulated"` has
   * observably weaker adherence than `"native"`, from the same call.
   */
  systemPrompt: CapabilitySupport;
  /**
   * How {@link Agent.usageStatus} answers: `"native"` — the CLI reports its
   * own limit standing, live and authoritative. `"probed"` — read from the
   * CLI's local state; a hint, possibly stale (check
   * {@link UsageStatus.asOf}). `"remote"` — only the vendor's API knows, so
   * the answer needs {@link CreateOptions.network}. `false` — no surface
   * exists.
   *
   * Unlike the other discovery fields this one never gates: the call works
   * on every agent, and `false` just means the answer is always
   * `{ state: "unknown" }` — itself the routing signal ("unmetered, spend
   * cautiously"), so there is nothing for a throw to tell you. `false` is a
   * claim about observability, not about limits existing: a BYOK harness is
   * metered at its provider, where no CLI can see.
   */
  usageStatus: UsageSupport;
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
 * with credentials on BYOK CLIs.
 *
 * This is "are credentials configured", never "were they verified live" — no
 * paid call is ever made on your behalf.
 */
export interface AuthStatus {
  /**
   * How runs on this harness are paid for — the harness-level default, which
   * a {@link ModelInfo.billing} may override on CLIs that mix modes.
   * `"unknown"` is a first-class answer: treat such a placement as unmetered
   * and spend cautiously.
   */
  billing: BillingMode;
  method?: string;
  providers?: string[];
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
  /**
   * Overrides the harness-level {@link AuthStatus.billing} for this model,
   * on CLIs that mix modes (a first-party gateway beside BYOK providers).
   * Absent means "inherit the harness default".
   */
  billing?: BillingMode;
  id: string;
  /**
   * The canonical model-vendor slug (`"anthropic"`, `"openai"`, `"google"`,
   * …) — the join key from this model to public pricing and benchmarks.
   * Never a gateway or biller: an id like `kilo/~anthropic/claude-…` yields
   * `"anthropic"`, not `"kilo"`. Present only when the adapter can assert
   * it; absent is honest, a guess would poison the join.
   */
  provider?: string;
  raw?: unknown;
  reasoningEfforts?: string[];
}

/**
 * How much of a harness's rolling usage limits remain — the answer to
 * {@link Agent.usageStatus}:
 *
 * - `"ok"` — no window is constrained.
 * - `"near-limit"` — the CLI itself flags a window as elevated.
 * - `"exhausted"` — a window is spent; a run would be refused or degraded.
 *   The one value worth treating as hard: placing work here takes the
 *   user's own interactive tool dark.
 * - `"unknown"` — nothing is known; treat the placement as unmetered and
 *   spend cautiously.
 *
 * `state` always summarizes the windows in the same answer — the worst
 * standing among them — so a scoped query yields the placement's truth and
 * an unscoped one is conservatively account-wide.
 */
export type UsageState = "ok" | "near-limit" | "exhausted" | "unknown";

/** One rolling-window limit, normalized across agents. */
export interface UsageWindow {
  /**
   * The CLI's own name for the window (`"session"`, `"weekly_all"`,
   * `"primary"`) — vocabulary, not semantics; compare within one agent only.
   */
  label: string;
  /**
   * A model string for the bucket this window binds, valid verbatim as
   * {@link BaselineRunOptions.model} on this agent. Present only when the
   * adapter can assert the mapping; absent when it can't.
   */
  model?: string;
  /**
   * The CLI's display label for the model bucket this window binds
   * (`"Fable"`), when the limit is narrower than the whole account. A
   * label, not a model id; account-wide windows leave it absent.
   */
  modelScope?: string;
  /** When the window rolls over, if known. */
  resetsAt?: Date;
  /** Share of the window consumed, 0–100, when the CLI reports it. */
  usedPercent?: number;
  /**
   * How long the window spans, in minutes (`300` for a 5-hour bucket,
   * `10080` for a weekly one) — the only field that identifies a window
   * across releases. {@link label} is the CLI's vocabulary and can be
   * positional: Codex has shipped its 7-day figure under `primary` with
   * `secondary` absent, so a caller distinguishing "the 5h bucket" from
   * "the weekly one" must read this, never the label. Absent when the CLI
   * does not say.
   */
  windowMinutes?: number;
}

/**
 * Pay-as-you-go standing alongside the rolling windows: the balance that
 * keeps a harness usable once its included windows are spent. Reported only
 * where a harness has such a pool — most do not.
 */
export interface UsageCredits {
  /** Remaining balance in {@link currency}, when a figure is reported. */
  balance?: number;
  /** ISO 4217 code for {@link balance} (`"USD"`). Absent if unstated. */
  currency?: string;
  /** Whether the pool is uncapped, when the harness says so. */
  unlimited?: boolean;
}

/**
 * The answer to {@link Agent.usageStatus}. No `raw` on purpose: native
 * usage payloads embed account identifiers, and everything decision-relevant
 * is normalized here. `asOf` is when the CLI produced the numbers, not when
 * you asked — a cached source can be hours old, and staleness is the
 * caller's judgment to make.
 */
export interface UsageStatus {
  asOf?: Date;
  /**
   * Pay-as-you-go balance backing this harness, when it has one. Read it
   * before treating `state: "exhausted"` as final: spent windows plus a
   * funded balance still runs, just metered.
   */
  credits?: UsageCredits;
  state: UsageState;
  windows?: UsageWindow[];
}

/**
 * Options for {@link Agent.usageStatus}. `model` scopes the answer to one
 * placement: anything valid as {@link BaselineRunOptions.model} on this
 * agent. The returned windows narrow to those that bind this model —
 * account-wide windows plus matching model buckets — and `state` is judged
 * over that subset. Exclusion requires assertion: a scoped window is
 * dropped only when the adapter can place the model *outside* its bucket,
 * so an unrecognized model keeps every window and errs conservative.
 */
export interface UsageStatusOptions {
  model?: string;
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
 * A baseline run is autonomous: a run has no channel
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
   * Awaiting the run gives you the reply parsed and validated against the
   * schema, on {@link RunResult.json}; iterating yields raw text events, with
   * no parsing.
   */
  schema?: Record<string, unknown>;
  /**
   * How many correction attempts a reply that fails
   * {@link BaselineRunOptions.schema} gets. `1` (the default) re-asks once,
   * announced by a `schema-retry` {@link AgentEvent}; `0` fails on the first
   * bad reply, throwing `AnyAgentError` (`code: "Parse"`) with the failed
   * checks on `issues` — what you want when your own code owns the correction
   * loop. Requires `schema` (`InvalidOptions` without it).
   */
  schemaRetries?: 0 | 1;
  /** Aborting terminates the process; the run throws `code: "Aborted"`. */
  signal?: AbortSignal;
  /**
   * Extra system-level instructions for the run, added on top of the CLI's
   * own system prompt, which they never replace. Where
   * {@link Capabilities.systemPrompt} is `"emulated"`, adherence is observably
   * weaker than `"native"`; the call is the same either way.
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
   * Paths of files to attach to the prompt, passed on the CLI's own
   * attachment flags. Gated by {@link Capabilities.attachments}.
   */
  attachments: string[];
  /**
   * How hard the model should think. Gated by {@link Capabilities.effort};
   * where {@link Capabilities.reasoningEfforts} is present the value is
   * checked against it, otherwise it passes through and the CLI judges it.
   */
  effort: ReasoningEffort;
  /**
   * With {@link ExtensionOptions.resume}, branch into a new conversation
   * instead of continuing the old one; the run's `sessionId` is the new
   * conversation's id. Requires `resume` (`InvalidOptions` without it) and
   * is gated by {@link Capabilities.sessionFork}. The ergonomic route is
   * {@link SessionOptions.fork}.
   */
  forkSession: boolean;
  /** MCP servers to attach for this run. */
  mcp: McpConfig;
  /**
   * `true` confines the run to reading: nothing on the machine changes — no
   * file writes, no shell. Gated by {@link Capabilities.readOnly}; an
   * agent that cannot guarantee it throws rather than approximating.
   *
   * The default (`false` or omitted) is a fully autonomous run with the most
   * autonomy the CLI offers — file edits and shell included. There is no
   * middle setting: nothing in a run can answer an approval
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
  attachments: "attachments",
  effort: "effort",
  forkSession: "sessionFork",
  mcp: "mcp",
  readOnly: "readOnly",
  resume: "resume",
} as const satisfies Record<keyof ExtensionOptions, keyof Capabilities>;

/** The name of one gated run option — the keys of {@link ExtensionOptions}. */
export type ExtensionKey = keyof ExtensionOptions;

type Gate<K extends ExtensionKey> = (typeof EXTENSION_CAPABILITY)[K];

type Available<P extends keyof Capabilities> = Exclude<Capabilities[P], false>;

/**
 * The capability-table shape {@link Agent.supports} narrows to: the named
 * extensions' gates, known truthy.
 */
export type SupportedCapabilities<K extends ExtensionKey> = {
  [P in Gate<K>]: Available<P>;
};

type EnabledExtensionKeys<C extends Capabilities> = {
  [K in ExtensionKey]: C[Gate<K>] extends Available<Gate<K>> ? K : never;
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
 * One normalized event from a running agent, as yielded by iterating a
 * {@link Run}:
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
 * - `permission-request` — the agent asked to run something that needs
 *   approval. AnyAgent currently answers automatically with the first allow
 *   option; the event lets you observe what was asked.
 * - `schema-retry` — the reply failed the run's
 *   {@link BaselineRunOptions.schema} and a corrected one is being asked for;
 *   `issues` are the failed checks. Every event after it belongs to the
 *   corrected attempt.
 * - `done` — the run finished; carries the final {@link RunResult}.
 *
 * How much text one `text-delta` carries depends on the CLI: a token, a
 * chunk, or a whole assistant message. What you can rely on is that
 * concatenating every delta's `text` reproduces `RunResult.text` exactly.
 * `raw` on each event except `done` and `schema-retry` is the CLI's untouched
 * native payload for it.
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
  | {
      type: "permission-request";
      requestId: string;
      name: ToolName;
      nativeName: string;
      input: unknown;
      options: PermissionOption[];
      raw?: unknown;
    }
  | { type: "schema-retry"; issues: string[] }
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
   * runs prefer iterating the {@link Run} as events arrive.
   */
  events: AgentEvent[];
  /**
   * The run's JSON value, present only when a
   * {@link BaselineRunOptions.schema} was passed to {@link Agent.run}. Taken
   * from {@link structuredOutput} when the CLI returned one, otherwise parsed
   * out of `text`; either way it has been validated against the schema before
   * landing here — a reply that could not be parsed or validated throws
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
  /**
   * The schema-shaped payload the CLI itself returned, verbatim, on native
   * structured-output runs. `text` may hold prose the model streamed before
   * answering through the schema channel; the validated value lands on
   * {@link json}.
   */
  structuredOutput?: unknown;
  text: string;
  usage?: Usage;
}

/**
 * A fully-resolved command line: what an adapter's `buildInvocation` returns
 * and what the core spawns. `env` is merged over the parent process's
 * environment rather than replacing it. `input`,
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
   * abandons the stream early. A no-op once the process has already exited.
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
 * One step of a JSON-RPC dialogue for {@link SystemProbe.rpc}: a request
 * awaiting a response, or a fire-and-forget notification (no id, nothing
 * awaited) when `notification` is set.
 */
export interface RpcExchange {
  method: string;
  notification?: boolean;
  params?: unknown;
}

/**
 * The response to one {@link RpcExchange}, index-aligned with the exchanges:
 * a `result` or an `error` for requests, `undefined` for notifications.
 */
export type RpcOutcome =
  | { result: unknown; error?: never }
  | { error: { code?: number; message: string }; result?: never }
  | undefined;

/**
 * Everything discovery reads from the machine: the {@link VersionProbe}
 * operations plus the environment, the home directory, file contents, and a
 * service dialogue — what {@link Agent.authStatus}, {@link Agent.models},
 * and {@link Agent.usageStatus} consult. The real one is the default; tests
 * pass a fake via `create(source, { probe })` to simulate any machine,
 * credentials included, with zero subprocesses. `readFile` resolves
 * `undefined` for a missing or unreadable file.
 *
 * Everything here is local except the optional `fetch`, which is absent
 * unless the caller turned egress on.
 */
export interface SystemProbe extends VersionProbe {
  env: Record<string, string | undefined>;
  /**
   * Egress, present only when the caller opted in via
   * {@link CreateOptions.network} — absent is the default, and an adapter
   * that finds it absent answers from local state or not at all. Requests
   * made through it carry a credential the CLI already stores, so it is the
   * one probe member that reaches past the machine.
   *
   * The shape is {@link FetchLike} — the platform `fetch` satisfies it, and
   * so does a hand-written double or a proxy wrapper. Adapters do not call
   * it directly: the bounded, redirect-safe `fetchJson` helper wraps it.
   */
  fetch?: FetchLike;
  /**
   * The same contract as {@link SystemProbe.fetch}, restricted to loopback —
   * a request to any host but `127.0.0.1`/`::1` is refused.
   *
   * Always present on the real probe and never gated by
   * {@link CreateOptions.network}, because nothing leaves the machine: this
   * is talking to a service the user is already running, the same class of
   * act as {@link SystemProbe.rpc} spawning a CLI's service subcommand. Pair
   * it with {@link SystemProbe.localListeners} to find the port.
   */
  fetchLocal?: FetchLike;
  homedir: () => string;
  /**
   * The TCP ports a local process matching `name` is listening on.
   *
   * `name` is tested against the process's command name and its executable
   * path, so either identifies it. The core owns the per-OS lookup, which is
   * why this is one method rather than raw directory and symlink reads:
   * `/proc`, `lsof`, and the Windows TCP table have nothing in common but
   * the answer.
   *
   * The order carries no ranking. A process that binds several listeners
   * gives no reliable way to tell which speaks which protocol — the guess
   * that a language server's RPC port outranks its TLS port has been
   * observed false — so a caller probes every port and lets the service
   * identify itself.
   */
  localListeners?: (name: RegExp) => Promise<number[]>;
  readFile: (path: string) => Promise<string | undefined>;
  /**
   * Drive a one-shot JSON-RPC 2.0 dialogue (NDJSON over stdio) against a
   * CLI's service subcommand. Exchanges run strictly in order — each request
   * is sent only after the previous request's response arrives, so a
   * handshake is just the first exchanges in the list. The probe owns id
   * assignment, matches responses by id, drops unsolicited server traffic,
   * and terminates the process after the last response — service processes
   * never exit on their own. Output that is not JSON-RPC kills the process
   * and throws `AnyAgentError` (`code: "Parse"`) at once, so a CLI that
   * misreads the dialogue as a prompt fails fast instead of being fed input.
   */
  rpc: (
    bin: string,
    args: string[],
    exchanges: RpcExchange[],
    opts?: { timeoutMs?: number }
  ) => Promise<RpcOutcome[]>;
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
  antigravity: true;
  "claude-code": true;
  cline: true;
  codex: true;
  cursor: true;
  "gemini-cli": true;
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

/** One session configuration option and the value to set it to. */
export interface AcpConfigOption {
  configId: string;
  value: string;
}

/** What a session's settings become on one CLI's ACP endpoint. */
export interface AcpSettings {
  /** Appended to the endpoint's argv. */
  args?: string[];
  /** Applied in order, once the session opens. */
  configOptions?: AcpConfigOption[];
}

/**
 * How to reach and configure one CLI's ACP endpoint. `command` is the argv
 * that launches it.
 *
 * `settings` maps a session's {@link SessionOptions} onto the endpoint's own
 * channels; throw `AnyAgentError` (`code: "UnsupportedCapability"`) from it
 * for a setting this endpoint has no channel for, so the session fails before
 * anything spawns rather than dropping it.
 *
 * `readOnly` is the option that confines a turn to reading. Omit it where the
 * CLI's read-only mode is absent or cannot be trusted; permission denial holds
 * the line either way.
 */
export interface AcpSpec {
  command: string[];
  readOnly?: AcpConfigOption;
  settings?: (opts: SessionOptions) => AcpSettings;
}

/**
 * What every adapter declares, whichever channel it drives its CLI over.
 *
 * Declare `capabilities` with `as const satisfies Capabilities` so the
 * table's literal types reach {@link Agent} and unsupported options become
 * compile errors for your consumers.
 */
export interface AdapterCore<C extends Capabilities = Capabilities> {
  /**
   * Answer {@link Agent.authStatus} from the probe. Required when `authStatus` is declared
   * available; read files and env, or run a
   * credential-status subcommand — never anything that costs a model call.
   */
  authStatus?: (probe: SystemProbe) => Promise<AuthStatus>;
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
   * Answer {@link Agent.usageStatus} from the probe: read the CLI's local
   * state or drive a service dialogue ({@link SystemProbe.rpc}) — never
   * anything that costs a model call. Omitted (with `usageStatus: false`),
   * the core answers `{ state: "unknown" }` itself. The adapter owns the
   * {@link UsageStatusOptions.model} scoping, since bucket membership is
   * vocabulary knowledge.
   */
  usageStatus?: (
    probe: SystemProbe,
    opts: UsageStatusOptions
  ) => Promise<UsageStatus>;
}

/**
 * An adapter that drives its CLI one process per turn: it describes how to
 * invoke the CLI and how to read its output, and the core does the I/O.
 *
 * To add one, implement this interface (use `ndjsonParser` when the CLI emits
 * NDJSON), record real fixtures, and run `runConformance` over them.
 */
export interface StdoutAdapter<C extends Capabilities = Capabilities>
  extends AdapterCore<C> {
  acp?: never;
  /**
   * Map a prompt plus validated options to the exact process to spawn. Pure:
   * build the {@link Invocation}, never launch it.
   */
  buildInvocation: (prompt: string, opts: RunOptions) => Invocation;
  mode: "stdout";
  /**
   * Map the process output to normalized events, ending with exactly one
   * `done`. Under `strict`, throw `AnyAgentError` (`code: "Parse"`) on any
   * unrecognized shape.
   */
  parse: (
    source: OutputSource,
    opts: { strict: boolean }
  ) => AsyncGenerator<AgentEvent, RunResult>;
}

/**
 * An adapter that drives its CLI over ACP (Agent Client Protocol): it
 * describes how to launch and configure the endpoint, and the shared client
 * speaks the protocol. Every turn runs on a live connection, which is what
 * unlocks {@link Session.steer} and `permission-request` events.
 */
export interface AcpAdapter<C extends Capabilities = Capabilities>
  extends AdapterCore<C> {
  acp: AcpSpec;
  buildInvocation?: never;
  mode: "acp";
  parse?: never;
  sessionSeed?: never;
}

/**
 * The contract for supporting one agent CLI: a {@link StdoutAdapter} or an
 * {@link AcpAdapter}, told apart by `mode`. An adapter is data plus pure
 * functions; the core does all actual I/O (spawning, connecting, stream
 * handling, validation, lifecycle), which keeps adapters testable offline.
 */
export type Adapter<C extends Capabilities = Capabilities> =
  | AcpAdapter<C>
  | StdoutAdapter<C>;

/**
 * A ready-to-run handle on one installed coding agent; get one from
 * `create()`.
 *
 * `run` starts one autonomous turn and returns a {@link Run}: await it for
 * the final {@link RunResult}, iterate it for live {@link AgentEvent}s, or
 * both. `session` opens a multi-turn conversation.
 *
 * The options a specific agent accepts follow its capabilities `C`: from
 * an adapter factory the capabilities are literal and unsupported options fail to
 * compile; from `detect()` only the {@link BaselineRunOptions} are typed
 * until {@link Agent.supports} unlocks the extensions it confirms.
 *
 * ```ts
 * const agent = create(claudeCode());
 * for await (const ev of agent.run("explain this repo")) {
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
  run: (prompt: string, opts?: RunOptionsFor<C>) => Run;
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
  /**
   * Open a session: one conversation spanning many turns. Continuity is the
   * session's job — each `run` threads the previous turn's resume handle
   * automatically, and `session.id` is a plain string you can persist and
   * pass back later as `{ resume }`. On an agent that runs one process per
   * turn, continuity needs {@link Capabilities.resume}; without it
   * `session()` throws `UnsupportedCapability`.
   *
   * A session is a thread: its {@link SessionOptions} settings are fixed here
   * and apply to every turn. Fork it to continue the conversation under
   * different settings.
   *
   * ```ts
   * const session = agent.session({ model: "opus" });
   * await session.run("Review this repo.");
   * await session.run("Fix what you found.");
   * ```
   */
  session: (opts?: SessionOptions) => Session<C>;
  supports: <K extends ExtensionKey[]>(
    ...keys: K
  ) => this is Agent<C & SupportedCapabilities<K[number]>>;
  /**
   * How much of this harness's rolling usage limits remain — never verified
   * with a paid call. Works on every agent: where
   * {@link Capabilities.usageStatus} is `false` the answer is always
   * `{ state: "unknown" }`, no throw. Pass `{ model }` to scope the answer
   * to one placement:
   *
   * ```ts
   * const { state } = await agent.usageStatus({ model: "fable" });
   * if (state !== "exhausted") {
   *   await agent.run(prompt, { model: "fable" });
   * }
   * ```
   */
  usageStatus: (opts?: UsageStatusOptions) => Promise<UsageStatus>;
}

/**
 * One run in flight: what {@link Agent.run} and {@link Session.run} return.
 * Await it for the final {@link RunResult}, iterate it for live
 * {@link AgentEvent}s, or do both — the same handle serves every consumer.
 *
 * ```ts
 * const run = agent.run("Review this repo.");
 * for await (const event of run) {
 *   render(event);
 * }
 * const result = await run;
 * ```
 *
 * The run starts when the call is made and runs to completion unless
 * `abort()` is called or the run's `signal` fires. Breaking out of an
 * iteration loop stops watching, never the agent. When a run fails, iterating
 * yields the events received so far and then throws the error awaiting rejects
 * with. On a run with a {@link BaselineRunOptions.schema}, awaiting resolves
 * the parsed result; iterating yields every attempt's events, separated by a
 * `schema-retry` event, and the terminal `done` carries the same result
 * awaiting resolves with.
 */
export interface Run extends Promise<RunResult>, AsyncIterable<AgentEvent> {
  /** Stop the agent: the process is terminated and the run throws `code: "Aborted"`. */
  abort: () => void;
}

/**
 * One choice an agent offers on a `permission-request` event. The agent
 * defines its own options; `kind` normalizes the common ones so an approval
 * UI can group them, and `label` is the agent's own wording.
 */
export interface PermissionOption {
  id: string;
  kind:
    | "allow-once"
    | "allow-always"
    | "reject-once"
    | "reject-always"
    | (string & Record<never, never>);
  label: string;
}

/**
 * Options for {@link Agent.session}. A session is a thread: `model`, `effort`,
 * `cwd`, `env`, `mcp`, and `extraArgs` are its settings, fixed here for its
 * whole lifetime and applied to every turn — `session.run` takes only per-turn
 * options, and passing a setting there throws `AnyAgentError`
 * (`code: "InvalidOptions"`). To continue the conversation under different
 * settings, fork it into a new session. Every setting is validated against the
 * agent's {@link Capabilities} at `agent.session()`, before any turn runs.
 *
 * `resume` continues an earlier session from a persisted {@link Session.id}.
 * `fork` branches: the first turn carries the CLI's copy-on-resume flag, and
 * `session.id` becomes the new conversation's id. `fork` requires `resume`
 * (`InvalidOptions` without it) and is gated by
 * {@link Capabilities.sessionFork}.
 */
export interface SessionOptions {
  /** Directory every turn works in. Defaults to the current process's cwd. */
  cwd?: string;
  /**
   * How hard the model should think on every turn. Gated by
   * {@link Capabilities.effort}; where {@link Capabilities.reasoningEfforts}
   * is present the value is checked against it, otherwise it passes through
   * and the CLI judges it.
   */
  effort?: ReasoningEffort;
  /** Extra environment variables for every turn, merged over the parent's. */
  env?: Record<string, string>;
  /**
   * Extra native CLI flags appended verbatim to every turn's argv, with the
   * caveats on {@link BaselineRunOptions.extraArgs}. For a flag on one turn
   * only, run it outside the session:
   * `agent.run(prompt, { resume: session.id, extraArgs })`.
   */
  extraArgs?: string[];
  fork?: boolean;
  /** MCP servers attached to every turn. Gated by {@link Capabilities.mcp}. */
  mcp?: McpConfig;
  /**
   * Model every turn runs on, in the CLI's own vocabulary (e.g. `"opus"` for
   * claude-code). Gated by {@link Capabilities.modelSelection}.
   */
  model?: string;
  resume?: string;
}

/**
 * The per-turn options a session accepts: everything the agent accepts minus
 * what the session owns — `resume` and `forkSession`, plus the thread's
 * settings (`model`, `effort`, `cwd`, `env`, `mcp`, `extraArgs`; see
 * {@link SessionOptions}). Passing any of them anyway throws
 * `AnyAgentError` (`code: "InvalidOptions"`).
 */
export type SessionRunOptionsFor<C extends Capabilities> = Omit<
  RunOptionsFor<C>,
  | "cwd"
  | "effort"
  | "env"
  | "extraArgs"
  | "forkSession"
  | "mcp"
  | "model"
  | "resume"
>;

/** The members {@link Session.supports} gates: the ACP-mode verbs. */
export type SessionKey = "respond" | "steer";

/**
 * One conversation with an agent, spanning many turns; get one from
 * {@link Agent.session}. `run` mirrors the agent's, with continuity handled
 * for you, and turns queue: a `run` called while another is in flight spawns
 * after it, threaded automatically. A failed turn rejects the turns queued
 * behind it; calling `run` again afterwards retries from the last good
 * point.
 *
 * A session is a thread: the {@link SessionOptions} settings it was opened
 * with are fixed for its lifetime and ride every turn, so `run` takes only
 * per-turn options. Changing a setting means a new session, or a fork of this
 * one to keep the history.
 *
 * `id` is the resume handle: `undefined` until the first turn reveals it,
 * then stable. Persist it anywhere and pass it back as
 * `agent.session({ resume: id })` to continue the conversation later, from
 * any process.
 *
 * `steer` and `respond` exist on ACP-mode sessions only
 * (`adapter.mode: "acp"`); check with `session.supports("steer")`, the same
 * gesture as {@link Agent.supports}.
 */
export interface Session<C extends Capabilities = Capabilities> {
  readonly agent: Agent<C>;
  /**
   * End the conversation and release whatever it holds. Turns still queued
   * reject; a closed session refuses new ones (`InvalidOptions`). Safe to call
   * twice. `id` stays valid, so the conversation can be resumed later.
   */
  close: () => Promise<void>;
  readonly id: string | undefined;
  /**
   * Answer a `permission-request` event: pass the id of one of the event's
   * {@link PermissionOption}s, or `"allow"`/`"deny"` to pick the first
   * option of the matching kind (`InvalidOptions` when none matches).
   */
  respond: (requestId: string, choice: string) => void;
  run: (prompt: string, opts?: SessionRunOptionsFor<C>) => Run;
  /** Inject guidance into the running turn. */
  steer: (text: string) => void;
  supports: (...keys: SessionKey[]) => boolean;
}
