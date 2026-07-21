import { AnyAgentError } from "./errors.js";
import { ndjsonParser } from "./ndjson.js";
import type {
  Adapter,
  AgentEvent,
  CapabilityTable,
  Invocation,
  PermissionLevel,
  RunOptions,
  Usage,
} from "./types.js";

const CAPS: CapabilityTable = {
  cwd: "native",
  // MCP servers reach Codex only through `-c mcp_servers.*` config overrides,
  // which we have not verified against real output; use extraArgs or raw.
  mcp: false,
  modelSelection: "native",
  permissionLevels: ["read", "edit", "auto"],
  sessionResume: "native",
  streaming: "native",
  // Codex has a native `--output-schema` path, but it is unverified against
  // recorded real output, so core emulation applies until fixtures exist;
  // flipping to "native" is a recorded-fixture follow-up.
  structuredOutput: "emulated",
  // `codex exec` has no append-system-prompt flag; the core folds the system
  // prompt into the prompt text instead.
  systemPrompt: "emulated",
};

const SANDBOX_MODE: Record<PermissionLevel, string> = {
  auto: "danger-full-access",
  edit: "workspace-write",
  read: "read-only",
};

interface Ctx {
  text: string[];
  threadId?: string;
  turn?: unknown;
  usage?: Usage;
}

// oxlint-disable-next-line typescript/no-explicit-any -- the CLI's JSON is dynamically shaped.
type Json = any;

const usageFrom = (obj: Json): Usage | undefined => {
  const u = obj.usage;
  if (!u) {
    return undefined;
  }
  // Codex's input_tokens folds cache reads in; subtract to report uncached
  // input like the other adapters. Exact native accounting stays on raw.
  const cached =
    typeof u.cached_input_tokens === "number" ? u.cached_input_tokens : 0;
  return {
    inputTokens:
      typeof u.input_tokens === "number" ? u.input_tokens - cached : undefined,
    outputTokens: u.output_tokens,
  };
};

const mapItemStarted = (obj: Json, strict: boolean): AgentEvent | undefined => {
  const item = obj.item ?? {};
  switch (item.type) {
    case "command_execution": {
      return {
        input: item.command,
        name: "command_execution",
        raw: obj,
        type: "tool-call",
      };
    }
    case "file_change": {
      return {
        input: item.changes,
        name: "file_change",
        raw: obj,
        type: "tool-call",
      };
    }
    // In-progress messages carry no text yet; only item.completed counts, so
    // the answer is never double-counted.
    case "agent_message":
    case "reasoning":
    case "error": {
      return undefined;
    }
    default: {
      if (strict) {
        throw new AnyAgentError("Parse", `unknown item type ${item.type}`);
      }
      return undefined;
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
        name: "command_execution",
        output: item.aggregated_output,
        raw: obj,
        type: "tool-result",
      };
    }
    case "file_change": {
      return {
        name: "file_change",
        output: item.changes,
        raw: obj,
        type: "tool-result",
      };
    }
    // Reasoning has no normalized event; error items are advisory warnings —
    // fatal failures arrive as top-level `error`/`turn.failed` instead.
    case "reasoning":
    case "error": {
      return undefined;
    }
    default: {
      if (strict) {
        throw new AnyAgentError("Parse", `unknown item type ${item.type}`);
      }
      return undefined;
    }
  }
};

const parse = ndjsonParser<Ctx>({
  finalize: (ctx) => ({
    events: [],
    // Codex has no single final payload; compose one so the thread id needed
    // for `resume` is reachable alongside the native turn.completed event.
    raw: { threadId: ctx.threadId, turnCompleted: ctx.turn },
    text: ctx.text.join(""),
    usage: ctx.usage,
  }),
  init: () => ({ text: [] }),
  map: (raw: unknown, ctx, strict) => {
    const obj = raw as Json;
    switch (obj.type) {
      case "thread.started": {
        ctx.threadId = obj.thread_id;
        return undefined;
      }
      case "turn.started":
      case "item.updated": {
        return undefined;
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
        return ctx.usage ? { raw: obj, type: "usage", usage: ctx.usage } : undefined;
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
        return undefined;
      }
    }
  },
});

const buildInvocation = (prompt: string, opts: RunOptions): Invocation => {
  const level = opts.permission ?? "edit";
  const sandbox = SANDBOX_MODE[level];
  if (!sandbox) {
    throw new AnyAgentError(
      "UnsupportedCapability",
      `codex cannot honor permission "${level}"`
    );
  }
  // `codex exec resume` has no --sandbox flag, only `-c` config overrides, so
  // the resume form sets the sandbox through config. Either way the level is
  // always passed explicitly — exec defaults to read-only, which would
  // silently under-honor the SDK's `edit` default.
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

/**
 * The adapter for OpenAI's Codex CLI. Drives `codex exec --json` with the
 * prompt piped over stdin, mapping the thread→turn→item event stream onto
 * normalized events. Permission levels map onto `--sandbox`
 * (`read-only` / `workspace-write` / `danger-full-access`); `resume` runs
 * `codex exec resume <threadId>`, where the thread id comes from
 * `RunResult.raw.threadId` of a prior run.
 *
 * ```ts
 * import { create } from "anyagent";
 * import { codex } from "anyagent/codex";
 *
 * const result = await create(codex()).run("summarize this repo");
 * ```
 *
 * MCP servers are not supported on `codex exec`; Codex's `-c` config overrides
 * can reach them via `extraArgs` or `agent.raw`. System prompts have no native
 * flag, so the core emulates them by folding them into the prompt.
 */
export const codex = (): Adapter => ({
  buildInvocation,
  capabilities: CAPS,
  detection: {},
  meta: { bin: ["codex"], id: "codex", name: "Codex" },
  parse,
});
