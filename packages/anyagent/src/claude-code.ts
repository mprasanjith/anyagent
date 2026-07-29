import { AnyAgentError } from "./errors.js";
import { ndjsonParser } from "./ndjson.js";
import type {
  AgentEvent,
  AuthStatus,
  BillingMode,
  Capabilities,
  Invocation,
  ModelInfo,
  RunOptions,
  StdoutAdapter,
  SystemProbe,
  ToolName,
  Usage,
  UsageStatus,
  UsageStatusOptions,
  UsageWindow,
} from "./types.js";

const VERSION_REGEX = /(?<version>\d+\.\d+\.\d+)/u;

const CAPS = {
  attachments: false,
  authStatus: "native",
  cwd: "native",
  effort: "native",
  mcp: "native",
  // The CLI has no list command; the list is the documented alias
  // vocabulary plus what the CLI's own cache file adds — a hint, not the
  // CLI's word.
  modelListing: "probed",
  modelSelection: "native",
  readOnly: "native",
  reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  resume: "native",
  sessionFork: "native",
  streaming: "native",
  structuredOutput: "native",
  systemPrompt: "native",
  // Read from the CLI's cached usage snapshot, refreshed only when Claude
  // Code itself runs — check `asOf`.
  usageStatus: "probed",
} as const satisfies Capabilities;

const TOOL_NAMES: Record<string, ToolName> = {
  Bash: "bash",
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
  Read: "read",
  WebSearch: "webSearch",
  Write: "write",
};

const toolName = (nativeName: string): ToolName =>
  TOOL_NAMES[nativeName] ?? nativeName;

// Belt and braces for readOnly: `--permission-mode manual` already denies
// autonomous mutations, but a mode alone fails open if upstream ever changes
// its semantics, so the mutating built-ins are also denied by name.
const READ_ONLY_DENY = "Bash,Edit,NotebookEdit,Write";

interface Ctx {
  raw?: unknown;
  sessionId?: string;
  structured?: unknown;
  text: string[];
  toolNames: Map<string, string>;
  usage?: Usage;
}

// biome-ignore lint/suspicious/noExplicitAny: the CLI's JSON is dynamically shaped.
type Json = any;

const usageFrom = (obj: Json): Usage | undefined => {
  const u = obj.usage;
  if (!u && obj.total_cost_usd === undefined) {
    return;
  }
  return {
    cacheReadTokens: u?.cache_read_input_tokens,
    cacheWriteTokens: u?.cache_creation_input_tokens,
    costUsd: obj.total_cost_usd,
    inputTokens: u?.input_tokens,
    outputTokens: u?.output_tokens,
  };
};

const mapAssistant = (obj: Json, ctx: Ctx, strict: boolean): AgentEvent[] => {
  const out: AgentEvent[] = [];
  for (const block of obj.message?.content ?? []) {
    if (block.type === "text") {
      ctx.text.push(block.text);
      out.push({ raw: block, text: block.text, type: "text-delta" });
    } else if (block.type === "tool_use") {
      ctx.toolNames.set(block.id, block.name);
      out.push({
        callId: block.id,
        input: block.input,
        name: toolName(block.name),
        nativeName: block.name,
        raw: block,
        type: "tool-call",
      });
    } else if (block.type === "thinking") {
      out.push({ raw: block, text: block.thinking, type: "reasoning-delta" });
    } else if (block.type === "redacted_thinking") {
      // Redacted thinking carries no readable text; known, so not a strict error.
    } else if (strict) {
      throw new AnyAgentError("Parse", `unknown content block ${block.type}`);
    }
  }
  return out;
};

const mapUser = (obj: Json, ctx: Ctx, strict: boolean): AgentEvent[] => {
  const out: AgentEvent[] = [];
  for (const block of obj.message?.content ?? []) {
    if (block.type === "tool_result") {
      const nativeName = ctx.toolNames.get(block.tool_use_id) ?? "unknown";
      out.push({
        callId: block.tool_use_id,
        name: toolName(nativeName),
        nativeName,
        output: block.content,
        raw: block,
        type: "tool-result",
      });
    } else if (block.type === "text") {
      // CLI-injected steering (e.g. the structured-output enforcement nudge),
      // not agent output; known, so not a strict error.
    } else if (strict) {
      throw new AnyAgentError("Parse", `unknown content block ${block.type}`);
    }
  }
  return out;
};

