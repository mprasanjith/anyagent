import { AnyAgentError } from "./errors.js";
import { ndjsonParser } from "./ndjson.js";
import type {
  Adapter,
  AgentEvent,
  AuthStatus,
  Capabilities,
  Invocation,
  OutputSource,
  RunOptions,
  SystemProbe,
  ToolName,
  Usage,
} from "./types.js";

const CAPS = {
  // Never exec for auth: cline's config subcommand needs a TTY headless.
  attachments: false,
  authStatus: "probed",
  cwd: "native",
  effort: "native",
  // MCP servers are `cline mcp` config, not a per-run flag.
  mcp: false,
  modelListing: false,
  modelSelection: "native",
  // Headless cline auto-approves every tool and plan mode still executes
  // shell commands (verified writing a file through run_commands), so
  // nothing-changes cannot be guaranteed.
  readOnly: false,
  reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
  // `--id` resume is broken in cline's headless JSON mode (the prompt is
  // never accepted alongside it), so resume stays undeclared.
  session: false,
  sessionFork: false,
  streaming: "native",
  structuredOutput: "emulated",
  // cline's -s replaces the system prompt entirely; preamble emulation folds
  // the system prompt into the prompt text, preserving the append semantics
  // RunOptions.systemPrompt promises.
  systemPrompt: "emulated",
} as const satisfies Capabilities;

interface Ctx {
  raw?: unknown;
  text: string[];
}

// biome-ignore lint/suspicious/noExplicitAny: the CLI's JSON is dynamically shaped.
type Json = any;

// Only the tool names verified in recorded output map to the shared
// vocabulary; anything else keeps its native name, per the ToolName contract.
const TOOL_NAMES: Record<string, ToolName> = {
  apply_patch: "edit",
  read_files: "read",
  run_commands: "bash",
};

const toolName = (native: string): ToolName => TOOL_NAMES[native] ?? native;

const mapUsage = (u: Json): Usage => ({
  cacheReadTokens: u.cacheReadTokens,
  cacheWriteTokens: u.cacheWriteTokens,
  costUsd: u.totalCost,
  inputTokens: u.inputTokens,
  outputTokens: u.outputTokens,
});

const mapAgentEvent = (
  obj: Json,
  ctx: Ctx,
  strict: boolean
): AgentEvent | undefined => {
  const ev = obj.event ?? {};
  switch (ev.type) {
    // Partial deltas and lifecycle markers carry no normalized event; text is
    // taken whole from content_end so the answer is never double-counted.
    // Per-iteration usage stays raw; run_result carries the run totals.
    // An error event is advisory here — run_result reports it fatally.
    case "iteration_start":
    case "iteration_end":
    case "content_delta":
    case "usage":
    case "done":
    case "error": {
      return;
    }
    case "content_start": {
      if (ev.contentType === "tool") {
        return {
          callId: ev.toolCallId,
          input: ev.input,
          name: toolName(ev.toolName),
          nativeName: ev.toolName,
          raw: obj,
          type: "tool-call",
        };
      }
      if (ev.contentType === "text") {
        return;
      }
      if (strict) {
        throw new AnyAgentError(
          "Parse",
          `unknown content type ${ev.contentType}`
        );
      }
      return;
    }
    case "content_end": {
      if (ev.contentType === "tool") {
        return {
          callId: ev.toolCallId,
          name: toolName(ev.toolName),
          nativeName: ev.toolName,
          output: ev.output,
          raw: obj,
          type: "tool-result",
        };
      }
      if (ev.contentType === "text") {
        ctx.text.push(ev.text);
        return { raw: obj, text: ev.text, type: "text-delta" };
      }
      if (strict) {
        throw new AnyAgentError(
          "Parse",
          `unknown content type ${ev.contentType}`
        );
      }
      return;
    }
    default: {
      if (strict) {
        throw new AnyAgentError("Parse", `unknown agent event ${ev.type}`);
      }
      return;
    }
  }
};

