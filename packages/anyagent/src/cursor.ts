import { AnyAgentError } from "./errors.js";
import { ndjsonParser } from "./ndjson.js";
import type {
  Adapter,
  AgentEvent,
  AuthStatus,
  Capabilities,
  Invocation,
  ModelInfo,
  RunOptions,
  SystemProbe,
  ToolName,
  Usage,
} from "./types.js";

const CAPS = {
  attachments: false,
  authStatus: "native",
  cwd: "native",
  // No reasoningEfforts list on purpose: effort rides in the model id's
  // bracket overrides, whose accepted values are per-model — the CLI itself
  // is the authority on validity.
  effort: "native",
  // MCP servers are config-file territory (`agent mcp`); no per-run flag.
  mcp: false,
  modelListing: "native",
  modelSelection: "native",
  readOnly: "native",
  // Native ACP tier, gated on a recorded real transcript (sessions.md §6 M-2):
  // test/fixtures/acp/cursor.jsonl — initialize on protocolVersion 1, a session
  // id, an agent_message_chunk streaming "pong", and stopReason end_turn.
  session: "native",
  sessionFork: false,
  streaming: "native",
  structuredOutput: "emulated",
  // No append-system-prompt flag; the core folds the system prompt into the
  // prompt text instead.
  systemPrompt: "emulated",
} as const satisfies Capabilities;

// Cursor wraps each tool call in a oneof-style envelope: `tool_call` carries
// exactly one `<tool>ToolCall` key next to housekeeping fields. That key is
// the native tool name; the shared-vocabulary tools map onto it here and
// everything else keeps the native key.
const TOOL_NAMES: Record<string, ToolName> = {
  editToolCall: "edit",
  readToolCall: "read",
  shellToolCall: "bash",
  writeToolCall: "write",
};

const toolName = (nativeName: string): ToolName =>
  TOOL_NAMES[nativeName] ?? nativeName;

interface Ctx {
  raw?: unknown;
  sessionId?: string;
  text: string[];
  usage?: Usage;
}

// biome-ignore lint/suspicious/noExplicitAny: the CLI's JSON is dynamically shaped.
type Json = any;

const num = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

const usageFrom = (obj: Json): Usage | undefined => {
  const u = obj.usage;
  if (!u) {
    return;
  }
  // Native camelCase accounting; cache reads/writes are separate line items.
  // No cost and no reasoning tokens are reported.
  return {
    cacheReadTokens: num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cacheWriteTokens),
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
  };
};

const mapAssistant = (obj: Json, ctx: Ctx, strict: boolean): AgentEvent[] => {
  const out: AgentEvent[] = [];
  for (const block of obj.message?.content ?? []) {
    if (block.type === "text") {
      ctx.text.push(block.text);
      out.push({ raw: obj, text: block.text, type: "text-delta" });
    } else if (strict) {
      throw new AnyAgentError("Parse", `unknown content block ${block.type}`);
    }
  }
  return out;
};

const mapThinking = (obj: Json, strict: boolean): AgentEvent | undefined => {
  if (obj.subtype === "delta") {
    return { raw: obj, text: obj.text ?? "", type: "reasoning-delta" };
  }
  // `completed` closes a thinking block and carries no text.
  if (obj.subtype === "completed") {
    return;
  }
  if (strict) {
    throw new AnyAgentError("Parse", `unknown thinking subtype ${obj.subtype}`);
  }
};

const mapToolCall = (obj: Json, strict: boolean): AgentEvent | undefined => {
  const envelope = obj.tool_call ?? {};
  // `toolCallId` also ends in an uppercase-led suffix, so the match is on the
  // exact "ToolCall" tail, which only the oneof key has.
  const nativeName = Object.keys(envelope).find((key) =>
    key.endsWith("ToolCall")
  );
  if (!nativeName) {
    if (strict) {
      throw new AnyAgentError("Parse", "tool_call without a *ToolCall key");
    }
    return;
  }
  const call = envelope[nativeName];
  const base = {
    callId: str(obj.call_id),
    name: toolName(nativeName),
    nativeName,
    raw: obj,
  };
  switch (obj.subtype) {
    case "started": {
      return { ...base, input: call?.args, type: "tool-call" };
    }
    case "completed": {
      return { ...base, output: call?.result, type: "tool-result" };
    }
    default: {
      if (strict) {
        throw new AnyAgentError(
          "Parse",
          `unknown tool_call subtype ${obj.subtype}`
        );
      }
      return;
    }
  }
};

const mapResult = (obj: Json, ctx: Ctx): AgentEvent | undefined => {
  ctx.raw = obj;
  ctx.sessionId = str(obj.session_id) ?? ctx.sessionId;
  if (obj.is_error) {
    const detail =
      typeof obj.result === "string" && obj.result
        ? obj.result
        : (obj.subtype ?? "unknown error");
    throw new AnyAgentError("Invocation", `cursor: ${detail}`, { raw: obj });
  }
  ctx.usage = usageFrom(obj);
  return ctx.usage ? { raw: obj, type: "usage", usage: ctx.usage } : undefined;
};