const mapResult = (obj: Json, ctx: Ctx): AgentEvent[] => {
  ctx.usage = usageFrom(obj);
  ctx.raw = obj;
  ctx.sessionId = obj.session_id ?? ctx.sessionId;
  if (obj.is_error) {
    const detail =
      typeof obj.result === "string" && obj.result
        ? obj.result
        : (obj.subtype ?? "unknown error");
    throw new AnyAgentError("Invocation", `claude-code: ${detail}`, {
      raw: obj,
    });
  }
  const out: AgentEvent[] = [];
  // Under --json-schema the model may stream prose before answering through
  // the StructuredOutput tool; the authoritative JSON arrives only here. With
  // no streamed text, its serialized form becomes the run's text — synthesized
  // as a delta so the deltas-concatenate-to-text invariant holds.
  ctx.structured = obj.structured_output;
  if (obj.structured_output !== undefined && ctx.text.length === 0) {
    const text = JSON.stringify(obj.structured_output);
    ctx.text.push(text);
    out.push({ raw: obj, text, type: "text-delta" });
  }
  if (ctx.usage) {
    out.push({ raw: obj, type: "usage", usage: ctx.usage });
  }
  return out;
};

const parse = ndjsonParser<Ctx>({
  finalize: (ctx) => ({
    events: [],
    raw: ctx.raw,
    sessionId: ctx.sessionId,
    structuredOutput: ctx.structured,
    text: ctx.text.join(""),
    usage: ctx.usage,
  }),
  init: () => ({ text: [], toolNames: new Map() }),
  map: (raw: unknown, ctx, strict) => {
    const obj = raw as Json;
    switch (obj.type) {
      case "system": {
        // At most one session event per stream, even if the CLI re-inits.
        if (
          obj.subtype === "init" &&
          typeof obj.session_id === "string" &&
          ctx.sessionId === undefined
        ) {
          ctx.sessionId = obj.session_id;
          return { raw: obj, sessionId: obj.session_id, type: "session" };
        }
        // Other system subtypes (hooks, thinking_tokens, …) carry no
        // normalized event; known, so strict mode ignores them too.
        return;
      }
      case "rate_limit_event":
      case "stream_event":
      case "prompt_suggestion": {
        return;
      }
      case "assistant": {
        return mapAssistant(obj, ctx, strict);
      }
      case "user": {
        return mapUser(obj, ctx, strict);
      }
      case "result": {
        return mapResult(obj, ctx);
      }
      default: {
        // Hook notifications are named-known types; genuinely unknown types
        // stay the strict-mode drift canary.
        if (typeof obj.type === "string" && obj.type.startsWith("hook_")) {
          return;
        }
        if (strict) {
          throw new AnyAgentError("Parse", `unknown event type ${obj.type}`);
        }
        return;
      }
    }
  },
});

const buildInvocation = (prompt: string, opts: RunOptions): Invocation => {
  // The prompt travels via stdin (documented headless pattern) rather than as
  // a positional arg, so a large prompt never hits the OS argv size limit.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    opts.readOnly ? "manual" : "bypassPermissions",
  ];
  if (opts.readOnly) {
    args.push("--disallowedTools", READ_ONLY_DENY);
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.effort) {
    args.push("--effort", opts.effort);
  }
  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  if (opts.resume) {
    args.push("--resume", opts.resume);
    // --fork-session resumes into a fresh session id instead of continuing
    // the old one; core only ever pairs forkSession with resume.
    if (opts.forkSession) {
      args.push("--fork-session");
    }
  }
  if (opts.mcp) {
    // --strict-mcp-config keeps user-config servers out, so the option means
    // "exactly these servers", matching every other adapter.
    args.push(
      "--mcp-config",
      JSON.stringify({ mcpServers: opts.mcp }),
      "--strict-mcp-config"
    );
  }
  if (opts.schema) {
    args.push("--json-schema", JSON.stringify(opts.schema));
  }
  return {
    args,
    command: "claude",
    cwd: opts.cwd,
    env: opts.env,
    input: prompt,
  };
};

