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
  attachments: "native",
  authStatus: "native",
  cwd: "native",
  // No reasoningEfforts list on purpose: Codex's effort vocabulary is open
  // and per-model — models() reports each model's accepted values, and the
  // CLI itself is the authority on validity.
  effort: "native",
  // MCP servers reach Codex only through `-c mcp_servers.*` config overrides,
  // which we have not verified against real output; use extraArgs or raw.
  mcp: false,
  modelListing: "native",
  modelSelection: "native",
  readOnly: "native",
  session: "stdout",
  sessionFork: false,
  streaming: "native",
  // Deliberately emulated: `--output-schema` speaks a restricted JSON Schema
  // dialect (every field required, `format`/`pattern` ignored), so native
  // acceptance would depend on the caller's schema.
  structuredOutput: "emulated",
  // `codex exec` has no append-system-prompt flag; the core folds the system
  // prompt into the prompt text instead.
  systemPrompt: "emulated",
} as const satisfies Capabilities;

interface Ctx {
  text: string[];
  threadId?: string;
  turn?: unknown;
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
  // Codex's native accounting folds cache reads into input_tokens and
  // reasoning into output_tokens; `Usage` keeps the provider's accounting,
  // so cacheReadTokens/reasoningTokens are the folded shares, not additions.
  return {
    cacheReadTokens: num(u.cached_input_tokens),
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    reasoningTokens: num(u.reasoning_output_tokens),
  };
};

const mapItemStarted = (obj: Json, strict: boolean): AgentEvent | undefined => {
  const item = obj.item ?? {};
  switch (item.type) {
    case "command_execution": {
      return {
        callId: str(item.id),
        input: item.command,
        name: "bash",
        nativeName: "command_execution",
        raw: obj,
        type: "tool-call",
      };
    }
    case "file_change": {
      return {
        callId: str(item.id),
        input: item.changes,
        name: "file_change",
        nativeName: "file_change",
        raw: obj,
        type: "tool-call",
      };
    }
    // In-progress messages carry no text yet; only item.completed counts, so
    // the answer is never double-counted.
    case "agent_message":
    case "reasoning":
    case "error": {
      return;
    }
    default: {
      if (strict) {
        throw new AnyAgentError("Parse", `unknown item type ${item.type}`);
      }
      return;
    }
  }
};

const mapItemCompleted = (
  obj: Json,
  ctx: Ctx,
  strict: boolean
): AgentEvent | undefined => {
  const item = obj.item ?? {};
  switch (item.type) {
    case "agent_message": {
      ctx.text.push(item.text);
      return { raw: obj, text: item.text, type: "text-delta" };
    }
    case "command_execution": {
      return {
        callId: str(item.id),
        name: "bash",
        nativeName: "command_execution",
        output: item.aggregated_output,
        raw: obj,
        type: "tool-result",
      };
    }
    case "file_change": {
      return {
        callId: str(item.id),
        name: "file_change",
        nativeName: "file_change",
        output: item.changes,
        raw: obj,
        type: "tool-result",
      };
    }
    // Reasoning items are tolerated but never appeared in recorded real
    // output (only reasoning_output_tokens did), so no reasoning-delta is
    // synthesized from unobserved shapes. Error items are advisory warnings —
    // fatal failures arrive as top-level `error`/`turn.failed` instead.
    case "reasoning":
    case "error": {
      return;
    }
    default: {
      if (strict) {
        throw new AnyAgentError("Parse", `unknown item type ${item.type}`);
      }
      return;
    }
  }
};

