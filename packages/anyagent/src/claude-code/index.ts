import { AnyAgentError } from "../internal/errors.js";
import { ndjsonParser } from "../internal/ndjson.js";
import type {
  Adapter,
  AgentEvent,
  CapabilityTable,
  Invocation,
  PermissionLevel,
  RunOptions,
  Usage,
} from "../internal/types.js";

const CAPS: CapabilityTable = {
  cwd: true,
  mcp: true,
  modelSelection: true,
  permissionLevels: ["read", "edit", "auto"],
  sessionResume: true,
  streaming: true,
  structuredOutput: true,
  systemPrompt: true,
};

const PERMISSION_MODE: Record<PermissionLevel, string> = {
  auto: "bypassPermissions",
  edit: "acceptEdits",
  read: "default",
};

interface Ctx {
  text: string[];
  toolNames: Map<string, string>;
  usage?: Usage;
  raw?: unknown;
}

// oxlint-disable-next-line typescript/no-explicit-any -- the CLI's JSON is dynamically shaped.
type Json = any;

const usageFrom = (obj: Json): Usage | undefined => {
  const u = obj.usage;
  if (!u && obj.total_cost_usd === undefined) {
    return undefined;
  }
  return {
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
        input: block.input,
        name: block.name,
        raw: block,
        type: "tool-call",
      });
    } else if (
      block.type === "thinking" ||
      block.type === "redacted_thinking"
    ) {
      // Reasoning blocks carry no normalized event; not an error under strict.
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
      out.push({
        name: ctx.toolNames.get(block.tool_use_id) ?? "unknown",
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

const parse = ndjsonParser<Ctx>({
  finalize: (ctx) => ({
    events: [],
    raw: ctx.raw,
    text: ctx.text.join(""),
    usage: ctx.usage,
  }),
  init: () => ({ text: [], toolNames: new Map() }),
  map: (raw: unknown, ctx, strict) => {
    const obj = raw as Json;
    switch (obj.type) {
      // System init, hook notifications, and rate-limit notices carry no
      // normalized event; they are known types, so strict mode ignores them too.
      case "system":
      case "rate_limit_event": {
        return null;
      }
      case "assistant": {
        return mapAssistant(obj, ctx, strict);
      }
      case "user": {
        return mapUser(obj, ctx, strict);
      }
      case "result": {
        ctx.usage = usageFrom(obj);
        ctx.raw = obj;
        if (obj.is_error) {
          const detail =
            typeof obj.result === "string" && obj.result
              ? obj.result
              : (obj.subtype ?? "unknown error");
          throw new AnyAgentError("Invocation", `claude-code: ${detail}`, {
            raw: obj,
          });
        }
        return ctx.usage ? { raw: obj, type: "usage", usage: ctx.usage } : null;
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
  const level = opts.permission ?? "edit";
  const mode = PERMISSION_MODE[level];
  if (!mode) {
    throw new AnyAgentError(
      "UnsupportedCapability",
      `claude-code cannot honor permission "${level}"`
    );
  }
  // The prompt travels via stdin (documented headless pattern) rather than as
  // a positional arg, so a large prompt never hits the OS argv size limit.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    mode,
  ];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  if (opts.resume) {
    args.push("--resume", opts.resume);
  }
  if (opts.mcp) {
    args.push("--mcp-config", JSON.stringify({ mcpServers: opts.mcp }));
  }
  return {
    args,
    command: "claude",
    cwd: opts.cwd,
    env: opts.env,
    input: prompt,
  };
};

/**
 * The adapter for Anthropic's Claude Code CLI. Drives `claude -p` in
 * streaming-JSON mode with the prompt piped over stdin, and declares the full
 * capability table: all three permission levels, model selection, session
 * resume, MCP servers, system prompts, and `cwd`.
 *
 * ```ts
 * import { create } from "anyagent";
 * import { claudeCode } from "anyagent/claude-code";
 *
 * const result = await create(claudeCode()).run("summarize this repo");
 * ```
 *
 * Also the reference implementation — mirror its shape when writing a new
 * adapter.
 */
export const claudeCode = (): Adapter => ({
  buildInvocation,
  capabilities: CAPS,
  detection: {
    versionCommand: ["--version"],
    versionRegex: /(?<version>\d+\.\d+\.\d+)/u,
  },
  meta: { bin: ["claude"], id: "claude-code", name: "Claude Code" },
  parse,
});