// Asserted from the CLI's own report: a subscription tier means the rolling
// windows meter the account; a non-first-party apiProvider (bedrock, vertex,
// foundry) is metered infrastructure. Anything else stays unknown rather
// than guessed.
const billingOf = (parsed: Json): BillingMode => {
  if (typeof parsed?.subscriptionType === "string") {
    return "subscription";
  }
  if (
    typeof parsed?.apiProvider === "string" &&
    parsed.apiProvider !== "firstParty"
  ) {
    return "api-key";
  }
  return "unknown";
};

const authStatus = async (probe: SystemProbe): Promise<AuthStatus> => {
  let exec: { stdout: string; stderr: string; code: number };
  try {
    exec = await probe.exec("claude", ["auth", "status", "--json"]);
  } catch {
    return { billing: "unknown", state: "unknown" };
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(exec.stdout);
  } catch {
    return exec.code === 0
      ? { billing: "unknown", state: "unknown" }
      : { billing: "unknown", state: "unauthenticated" };
  }
  if (exec.code !== 0 || !parsed?.loggedIn) {
    return { billing: "unknown", state: "unauthenticated" };
  }
  return {
    billing: billingOf(parsed),
    method: parsed.authMethod ?? parsed.subscriptionType,
    state: "authenticated",
  };
};

// The documented alias vocabulary (code.claude.com/docs/en/model-config),
// each valid verbatim as `--model`. `default` is excluded — the docs call it
// "not itself a model alias". Aliases resolve per account and drift with
// releases, which is why modelListing is "probed", not "native".
const MODEL_ALIASES = [
  "fable",
  "best",
  "opus",
  "sonnet",
  "haiku",
  "opus[1m]",
  "sonnet[1m]",
  "opusplan",
] as const;

// The model-bucket families the scoped usage windows name; display labels
// lowercase onto these (the CLI itself matches buckets the same way).
const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;

const CLAUDE_JSON = (probe: SystemProbe): string =>
  `${probe.homedir()}/.claude.json`;

const readClaudeJson = async (probe: SystemProbe): Promise<Json> => {
  const body = await probe.readFile(CLAUDE_JSON(probe));
  if (body === undefined) {
    return;
  }
  try {
    return JSON.parse(body);
  } catch {
    // A corrupt cache proves nothing; discovery degrades, never throws here.
  }
};

const listModels = async (probe: SystemProbe): Promise<ModelInfo[]> => {
  const models: ModelInfo[] = MODEL_ALIASES.map((id) => ({
    id,
    provider: "anthropic",
  }));
  // The CLI's own cache adds org-specific entries the docs table can't know
  // (e.g. `claude-fable-5[1m]` behind a "Fable" label).
  const cached = (await readClaudeJson(probe))?.additionalModelOptionsCache;
  if (Array.isArray(cached)) {
    for (const entry of cached) {
      if (
        typeof entry?.value === "string" &&
        !models.some((m) => m.id === entry.value)
      ) {
        models.push({ id: entry.value, provider: "anthropic", raw: entry });
      }
    }
  }
  return models;
};

const BRACKET_SUFFIX = /\[.*\]$/u;

// The family a model string belongs to, for bucket membership: strips any
// `[…]` override suffix and matches the family names. `opusplan` runs opus
// AND sonnet, so no single family can be asserted for it; two family names
// in one id is likewise no assertion.
const familyOf = (model: string): string | undefined => {
  const bare = model.toLowerCase().replace(BRACKET_SUFFIX, "");
  if (bare === "opusplan") {
    return;
  }
  const matches = FAMILIES.filter((family) => bare.includes(family));
  return matches.length === 1 ? matches[0] : undefined;
};

