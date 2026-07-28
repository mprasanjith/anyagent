import { AnyAgentError } from "./errors.js";
import { ndjsonParser } from "./ndjson.js";
import type {
  AgentEvent,
  AuthStatus,
  Capabilities,
  Invocation,
  ModelInfo,
  RunOptions,
  StdoutAdapter,
  SystemProbe,
  Usage,
} from "./types.js";

const CAPS = {
  // Pure BYOK: credentials live in ~/.pi/agent/auth.json and provider env
  // vars, so the answer is a best-effort probe, not the CLI's own word.
  attachments: "native",
  authStatus: "probed",
  cwd: "native",
  effort: "native",
  // Pi extends through its own extension system, not MCP.
  mcp: false,
  modelListing: "native",
  modelSelection: "native",
  // Pi has no approval prompts; `--tools read` restricts the toolset itself,
  // so a read-only run is the CLI's own guarantee.
  readOnly: "native",
  reasoningEfforts: [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ],
  resume: "native",
  sessionFork: "native",
  streaming: "native",
  structuredOutput: "emulated",
  systemPrompt: "native",
} as const satisfies Capabilities;

interface Ctx {
  sessionId?: string;
  text: string[];
  turnEnd?: unknown;
  usage: {
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    input: number;
    output: number;
    reasoning: number;
    seen: boolean;
  };
}

// biome-ignore lint/suspicious/noExplicitAny: the CLI's JSON is dynamically shaped.
type Json = any;

// Known assistantMessageEvent types; only text_delta and thinking_delta
// become events.
const UPDATE_TYPES = new Set([
  "text_start",
  "text_delta",
  "text_end",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
]);

// Top-level stream types that carry nothing the normalized surface models.
// The named housekeeping types (compaction, auto-retry, settle, queue) are
// tolerated even under strict so a native flag cannot break the parser;
// genuinely unknown types still throw there — that is the drift canary.
const DROPPED_TYPES = new Set([
  "agent_start",
  "turn_start",
  "message_start",
  "tool_execution_start",
  "tool_execution_end",
  "agent_end",
  "agent_settled",
  "queue_update",
]);

const isDropped = (type: string): boolean =>
  DROPPED_TYPES.has(type) ||
  type.startsWith("compaction_") ||
  type.startsWith("auto_retry_");

const mapUpdate = (
  obj: Json,
  ctx: Ctx,
  strict: boolean
): AgentEvent | undefined => {
  const ev = obj.assistantMessageEvent ?? {};
  if (ev.type === "text_delta") {
    ctx.text.push(ev.delta);
    return { raw: obj, text: ev.delta, type: "text-delta" };
  }
  if (ev.type === "thinking_delta") {
    return { raw: obj, text: ev.delta, type: "reasoning-delta" };
  }
  if (strict && !UPDATE_TYPES.has(ev.type)) {
    throw new AnyAgentError("Parse", `unknown update type ${ev.type}`);
  }
};

const mapMessageEnd = (
  obj: Json,
  strict: boolean
): AgentEvent[] | undefined => {
  const message = obj.message ?? {};
  switch (message.role) {
    // Text deltas were already streamed from message_update; only tool calls
    // surface here, once their arguments are complete.
    case "assistant": {
      const out: AgentEvent[] = [];
      for (const block of message.content ?? []) {
        if (block.type === "toolCall") {
          out.push({
            callId: block.id,
            input: block.arguments,
            // Pi's built-in tool names (read, bash, edit, write) already
            // match the shared vocabulary; extension tools keep their own.
            name: block.name,
            nativeName: block.name,
            raw: obj,
            type: "tool-call",
          });
        } else if (
          strict &&
          block.type !== "text" &&
          block.type !== "thinking"
        ) {
          throw new AnyAgentError(
            "Parse",
            `unknown content block ${block.type}`
          );
        }
      }
      return out;
    }
    case "toolResult": {
      return [
        {
          callId: message.toolCallId,
          name: message.toolName,
          nativeName: message.toolName,
          output: message.content,
          raw: obj,
          type: "tool-result",
        },
      ];
    }
    case "user": {
      return;
    }
    default: {
      if (strict) {
        throw new AnyAgentError(
          "Parse",
          `unknown message role ${message.role}`
        );
      }
      return;
    }
  }
};

const mapTurnEnd = (obj: Json, ctx: Ctx): AgentEvent | undefined => {
  ctx.turnEnd = obj;
  const message = obj.message ?? {};
  // Pi keeps exit code 0 even when a turn fails, so the error must be read
  // from the stream: a failed turn carries stopReason "error".
  if (message.stopReason === "error") {
    throw new AnyAgentError(
      "Invocation",
      `pi: ${message.errorMessage ?? "turn failed"}`,
      { raw: obj }
    );
  }
  const u = message.usage;
  if (!u) {
    return;
  }
  ctx.usage.seen = true;
  ctx.usage.cacheRead += u.cacheRead ?? 0;
  ctx.usage.cacheWrite += u.cacheWrite ?? 0;
  ctx.usage.cost += u.cost?.total ?? 0;
  ctx.usage.input += u.input ?? 0;
  ctx.usage.output += u.output ?? 0;
  ctx.usage.reasoning += u.reasoning ?? 0;
  const usage: Usage = {
    cacheReadTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite,
    costUsd: u.cost?.total,
    inputTokens: u.input,
    outputTokens: u.output,
    reasoningTokens: u.reasoning,
  };
  return { raw: obj, type: "usage", usage };
};

