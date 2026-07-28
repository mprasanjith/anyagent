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
  ToolName,
  Usage,
} from "./types.js";

const CAPS = {
  // No status subcommand exists and the OAuth token is not stored in a
  // readable file under ~/.gemini, so auth is inferred from `agy models`
  // output — a heuristic, hence "probed".
  attachments: false,
  authStatus: "probed",
  cwd: "native",
  effort: "native",
  // MCP tools exist inside agy (call_mcp_tool), but no per-run flag or
  // config surface for attaching servers was found on the CLI.
  mcp: false,
  modelListing: "native",
  modelSelection: "native",
  // `--mode plan` refuses workspace writes (verified live: a forced
  // write_to_file to the cwd was denied and no file appeared), but agy's
  // always-allowed internal scratch dirs stay writable — a live plan-mode run
  // created a real file there and reported success. That cannot guarantee
  // "nothing on the machine changes", so readOnly is declared false; plan
  // mode stays reachable via `extraArgs: ["--mode", "plan"]`.
  readOnly: false,
  reasoningEfforts: ["low", "medium", "high"],
  session: "stdout",
  sessionFork: false,
  streaming: "native",
  structuredOutput: "emulated",
  // No append-system-prompt flag exists; the core folds the system prompt
  // into the prompt text instead.
  systemPrompt: "emulated",
} as const satisfies Capabilities;

const TOOL_NAMES: Record<string, ToolName> = {
  find_by_name: "glob",
  grep_search: "grep",
  multi_replace_file_content: "edit",
  replace_file_content: "edit",
  run_command: "bash",
  search_web: "webSearch",
  sed_file: "edit",
  view_file: "read",
  write_to_file: "write",
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

const usageFrom = (u: Json): Usage | undefined => {
  if (!u) {
    return;
  }
  // agy reports no cache line items; total_tokens stays on raw.
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    reasoningTokens: num(u.thinking_tokens),
  };
};

const mapToolStep = (
  obj: Json,
  step: Json,
  strict: boolean
): AgentEvent | undefined => {
  const info = step.tool_info ?? {};
  const nativeName = typeof step.tool_name === "string" ? step.tool_name : "";
  const callId =
    step.step_index === undefined ? undefined : String(step.step_index);
  switch (step.state) {
    case "ACTIVE": {
      return {
        callId,
        input: info.parameters,
        name: toolName(nativeName),
        nativeName,
        raw: obj,
        type: "tool-call",
      };
    }
    case "DONE": {
      return {
        callId,
        name: toolName(nativeName),
        nativeName,
        output: info.output,
        raw: obj,
        type: "tool-result",
      };
    }
    // A denied permission surfaces as a tool step in state ERROR while the
    // run continues to a SUCCESS result (verified live), so it maps to an
    // advisory tool-result carrying the error, never a thrown failure.
    case "ERROR": {
      return {
        callId,
        name: toolName(nativeName),
        nativeName,
        output: info.error,
        raw: obj,
        type: "tool-result",
      };
    }
    default: {
      if (strict) {
        throw new AnyAgentError("Parse", `unknown step state ${step.state}`);
      }
      return;
    }
  }
};

const mapStepUpdate = (
  obj: Json,
  ctx: Ctx,
  strict: boolean
): AgentEvent | undefined => {
  const step = obj.step_update ?? {};
  switch (step.step_type) {
    case "agent_response": {
      // Both ACTIVE and DONE updates carry text_delta pieces; together they
      // concatenate to the result's `response` (verified against real runs).
      if (typeof step.text_delta !== "string") {
        return;
      }
      ctx.text.push(step.text_delta);
      return { raw: obj, text: step.text_delta, type: "text-delta" };
    }
    case "tool": {
      return mapToolStep(obj, step, strict);
    }
    // Housekeeping steps observed in real output; error_message is advisory —
    // fatal failures arrive as a non-SUCCESS result status instead.
    case "checkpoint":
    case "error_message":
    case "unknown":
    case "user_input": {
      return;
    }
    default: {
      if (strict) {
        throw new AnyAgentError("Parse", `unknown step type ${step.step_type}`);
      }
      return;
    }
  }
};