const windowOf = (limit: Json, cached: Json): UsageWindow | undefined => {
  if (typeof limit?.kind !== "string" || typeof limit?.percent !== "number") {
    return;
  }
  const window: UsageWindow = {
    label: limit.kind,
    usedPercent: limit.percent,
  };
  const resetsAt = Date.parse(limit.resets_at);
  if (!Number.isNaN(resetsAt)) {
    window.resetsAt = new Date(resetsAt);
  }
  const scope = limit.scope?.model?.display_name;
  if (typeof scope === "string") {
    window.modelScope = scope;
    // The alias join: a display label that lowercases onto a documented
    // family alias is valid verbatim as `model`; the cache join upgrades it
    // to the fully-qualified form when the label matches. Unknown labels
    // leave `model` absent — never guessed.
    const family = FAMILIES.find((f) => f === scope.toLowerCase());
    const entry = Array.isArray(cached)
      ? cached.find((c: Json) => c?.label === scope)
      : undefined;
    const model = typeof entry?.value === "string" ? entry.value : family;
    if (model) {
      window.model = model;
    }
  }
  return window;
};

// A scoped window is dropped only when both the requested model's family and
// the window's bucket family are known and differ — exclusion requires
// assertion, so an unrecognized model keeps every window.
const bindsModel = (window: UsageWindow, model: string): boolean => {
  if (window.modelScope === undefined) {
    return true;
  }
  const requested = familyOf(model);
  const bucket = familyOf(window.modelScope);
  if (requested === undefined || bucket === undefined) {
    return true;
  }
  return requested === bucket;
};

// `severity: "normal"` is the CLI's own all-clear; a spent window reports
// 100%. Between the two, any other severity the CLI asserts maps to
// near-limit — the vocabulary beyond "normal" is unobserved, so it is
// trusted as a warning rather than interpreted.
const stateOf = (
  windows: UsageWindow[],
  limits: Json[]
): UsageStatus["state"] => {
  if (windows.length === 0) {
    return "unknown";
  }
  if (windows.some((w) => (w.usedPercent ?? 0) >= 100)) {
    return "exhausted";
  }
  const severities = limits
    .filter((l) => windows.some((w) => w.label === l?.kind))
    .map((l) => l?.severity);
  if (severities.some((s) => typeof s === "string" && s !== "normal")) {
    return "near-limit";
  }
  return "ok";
};

const usageStatus = async (
  probe: SystemProbe,
  opts: UsageStatusOptions
): Promise<UsageStatus> => {
  const parsed = await readClaudeJson(probe);
  const cached = parsed?.cachedUsageUtilization;
  const limits: Json[] = Array.isArray(cached?.utilization?.limits)
    ? cached.utilization.limits
    : [];
  const all = limits
    .map((limit) => windowOf(limit, parsed?.additionalModelOptionsCache))
    .filter((w): w is UsageWindow => w !== undefined);
  const windows =
    opts.model === undefined
      ? all
      : all.filter((w) => bindsModel(w, opts.model as string));
  const status: UsageStatus = { state: stateOf(windows, limits) };
  if (windows.length > 0) {
    status.windows = windows;
  }
  if (typeof cached?.fetchedAtMs === "number") {
    status.asOf = new Date(cached.fetchedAtMs);
  }
  return status;
};

/**
 * The adapter for the Claude Code CLI (`claude`). Everything on the
 * capabilities is native except two probed discoveries: `models()` lists
 * the documented alias vocabulary (`fable`, `opus`, `sonnet[1m]`, …) plus
 * the CLI's own cached org-specific entries, and `usageStatus()` reads the
 * CLI's cached rolling-window snapshot — 5-hour, weekly, and model-scoped
 * buckets, with `asOf` carrying the cache's age. Native elsewhere: auth
 * status, model selection, reasoning effort (`low` through `max`),
 * read-only runs, session resume, MCP servers, structured output, and
 * system-prompt append.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { claudeCode } from "anyagent-js/claude-code";
 *
 * const result = await create(claudeCode()).run("summarize this repo");
 * ```
 */
export const claudeCode = (): StdoutAdapter<typeof CAPS> => ({
  authStatus,
  buildInvocation,
  capabilities: CAPS,
  detection: {
    versionCommand: ["--version"],
    versionRegex: VERSION_REGEX,
  },
  listModels,
  meta: { bin: ["claude"], id: "claude-code", name: "Claude Code" },
  mode: "stdout",
  parse,
  usageStatus,
});