const parse = ndjsonParser<Ctx>({
  finalize: (ctx) => ({
    events: [],
    raw: ctx.raw,
    sessionId: ctx.sessionId,
    text: ctx.text.join(""),
    usage: ctx.usage,
  }),
  init: () => ({ text: [] }),
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
        return;
      }
      // `user` is the CLI echoing the prompt back; no normalized event.
      case "user": {
        return;
      }
      case "thinking": {
        return mapThinking(obj, strict);
      }
      case "assistant": {
        return mapAssistant(obj, ctx, strict);
      }
      case "tool_call": {
        return mapToolCall(obj, strict);
      }
      case "result": {
        return mapResult(obj, ctx);
      }
      default: {
        if (strict) {
          throw new AnyAgentError("Parse", `unknown event type ${obj.type}`);
        }
        return;
      }
    }
  },
});

// Effort's only surface is the bracket-override vocabulary inside the model
// id (there is no standalone flag), so it compiles into the model string; a
// caller-supplied bracket list gains effort as one more override.
const modelWithEffort = (opts: RunOptions): string | undefined => {
  if (opts.effort === undefined) {
    return opts.model;
  }
  if (opts.model === undefined) {
    throw new AnyAgentError(
      "InvalidOptions",
      "cursor: effort is a bracket override on the model id, so it requires model"
    );
  }
  return opts.model.endsWith("]")
    ? `${opts.model.slice(0, -1)},effort=${opts.effort}]`
    : `${opts.model}[effort=${opts.effort}]`;
};

const buildInvocation = (prompt: string, opts: RunOptions): Invocation => {
  // `--trust` always: a headless run otherwise stalls on the workspace-trust
  // prompt, which nothing in run() could answer.
  const args = ["-p", "--output-format", "stream-json", "--trust"];
  if (opts.readOnly) {
    // Plan mode is enforced read-only (live-verified: writes are refused,
    // exit 0, no file), so the force flag must not ride along.
    args.push("--mode", "plan");
  } else {
    // Without --force, print mode only *proposes* edits — it would silently
    // break the full-autonomy contract.
    args.push("--force");
  }
  const model = modelWithEffort(opts);
  if (model) {
    args.push("--model", model);
  }
  if (opts.resume) {
    args.push("--resume", opts.resume);
  }
  // The prompt travels via stdin so a large one never hits the OS argv limit.
  return {
    args,
    command: "agent",
    cwd: opts.cwd,
    env: opts.env,
    input: prompt,
  };
};

const authStatus = async (probe: SystemProbe): Promise<AuthStatus> => {
  let res: { stdout: string; stderr: string; code: number };
  try {
    res = await probe.exec("agent", ["status", "--format", "json"]);
  } catch {
    return { state: "unknown" };
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return res.code === 0 ? { state: "unknown" } : { state: "unauthenticated" };
  }
  if (res.code !== 0 || parsed?.isAuthenticated !== true) {
    return { state: "unauthenticated" };
  }
  return { state: "authenticated" };
};

// One model per `<id> - <label>` line; the header and the trailing tip line
// contain no ` - ` separator, so the shape alone filters them out.
const MODEL_LINE = /^(?<id>\S+) - \S.*$/u;

const listModels = async (probe: SystemProbe): Promise<ModelInfo[]> => {
  let res: { stdout: string; stderr: string; code: number };
  try {
    res = await probe.exec("agent", ["--list-models"]);
  } catch (error) {
    throw AnyAgentError.wrap(error);
  }
  if (res.code !== 0) {
    throw new AnyAgentError(
      "Invocation",
      `agent --list-models exited ${res.code}`,
      { argv: ["agent", "--list-models"], stderr: res.stderr }
    );
  }
  const models: ModelInfo[] = [];
  for (const line of res.stdout.split("\n")) {
    const match = MODEL_LINE.exec(line.trim());
    const id = match?.groups?.id;
    if (id) {
      models.push({ id, raw: match[0] });
    }
  }
  if (models.length === 0) {
    throw new AnyAgentError("Parse", "agent --list-models listed no models", {
      raw: res.stdout,
    });
  }
  return models;
};

/**
 * The adapter for the Cursor CLI, detected as the `agent` binary (legacy
 * `cursor-agent` also resolves). A default run has full autonomy;
 * `readOnly: true` confines it to Cursor's enforced plan mode. `model` takes
 * any id from `models()`, including bracket overrides like
 * `"claude-opus-4-8[context=1m,effort=high]"`; `effort` composes into those
 * brackets and therefore requires `model`. `resume` continues a prior chat
 * using the id from {@link RunResult.sessionId}. `authStatus()` asks
 * `agent status`; `models()` asks `agent --list-models`.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { cursor } from "anyagent-js/cursor";
 *
 * const result = await create(cursor()).run("summarize this repo");
 * ```
 *
 * System prompts and structured output are emulated: the CLI has no
 * append-system-prompt or schema flag. MCP servers are not supported per-run;
 * Cursor manages them through `agent mcp` configuration.
 */
export const cursor = (): Adapter<typeof CAPS> => ({
  acp: {
    command: ["agent", "acp"],
    // Cursor also advertises `session/set_mode`; the config option is the one
    // channel it shares with the rest of the live tier.
    readOnly: { configId: "mode", value: "plan" },
    settings: ({ effort, model }) => {
      const value = modelWithEffort({ effort, model });
      return { configOptions: value ? [{ configId: "model", value }] : [] };
    },
  },
  authStatus,
  buildInvocation,
  capabilities: CAPS,
  detection: {},
  listModels,
  meta: { bin: ["agent", "cursor-agent"], id: "cursor", name: "Cursor" },
  parse,
});
