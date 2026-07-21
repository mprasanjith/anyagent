import { AnyAgentError } from "../internal/errors.js";
import { ndjsonParser } from "../internal/ndjson.js";
import type {
  Adapter,
  AgentEvent,
  CapabilityTable,
  Invocation,
  OutputSource,
  RunOptions,
} from "../internal/types.js";

const CAPS: CapabilityTable = {
  cwd: "native",
  // MCP servers are `cline mcp` config, not a per-run flag.
  mcp: false,
  modelSelection: "native",
  // No `read` level: cline's plan mode still executes shell commands
  // (verified writing a file through run_commands), so it cannot honestly
  // stand in for `read`. Headless cline auto-approves every tool, which
  // makes `edit` and `auto` the same thing.
  permissionLevels: ["edit", "auto"],
  // `--id` resume is broken in cline's headless JSON mode (the prompt is
  // never accepted alongside it), so resume stays undeclared.
  sessionResume: false,
  streaming: "native",
  structuredOutput: "emulated",
  // cline's -s replaces the system prompt entirely; preamble emulation folds
  // the system prompt into the prompt text, preserving the append semantics
  // RunOptions.systemPrompt promises.
  systemPrompt: "emulated",
};

interface Ctx {
  text: string[];
  raw?: unknown;
}

// oxlint-disable-next-line typescript/no-explicit-any -- the CLI's JSON is dynamically shaped.
type Json = any;

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
      return undefined;
    }
    case "content_start": {
      if (ev.contentType === "tool") {
        return {
          input: ev.input,
          name: ev.toolName,
          raw: obj,
          type: "tool-call",
        };
      }
      if (ev.contentType === "text") {
        return undefined;
      }
      if (strict) {
        throw new AnyAgentError(
          "Parse",
          `unknown content type ${ev.contentType}`
        );
      }
      return undefined;
    }
    case "content_end": {
      if (ev.contentType === "tool") {
        return {
          name: ev.toolName,
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
      return undefined;
    }
    default: {
      if (strict) {
        throw new AnyAgentError("Parse", `unknown agent event ${ev.type}`);
      }
      return undefined;
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
      usage: u
        ? {
            costUsd: u.totalCost,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
          }
        : undefined,
    };
  },
  init: () => ({ text: [] }),
  map: (raw: unknown, ctx, strict) => {
    const obj = raw as Json;
    switch (obj.type) {
      case "hook_event": {
        return undefined;
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
        return u
          ? {
              raw: obj,
              type: "usage",
              usage: {
                costUsd: u.totalCost,
                inputTokens: u.inputTokens,
                outputTokens: u.outputTokens,
              },
            }
          : undefined;
      }
      default: {
        if (strict) {
          throw new AnyAgentError("Parse", `unknown event type ${obj.type}`);
        }
        return undefined;
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
  const level = opts.permission ?? "edit";
  if (level === "read") {
    throw new AnyAgentError(
      "UnsupportedCapability",
      'cline cannot honor permission "read"'
    );
  }
  // Auto-approval is cline's headless default; passing it explicitly keeps
  // the behavior pinned if that default ever changes.
  const args = ["--json", "--auto-approve", "true"];
  if (opts.model) {
    args.push("-m", opts.model);
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

/**
 * The adapter for Cline's CLI. Drives `cline --json --auto-approve true`,
 * mapping the `hook_event`/`agent_event`/`run_result` NDJSON stream onto
 * normalized events. Cline is BYOK: configure a provider once via
 * `cline auth -p <provider> -k <key>` (e.g. openrouter), or pass `-P`/`-k`
 * per run through `extraArgs`.
 *
 * ```ts
 * import { create } from "anyagent";
 * import { cline } from "anyagent/cline";
 *
 * const result = await create(cline()).run("summarize this repo");
 * ```
 *
 * Headless cline auto-approves every tool, so `edit` and `auto` are
 * equivalent and there is no `read` level (plan mode still executes
 * shell commands). Session resume is undeclared: `--id` is broken in headless
 * JSON mode upstream. System prompts have no append flag (`-s` replaces), so
 * the core emulates them by folding into the prompt. A failed run throws
 * `AnyAgentError` with cline's own message from `run_result`.
 */
export const cline = (): Adapter => ({
  buildInvocation,
  capabilities: CAPS,
  detection: {},
  meta: { bin: ["cline"], id: "cline", name: "Cline" },
  parse,
});