const innerParse = ndjsonParser<Ctx>({
  finalize: (ctx) => {
    const result = ctx.raw as Json;
    const u = result?.usage;
    return {
      events: [],
      raw: ctx.raw,
      text: ctx.text.join(""),
      usage: u ? mapUsage(u) : undefined,
    };
  },
  init: () => ({ text: [] }),
  map: (raw: unknown, ctx, strict) => {
    const obj = raw as Json;
    switch (obj.type) {
      case "hook_event": {
        return;
      }
      case "agent_event": {
        return mapAgentEvent(obj, ctx, strict);
      }
      case "run_result": {
        if (obj.finishReason !== "completed") {
          throw new AnyAgentError(
            "Invocation",
            `cline: ${obj.text ?? obj.finishReason ?? "run failed"}`,
            { raw: obj }
          );
        }
        ctx.raw = obj;
        const u = obj.usage;
        return u ? { raw: obj, type: "usage", usage: mapUsage(u) } : undefined;
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

// cline occasionally prints plain-text notices to stdout mid-stream (e.g.
// "AI SDK Warning System: ..."), which would break NDJSON parsing. Only
// lines that look like JSON objects reach the parser; the filter applies in
// strict mode too, because the notices are a known cline behavior, not a
// format drift.
const jsonLinesOnly = (source: OutputSource): OutputSource => ({
  ...source,
  async *lines() {
    for await (const line of source.lines()) {
      if (line.trimStart().startsWith("{")) {
        yield line;
      }
    }
  },
});

const parse: Adapter["parse"] = (source, opts) =>
  innerParse(jsonLinesOnly(source), opts);

const buildInvocation = (prompt: string, opts: RunOptions): Invocation => {
  // Auto-approval is cline's headless default; passing it explicitly keeps
  // the behavior pinned if that default ever changes. `readOnly: true` never
  // reaches here — the capability is declared false, so the core throws
  // before the invocation is built.
  const args = ["--json", "--auto-approve", "true"];
  if (opts.model) {
    args.push("-m", opts.model);
  }
  if (opts.effort) {
    args.push("--thinking", opts.effort);
  }
  // The prompt must be a positional: cline's headless mode does not read a
  // piped prompt reliably. A prompt larger than the OS argv limit needs
  // agent.raw instead. cline also misparses a single-word prompt as a
  // command name — an upstream quirk this adapter cannot mask.
  args.push(prompt);
  return {
    args,
    command: "cline",
    cwd: opts.cwd,
    env: opts.env,
  };
};

// Provider settings live at <data>/settings/providers.json. Precedence,
// live-verified on 3.0.46: CLINE_PROVIDER_SETTINGS_PATH names the exact
// file; CLINE_DATA_DIR is the data dir itself; CLINE_DIR keeps the data/
// level; then the default under the home directory. First existing file
// wins.
const providersPaths = (probe: SystemProbe): string[] => {
  const paths: string[] = [];
  if (probe.env.CLINE_PROVIDER_SETTINGS_PATH) {
    paths.push(probe.env.CLINE_PROVIDER_SETTINGS_PATH);
  }
  if (probe.env.CLINE_DATA_DIR) {
    paths.push(`${probe.env.CLINE_DATA_DIR}/settings/providers.json`);
  }
  if (probe.env.CLINE_DIR) {
    paths.push(`${probe.env.CLINE_DIR}/data/settings/providers.json`);
  }
  paths.push(`${probe.homedir()}/.cline/data/settings/providers.json`);
  return paths;
};

const authStatus = async (probe: SystemProbe): Promise<AuthStatus> => {
  // Candidates are read concurrently; precedence is decided by list order —
  // the first path with a readable file wins.
  const paths = providersPaths(probe);
  const bodies = await Promise.all(paths.map((p) => probe.readFile(p)));
  const index = bodies.findIndex((b) => b !== undefined);
  const body = bodies[index];
  if (body === undefined) {
    return { state: "unauthenticated" };
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { state: "unknown" };
  }
  const providers = Object.keys(parsed?.providers ?? {});
  return providers.length > 0
    ? { providers, state: "authenticated" }
    : { state: "unauthenticated" };
};

/**
 * The adapter for Cline's CLI (`cline`). Cline is BYOK: configure a provider once via
 * `cline auth -p <provider> -k <key>` (e.g. openrouter), or pass `-P`/`-k`
 * per run through `extraArgs`. `authStatus()` reports which providers are
 * configured, read from cline's provider settings.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { cline } from "anyagent-js/cline";
 *
 * const result = await create(cline()).run("summarize this repo");
 * ```
 *
 * Headless cline auto-approves every tool and cannot guarantee a read-only
 * run, so `readOnly: true` throws. Reasoning effort is native with a closed
 * vocabulary (`none` through `xhigh`). Session resume is undeclared: `--id`
 * is broken in headless JSON mode upstream, and no session id is revealed —
 * `RunResult.sessionId` stays absent. System prompts have no append flag
 * (`-s` replaces) and are emulated. A failed run throws `AnyAgentError` with
 * cline's own message.
 */
export const cline = (): Adapter<typeof CAPS> => ({
  acp: { command: ["cline", "--acp"] },
  authStatus,
  buildInvocation,
  capabilities: CAPS,
  detection: {},
  meta: { bin: ["cline"], id: "cline", name: "Cline" },
  parse,
});
