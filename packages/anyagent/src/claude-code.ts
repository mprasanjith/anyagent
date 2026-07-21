import { AnyAgentError } from "./errors.js";
import { ndjsonParser } from "./ndjson.js";
import type {
  Adapter,
  AgentEvent,
  AuthStatus,
  Capabilities,
  Invocation,
  RunOptions,
  SystemProbe,
  ToolName,
  Usage,
} from "./types.js";

const VERSION_REGEX = /(?<version>\d+\.\d+\.\d+)/u;

const CAPS = {
  authStatus: "native",
  cwd: "native",
  effort: "native",
  mcp: "native",
  modelListing: false,
  modelSelection: "native",
  readOnly: "native",
  reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  sessionResume: "native",
  streaming: "native",
  structuredOutput: "native",
  systemPrompt: "native",
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
// unattended mutations, but a mode alone fails open if upstream ever changes
// its semantics, so the mutating built-ins are also denied by name.
const READ_ONLY_DENY = "Bash,Edit,NotebookEdit,Write";

interface Ctx {
  raw?: unknown;
  sessionId?: string;
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
  // Under --json-schema the model answers through a StructuredOutput tool and
  // emits no text blocks; the run's authoritative JSON arrives only here. The
  // serialized form becomes the run's text — synthesized as a delta so the
  // deltas-concatenate-to-text invariant holds.
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

const authStatus = async (probe: SystemProbe): Promise<AuthStatus> => {
  let exec: { stdout: string; stderr: string; code: number };
  try {
    exec = await probe.exec("claude", ["auth", "status", "--json"]);
  } catch {
    return { state: "unknown" };
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(exec.stdout);
  } catch {
    return exec.code === 0
      ? { state: "unknown" }
      : { state: "unauthenticated" };
  }
  if (exec.code !== 0 || !parsed?.loggedIn) {
    return { raw: parsed, state: "unauthenticated" };
  }
  return {
    method: parsed.authMethod ?? parsed.subscriptionType,
    raw: parsed,
    state: "authenticated",
  };
};

/**
 * The adapter for the Claude Code CLI (`claude`). Everything on the
 * capabilities are native except model listing, which the CLI does not
 * offer: auth status, model selection, reasoning effort (`low` through
 * `max`), read-only runs, session resume, MCP servers, structured output,
 * and system-prompt append.
 *
 * ```ts
 * import { create } from "anyagent";
 * import { claudeCode } from "anyagent/claude-code";
 *
 * const result = await create(claudeCode()).run("summarize this repo");
 * ```
 */
export const claudeCode = (): Adapter<typeof CAPS> => ({
  authStatus,
  buildInvocation,
  capabilities: CAPS,
  detection: {
    versionCommand: ["--version"],
    versionRegex: VERSION_REGEX,
  },
  meta: { bin: ["claude"], id: "claude-code", name: "Claude Code" },
  parse,
});
