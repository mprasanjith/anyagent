import { AnyAgentError } from "../internal/errors.js";
import { ndjsonParser } from "../internal/ndjson.js";
import type {
  Adapter,
  AgentEvent,
  CapabilityTable,
  Invocation,
  RunOptions,
  Usage,
} from "../internal/types.js";

const CAPS: CapabilityTable = {
  cwd: true,
  // Pi extends through its own extension system, not MCP.
  mcp: false,
  modelSelection: true,
  // Pi has no approval prompts at all, so `edit` and `auto` are the
  // same thing: the default toolset. `read` restricts the agent to the
  // `read` tool via --tools.
  permissionLevels: ["read", "edit", "auto"],
  sessionResume: true,
  streaming: true,
  structuredOutput: false,
  systemPrompt: true,
};

interface Ctx {
  text: string[];
  sessionId?: string;
  turnEnd?: unknown;
  usage: { input: number; output: number; cost: number; seen: boolean };
}

// oxlint-disable-next-line typescript/no-explicit-any -- the CLI's JSON is dynamically shaped.
type Json = any;

// Known assistantMessageEvent types; only text_delta becomes an event.
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

const mapUpdate = (obj: Json, ctx: Ctx, strict: boolean): AgentEvent | null => {
  const ev = obj.assistantMessageEvent ?? {};
  if (ev.type === "text_delta") {
    ctx.text.push(ev.delta);
    return { raw: obj, text: ev.delta, type: "text-delta" };
  }
  if (strict && !UPDATE_TYPES.has(ev.type)) {
    throw new AnyAgentError("Parse", `unknown update type ${ev.type}`);
  }
  return null;
};

const mapMessageEnd = (obj: Json, strict: boolean): AgentEvent[] | null => {
  const message = obj.message ?? {};
  switch (message.role) {
    // Text deltas were already streamed from message_update; only tool calls
    // surface here, once their arguments are complete.
    case "assistant": {
      const out: AgentEvent[] = [];
      for (const block of message.content ?? []) {
        if (block.type === "toolCall") {
          out.push({
            input: block.arguments,
            name: block.name,
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
          name: message.toolName,
          output: message.content,
          raw: obj,
          type: "tool-result",
        },
      ];
    }
    case "user": {
      return null;
    }
    default: {
      if (strict) {
        throw new AnyAgentError(
          "Parse",
          `unknown message role ${message.role}`
        );
      }
      return null;
    }
  }
};

const mapTurnEnd = (obj: Json, ctx: Ctx): AgentEvent | null => {
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
    return null;
  }
  ctx.usage.seen = true;
  ctx.usage.input += u.input ?? 0;
  ctx.usage.output += u.output ?? 0;
  ctx.usage.cost += u.cost?.total ?? 0;
  const usage: Usage = {
    costUsd: u.cost?.total,
    inputTokens: u.input,
    outputTokens: u.output,
  };
  return { raw: obj, type: "usage", usage };
};

const parse = ndjsonParser<Ctx>({
  finalize: (ctx) => ({
    events: [],
    // agent_end repeats the whole transcript; compose a small final payload
    // with the session id needed for `resume` and the last turn instead.
    raw: { sessionId: ctx.sessionId, turnEnd: ctx.turnEnd },
    text: ctx.text.join(""),
    usage: ctx.usage.seen
      ? {
          costUsd: ctx.usage.cost,
          inputTokens: ctx.usage.input,
          outputTokens: ctx.usage.output,
        }
      : undefined,
  }),
  init: () => ({
    text: [],
    usage: { cost: 0, input: 0, output: 0, seen: false },
  }),
  map: (raw: unknown, ctx, strict) => {
    const obj = raw as Json;
    switch (obj.type) {
      case "session": {
        ctx.sessionId = obj.id;
        return null;
      }
      case "agent_start":
      case "turn_start":
      case "message_start":
      case "tool_execution_start":
      case "tool_execution_end":
      case "agent_end": {
        return null;
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
        if (strict) {
          throw new AnyAgentError("Parse", `unknown event type ${obj.type}`);
        }
        return null;
      }
    }
  },
});

const buildInvocation = (prompt: string, opts: RunOptions): Invocation => {
  const args = ["--mode", "json", "-p"];
  if ((opts.permission ?? "edit") === "read") {
    // Pi has no approval prompts; `read` restricts the toolset instead.
    args.push("--tools", "read");
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  if (opts.resume) {
    // --session-id resumes the exact session, creating it if missing.
    args.push("--session-id", opts.resume);
  }
  // Pi takes the prompt as a positional; there is no stdin form. A prompt
  // larger than the OS argv limit needs agent.raw instead.
  args.push(prompt);
  return {
    args,
    command: "pi",
    cwd: opts.cwd,
    env: opts.env,
  };
};

/**
 * The adapter for Pi (`@earendil-works/pi-coding-agent`). Drives
 * `pi --mode json -p`, mapping the `session`/`turn_*`/`message_*` NDJSON
 * stream onto normalized events — Pi streams token-level text deltas, so
 * `text-delta` events are fine-grained. Pi is BYOK: pick the backend with
 * provider env vars (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, …) and pass
 * `model` as Pi's `provider/model` pattern (e.g.
 * `"openrouter/openai/gpt-4o-mini"`).
 *
 * ```ts
 * import { create } from "anyagent";
 * import { pi } from "anyagent/pi";
 *
 * const result = await create(pi()).run("summarize this repo");
 * ```
 *
 * Pi never prompts for approval, so `edit` and `auto` are equivalent
 * (the default toolset); `read` maps to `--tools read`. `resume` runs
 * `--session-id <id>`, where the id comes from `RunResult.raw.sessionId`.
 * Pi exits 0 even when a turn fails, so the adapter turns a `stopReason:
 * "error"` turn into an `AnyAgentError` instead of trusting the exit code.
 */
export const pi = (): Adapter => ({
  buildInvocation,
  capabilities: CAPS,
  detection: {},
  meta: { bin: ["pi"], id: "pi", name: "Pi" },
  parse,
});