const mapResult = (obj: Json, ctx: Ctx): AgentEvent | undefined => {
  const r = obj.result ?? {};
  ctx.raw = obj;
  ctx.sessionId =
    typeof r.conversation_id === "string" ? r.conversation_id : ctx.sessionId;
  // agy exits 0 even for a CANCELED run, so the result status — never the
  // exit code — is the authority on whether the run succeeded.
  if (r.status !== "SUCCESS") {
    const detail =
      typeof r.error === "string" && r.error ? r.error : String(r.status);
    throw new AnyAgentError("Invocation", `antigravity: ${detail}`, {
      raw: obj,
    });
  }
  ctx.usage = usageFrom(r.usage);
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
    switch (obj.event) {
      case "init": {
        if (typeof obj.conversation_id !== "string" || ctx.sessionId) {
          return;
        }
        ctx.sessionId = obj.conversation_id;
        return { raw: obj, sessionId: obj.conversation_id, type: "session" };
      }
      case "step_update": {
        return mapStepUpdate(obj, ctx, strict);
      }
      case "result": {
        return mapResult(obj, ctx);
      }
      default: {
        if (strict) {
          throw new AnyAgentError("Parse", `unknown event ${obj.event}`);
        }
        return;
      }
    }
  },
});

const buildInvocation = (prompt: string, opts: RunOptions): Invocation => {
  // The prompt must be `-p`'s value: agy ignores piped stdin in stdout mode
  // (verified live — the prompt on stdin was dropped and the next flag was
  // read as the prompt), so a prompt larger than the OS argv limit cannot be
  // passed.
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    // In default headless mode every permission ask is auto-denied (or, per
    // upstream builds, self-cancels the run), silently hobbling the agent;
    // skipping permissions is the only deterministic full-autonomy mode.
    "--dangerously-skip-permissions",
  ];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.effort) {
    args.push("--effort", opts.effort);
  }
  if (opts.resume) {
    args.push("--conversation", opts.resume);
  }
  return { args, command: "agy", cwd: opts.cwd, env: opts.env };
};

// A model id is a bare token; sign-in notices contain spaces or URLs and
// never match, which is what separates a listing from a login prompt.
const MODEL_ID_REGEX = /^[a-z0-9][\w.-]*$/i;

const modelIds = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => MODEL_ID_REGEX.test(line));

const authStatus = async (probe: SystemProbe): Promise<AuthStatus> => {
  let res: { stdout: string; stderr: string; code: number };
  try {
    res = await probe.exec("agy", ["models"]);
  } catch {
    return { state: "unknown" };
  }
  if (res.code !== 0 || modelIds(res.stdout).length === 0) {
    return { state: "unauthenticated" };
  }
  return { method: "oauth", state: "authenticated" };
};

const listModels = async (probe: SystemProbe): Promise<ModelInfo[]> => {
  let res: { stdout: string; stderr: string; code: number };
  try {
    res = await probe.exec("agy", ["models"]);
  } catch (error) {
    throw AnyAgentError.wrap(error);
  }
  if (res.code !== 0) {
    throw new AnyAgentError("Invocation", `agy models exited ${res.code}`, {
      stderr: res.stderr,
    });
  }
  const ids = modelIds(res.stdout);
  if (ids.length === 0) {
    // Signed out, `agy models` prints a sign-in notice with exit 0.
    throw new AnyAgentError(
      "Invocation",
      "agy models listed no models (not signed in?)",
      { raw: res.stdout }
    );
  }
  return ids.map((id) => ({ id }));
};

/**
 * The adapter for the Antigravity CLI (`agy`). A default run has full
 * full autonomy; there is no read-only run (`readOnly: true` throws),
 * and Antigravity's plan mode remains reachable via
 * `extraArgs: ["--mode", "plan"]`. `resume` continues a prior conversation
 * using the id from {@link RunResult.sessionId}; `effort` accepts `low`,
 * `medium`, or `high`. `models()` lists Antigravity's cross-vendor catalog,
 * each id usable verbatim as `model`. System prompts and structured output
 * are emulated; MCP is unavailable.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { antigravity } from "anyagent-js/antigravity";
 *
 * const result = await create(antigravity()).run("summarize this repo");
 * ```
 */
export const antigravity = (): StdoutAdapter<typeof CAPS> => ({
  authStatus,
  buildInvocation,
  capabilities: CAPS,
  detection: {},
  listModels,
  meta: { bin: ["agy"], id: "antigravity", name: "Antigravity" },
  mode: "stdout",
  parse,
});