const parse = ndjsonParser<Ctx>({
  finalize: (ctx) => ({
    events: [],
    // agent_end repeats the whole transcript; compose a small final payload
    // with the last turn instead.
    raw: { sessionId: ctx.sessionId, turnEnd: ctx.turnEnd },
    sessionId: ctx.sessionId,
    text: ctx.text.join(""),
    usage: ctx.usage.seen
      ? {
          cacheReadTokens: ctx.usage.cacheRead,
          cacheWriteTokens: ctx.usage.cacheWrite,
          costUsd: ctx.usage.cost,
          inputTokens: ctx.usage.input,
          outputTokens: ctx.usage.output,
          reasoningTokens: ctx.usage.reasoning,
        }
      : undefined,
  }),
  init: () => ({
    text: [],
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      seen: false,
    },
  }),
  map: (raw: unknown, ctx, strict) => {
    const obj = raw as Json;
    switch (obj.type) {
      case "session": {
        ctx.sessionId = obj.id;
        return { raw: obj, sessionId: obj.id, type: "session" };
      }
      case "message_update": {
        return mapUpdate(obj, ctx, strict);
      }
      case "message_end": {
        return mapMessageEnd(obj, strict);
      }
      case "turn_end": {
        return mapTurnEnd(obj, ctx);
      }
      case "error": {
        throw new AnyAgentError(
          "Invocation",
          `pi: ${obj.message ?? "unknown error"}`,
          { raw: obj }
        );
      }
      default: {
        if (isDropped(obj.type)) {
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
  const args = ["--mode", "json", "-p"];
  if (opts.readOnly) {
    args.push("--tools", "read");
  }
  if (opts.effort !== undefined) {
    // Pi spells the no-thinking level "off"; the shared vocabulary says
    // "none". Every other level matches Pi's own names.
    args.push("--thinking", opts.effort === "none" ? "off" : opts.effort);
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  if (opts.resume) {
    if (opts.forkSession) {
      // --fork branches the resumed session into a new one; it replaces
      // --session-id rather than joining it. forkSession only arrives with
      // resume.
      args.push("--fork", opts.resume);
    } else {
      // --session-id resumes the exact session, creating it if missing.
      args.push("--session-id", opts.resume);
    }
  }
  if (opts.attachments) {
    // Pi reads files from `@path` positionals (`pi @a.png "..."`); the prompt
    // itself still travels on stdin.
    for (const file of opts.attachments) {
      args.push(`@${file}`);
    }
  }
  return {
    args,
    command: "pi",
    cwd: opts.cwd,
    env: opts.env,
    // The prompt travels on stdin, so its size is never capped by the OS
    // argv limit.
    input: prompt,
  };
};

// Provider env vars Pi honors alongside its credential store, mapped to the
// provider each one authenticates.
const ENV_PROVIDERS: readonly (readonly [string, string])[] = [
  ["OPENROUTER_API_KEY", "openrouter"],
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["OPENAI_API_KEY", "openai"],
  ["GEMINI_API_KEY", "google"],
  ["GOOGLE_GENERATIVE_AI_API_KEY", "google"],
  ["XAI_API_KEY", "xai"],
  ["GROQ_API_KEY", "groq"],
  ["MISTRAL_API_KEY", "mistral"],
  ["DEEPSEEK_API_KEY", "deepseek"],
];

const authStatus = async (probe: SystemProbe): Promise<AuthStatus> => {
  const providers = new Set<string>();
  const body = await probe.readFile(`${probe.homedir()}/.pi/agent/auth.json`);
  if (body !== undefined) {
    try {
      const stored = JSON.parse(body) as Record<string, unknown>;
      for (const provider of Object.keys(stored)) {
        providers.add(provider);
      }
    } catch {
      // A corrupt auth.json proves nothing; the env vars still count.
    }
  }
  for (const [envVar, provider] of ENV_PROVIDERS) {
    if (probe.env[envVar]) {
      providers.add(provider);
    }
  }
  return {
    providers: [...providers],
    state: providers.size > 0 ? "authenticated" : "unauthenticated",
  };
};

const COLUMN_GAP = /\s+/;

const listModels = async (probe: SystemProbe): Promise<ModelInfo[]> => {
  const { code, stderr, stdout } = await probe.exec("pi", ["--list-models"]);
  if (code !== 0) {
    throw new AnyAgentError(
      "Invocation",
      `pi --list-models exited with code ${code}`,
      { argv: ["pi", "--list-models"], stderr }
    );
  }
  // A whitespace-aligned table whose first row is the header:
  // provider  model  context  max-out  thinking  images
  const models: ModelInfo[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const [provider, model] = line.trim().split(COLUMN_GAP);
    if (provider && model) {
      models.push({ id: `${provider}/${model}`, provider, raw: line });
    }
  }
  return models;
};

/**
 * The adapter for the Pi CLI (`pi`). Pi streams token-level text deltas, so
 * `text-delta` events are fine-grained. Pi is BYOK: pick the backend with
 * provider env vars (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, …) and pass
 * `model` as Pi's `provider/model` pattern (e.g.
 * `"openrouter/openai/gpt-4o-mini"`).
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { pi } from "anyagent-js/pi";
 *
 * const result = await create(pi()).run("summarize this repo");
 * ```
 *
 * `models()` lists this machine's usable models: Pi filters the list to the
 * providers with credentials configured, and every returned id is valid
 * verbatim as `model`. `resume` continues a session under the id from
 * `RunResult.sessionId`. A failed turn throws `AnyAgentError` even though
 * Pi's process exits 0.
 */
export const pi = (): StdoutAdapter<typeof CAPS> => ({
  authStatus,
  buildInvocation,
  capabilities: CAPS,
  detection: {},
  listModels,
  meta: { bin: ["pi"], id: "pi", name: "Pi" },
  mode: "stdout",
  parse,
});
