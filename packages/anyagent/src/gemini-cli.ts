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

const CAPS = {
  // Credentials live in ~/.gemini files, provider env vars, or the OS
  // keychain, so the answer is a best-effort probe, not the CLI's own word.
  attachments: false,
  authStatus: "probed",
  cwd: "native",
  effort: false,
  mcp: false,
  // No listing surface: `--list-sessions` exists, models do not.
  modelListing: false,
  modelSelection: "native",
  // Headless `--approval-mode default` never registers the mutating tools
  // (write_file / replace / run_shell_command return tool_not_registered),
  // so a read-only run is structurally the CLI's own guarantee. Plan mode is
  // NOT used: headless, `exit_plan_mode` self-approves and the agent then
  // writes freely (verified live on 0.46).
  readOnly: "native",
  // Native ACP tier, gated on a recorded real transcript (sessions.md §6 M-2):
  // test/fixtures/acp/gemini-cli.jsonl — initialize on protocolVersion 1, a
  // session id, an agent_message_chunk streaming "pong", stopReason end_turn.
  // Surprise vs the ledger: this build of gemini advertises `loadSession: true`,
  // so the mixed-tier fallback (which triggers when it is absent) never fires —
  // resume attempts real ACP session/load, still broken upstream (#15502).
  session: "native",
  sessionFork: false,
  streaming: "native",
  structuredOutput: "emulated",
  // No append-system-prompt flag; GEMINI_SYSTEM_MD replaces the built-in
  // prompt rather than extending it, so the core folds the text in instead.
  systemPrompt: "emulated",
} as const satisfies Capabilities;

const TOOL_NAMES: Record<string, ToolName> = {
  glob: "glob",
  google_web_search: "webSearch",
  grep_search: "grep",
  read_file: "read",
  replace: "edit",
  run_shell_command: "bash",
  search_file_content: "grep",
  write_file: "write",
};

const toolName = (nativeName: string): ToolName =>
  TOOL_NAMES[nativeName] ?? nativeName;

interface Ctx {
  raw?: unknown;
  sessionId?: string;
  text: string[];
  toolNames: Map<string, string>;
  usage?: Usage;
}

// biome-ignore lint/suspicious/noExplicitAny: the CLI's JSON is dynamically shaped.
type Json = any;

const mapMessage = (
  obj: Json,
  ctx: Ctx,
  strict: boolean
): AgentEvent | undefined => {
  if (obj.role === "assistant") {
    const text = typeof obj.content === "string" ? obj.content : "";
    ctx.text.push(text);
    return { raw: obj, text, type: "text-delta" };
  }
  if (obj.role === "user") {
    // The stream echoes the prompt back as a user message; nothing to relay.
    return;
  }
  if (strict) {
    throw new AnyAgentError("Parse", `unknown message role ${obj.role}`);
  }
};

const mapResult = (obj: Json, ctx: Ctx): AgentEvent | undefined => {
  ctx.raw = obj;
  // The CLI also exits nonzero on failure, but throwing at the result line
  // surfaces the agent's own message instead of a bare exit code.
  if (obj.status !== "success") {
    throw new AnyAgentError(
      "Invocation",
      `gemini-cli: ${obj.error?.message ?? obj.status}`,
      { raw: obj }
    );
  }
  const { stats } = obj;
  if (!stats) {
    return;
  }
  ctx.usage = {
    // `cached` counts prompt tokens served from cache; per-model splits
    // remain on the event's raw payload.
    cacheReadTokens: stats.cached,
    inputTokens: stats.input_tokens,
    outputTokens: stats.output_tokens,
  };
  return { raw: obj, type: "usage", usage: ctx.usage };
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
      case "init": {
        if (typeof obj.session_id === "string" && ctx.sessionId === undefined) {
          ctx.sessionId = obj.session_id;
          return { raw: obj, sessionId: obj.session_id, type: "session" };
        }
        return;
      }
      case "message": {
        return mapMessage(obj, ctx, strict);
      }
      case "tool_use": {
        ctx.toolNames.set(obj.tool_id, obj.tool_name);
        return {
          callId: obj.tool_id,
          input: obj.parameters,
          name: toolName(obj.tool_name),
          nativeName: obj.tool_name,
          raw: obj,
          type: "tool-call",
        };
      }
      case "tool_result": {
        const nativeName = ctx.toolNames.get(obj.tool_id) ?? "unknown";
        return {
          callId: obj.tool_id,
          name: toolName(nativeName),
          nativeName,
          output: obj.output,
          raw: obj,
          type: "tool-result",
        };
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

const buildInvocation = (prompt: string, opts: RunOptions): Invocation => {
  // The prompt travels on stdin: an empty -p keeps headless mode on, and the
  // CLI composes stdin ahead of the (empty) -p text into one user message,
  // so prompt size is never capped by the OS argv limit.
  const args = [
    "-p",
    "",
    "--output-format",
    "stream-json",
    // An untrusted cwd exits 55 before doing anything; headless runs always
    // bypass the workspace-trust gate.
    "--skip-trust",
    "--approval-mode",
    opts.readOnly ? "default" : "yolo",
  ];
  if (opts.model) {
    args.push("-m", opts.model);
  }
  if (opts.resume) {
    args.push("--resume", opts.resume);
  }
  return {
    args,
    command: "gemini",
    cwd: opts.cwd,
    env: opts.env,
    input: prompt,
  };
};

const authStatus = async (probe: SystemProbe): Promise<AuthStatus> => {
  const home = probe.homedir();
  const oauth = await probe.readFile(`${home}/.gemini/oauth_creds.json`);
  if (oauth !== undefined) {
    return { method: "oauth", state: "authenticated" };
  }
  if (probe.env.GEMINI_API_KEY || probe.env.GOOGLE_API_KEY) {
    return { method: "api-key", state: "authenticated" };
  }
  // A selected auth type with no visible credentials means the key lives
  // somewhere the probe cannot read (the OS keychain, a .env file the CLI
  // discovers itself) — "unknown" is the honest answer, not a denial.
  const settings = await probe.readFile(`${home}/.gemini/settings.json`);
  if (settings !== undefined) {
    try {
      const parsed = JSON.parse(settings) as Json;
      const selected = parsed?.security?.auth?.selectedType;
      if (typeof selected === "string" && selected.length > 0) {
        return { method: selected, state: "unknown" };
      }
    } catch {
      // A corrupt settings file proves nothing either way.
    }
  }
  return { state: "unauthenticated" };
};

/**
 * The adapter for the Gemini CLI (`gemini`). Runs are headless with the
 * yolo approval mode by default; `readOnly: true` switches to a mode whose
 * toolset carries no write or shell tools at all. `model` passes through in
 * Gemini's own vocabulary (pin one — the CLI's automatic routing can spend
 * minutes on trivial prompts), and `resume` continues the session whose id
 * arrived on `RunResult.sessionId`. System prompt and structured output are
 * emulated; usage reports cache reads via the stream's `cached` counter.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { geminiCli } from "anyagent-js/gemini-cli";
 *
 * const result = await create(geminiCli()).run("summarize this repo");
 * ```
 */
export const geminiCli = (): Adapter<typeof CAPS> => ({
  acp: { command: ["gemini", "--acp"] },
  authStatus,
  buildInvocation,
  capabilities: CAPS,
  detection: {},
  meta: { bin: ["gemini"], id: "gemini-cli", name: "Gemini CLI" },
  parse,
});