const parse = ndjsonParser<Ctx>({
  finalize: (ctx) => ({
    events: [],
    // Codex has no single final payload; compose one so the native
    // turn.completed event stays reachable next to the thread id.
    raw: { threadId: ctx.threadId, turnCompleted: ctx.turn },
    sessionId: ctx.threadId,
    text: ctx.text.join(""),
    usage: ctx.usage,
  }),
  init: () => ({ text: [] }),
  map: (raw: unknown, ctx, strict) => {
    const obj = raw as Json;
    switch (obj.type) {
      case "thread.started": {
        // The thread id is the resume handle; surface it once, early.
        if (typeof obj.thread_id !== "string" || ctx.threadId) {
          return;
        }
        ctx.threadId = obj.thread_id;
        return { raw: obj, sessionId: obj.thread_id, type: "session" };
      }
      case "turn.started":
      case "item.updated": {
        return;
      }
      case "item.started": {
        return mapItemStarted(obj, strict);
      }
      case "item.completed": {
        return mapItemCompleted(obj, ctx, strict);
      }
      case "turn.completed": {
        ctx.usage = usageFrom(obj);
        ctx.turn = obj;
        return ctx.usage
          ? { raw: obj, type: "usage", usage: ctx.usage }
          : undefined;
      }
      case "turn.failed": {
        throw new AnyAgentError(
          "Invocation",
          `codex: ${obj.error?.message ?? "turn failed"}`,
          { raw: obj }
        );
      }
      case "error": {
        throw new AnyAgentError(
          "Invocation",
          `codex: ${obj.message ?? "unknown error"}`,
          { raw: obj }
        );
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

const buildInvocation = (prompt: string, opts: RunOptions): Invocation => {
  const sandbox = opts.readOnly ? "read-only" : "danger-full-access";
  // `codex exec resume` has no --sandbox flag, only `-c` config overrides, so
  // the resume form sets the sandbox through config. Either way the sandbox
  // is always passed explicitly — exec defaults to read-only, which would
  // silently under-honor the SDK's full-autonomy default.
  const args = opts.resume
    ? [
        "exec",
        "resume",
        opts.resume,
        "--json",
        "-c",
        `sandbox_mode="${sandbox}"`,
      ]
    : ["exec", "--json", "--sandbox", sandbox];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.effort !== undefined) {
    // Verbatim pass-through; the CLI is the authority on per-model validity.
    args.push("-c", `model_reasoning_effort="${opts.effort}"`);
  }
  if (opts.attachments?.length) {
    // `-i, --image <FILE>...` takes every path on one occurrence; clap does
    // not swallow the trailing `-` stdin positional into the list (verified
    // live on codex 0.144.6), so the images stay before it.
    args.push("-i", ...opts.attachments);
  }
  // The `-` positional makes Codex read the prompt from stdin, so a large
  // prompt never hits the OS argv size limit.
  args.push("-");
  return {
    args,
    command: "codex",
    cwd: opts.cwd,
    env: opts.env,
    input: prompt,
  };
};

const AUTH_METHODS: readonly (readonly [RegExp, string])[] = [
  [/chatgpt/i, "chatgpt"],
  [/api key/i, "api-key"],
];

const authStatus = async (probe: SystemProbe): Promise<AuthStatus> => {
  let res: { stdout: string; stderr: string; code: number };
  try {
    res = await probe.exec("codex", ["login", "status"]);
  } catch {
    return { state: "unknown" };
  }
  // Exit 0 when logged in, nonzero when not; the verdict text ("Logged in
  // using ChatGPT") prints to stderr, so both streams are read.
  const text = `${res.stdout}\n${res.stderr}`.trim();
  if (res.code !== 0) {
    return { state: "unauthenticated" };
  }
  const method = AUTH_METHODS.find(([re]) => re.test(text))?.[1];
  return { method, state: "authenticated" };
};

const effortsOf = (model: Json): string[] | undefined => {
  const levels = model.supported_reasoning_levels;
  if (!Array.isArray(levels)) {
    return;
  }
  const efforts = levels
    .map((level: Json) => level?.effort)
    .filter((effort: unknown): effort is string => typeof effort === "string");
  return efforts.length ? efforts : undefined;
};

const listModels = async (probe: SystemProbe): Promise<ModelInfo[]> => {
  let res: { stdout: string; stderr: string; code: number };
  try {
    res = await probe.exec("codex", ["debug", "models"]);
  } catch (error) {
    throw AnyAgentError.wrap(error);
  }
  if (res.code !== 0) {
    throw new AnyAgentError(
      "Invocation",
      `codex debug models exited ${res.code}`,
      { stderr: res.stderr }
    );
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: AnyAgentError carries the original on `raw`, its documented cause field.
    throw new AnyAgentError("Parse", "codex debug models did not print JSON", {
      raw: error,
    });
  }
  const models: Json[] = Array.isArray(parsed?.models) ? parsed.models : [];
  return (
    models
      // `visibility: "hide"` marks internal models Codex's own picker omits.
      .filter((model) => model.visibility !== "hide")
      .filter((model) => typeof model.slug === "string")
      .map((model) => ({
        id: model.slug as string,
        raw: model,
        reasoningEfforts: effortsOf(model),
      }))
  );
};

/**
 * The adapter for the Codex CLI (`codex`). A default run has full
 * autonomy (Codex's `danger-full-access` sandbox); `readOnly: true` confines
 * it to the `read-only` sandbox instead. `resume` continues a prior thread
 * using the id from {@link RunResult.sessionId}; `effort` passes through to
 * the CLI, whose accepted values are per-model — `models()` lists them.
 * `authStatus()` asks `codex login status`.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { codex } from "anyagent-js/codex";
 *
 * const result = await create(codex()).run("summarize this repo");
 * ```
 *
 * MCP servers are not supported on headless Codex; Codex's `-c` config
 * overrides can reach them via `extraArgs` or `agent.raw`. System prompts
 * have no native flag and are emulated. Structured output stays emulated on
 * purpose: Codex's `--output-schema` accepts only a restricted schema
 * dialect, so whether it worked would depend on your schema.
 */
export const codex = (): StdoutAdapter<typeof CAPS> => ({
  authStatus,
  buildInvocation,
  capabilities: CAPS,
  detection: {},
  listModels,
  meta: { bin: ["codex"], id: "codex", name: "Codex" },
  mode: "stdout",
  parse,
});
