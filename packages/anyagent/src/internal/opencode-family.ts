import { AnyAgentError } from "../errors.js";
import { ndjsonParser } from "../ndjson.js";
import type {
  Adapter,
  AdapterMeta,
  AgentEvent,
  CapabilityTable,
  Invocation,
  RunOptions,
  Usage,
} from "../types.js";

/**
 * Shared implementation for opencode and its fork Kilo Code. Both CLIs expose
 * the same `run --format json` surface and emit the same
 * `step_start`/`text`/`tool_use`/`step_finish` event stream — verified
 * separately against real output of each. Only the binary name and identity
 * differ, so each adapter passes its own meta here.
 */

const CAPS: CapabilityTable = {
  cwd: "native",
  // MCP servers are a config-file concern (opencode.json / agent files); there
  // is no per-run flag to map.
  mcp: false,
  modelSelection: "native",
  // No `read` level: permissions are config-file driven, and a denied
  // permission in a non-interactive run can hang waiting for an approval
  // that never comes. `edit` is the CLI's own default behavior; `auto`
  // adds --auto.
  permissionLevels: ["edit", "auto"],
  sessionResume: "native",
  streaming: "native",
  structuredOutput: "emulated",
  // No per-run append-system-prompt flag (system prompts are config-file /
  // agent-file concerns); the core folds the system prompt into the prompt.
  systemPrompt: "emulated",
};

interface Ctx {
  text: string[];
  sessionId?: string;
  stepFinish?: unknown;
  usage: { input: number; output: number; cost: number; seen: boolean };
}

// oxlint-disable-next-line typescript/no-explicit-any -- the CLI's JSON is dynamically shaped.
type Json = any;

const mapToolUse = (obj: Json, strict: boolean): AgentEvent[] | undefined => {
  const part = obj.part ?? {};
  const state = part.state ?? {};
  switch (state.status) {
    // JSON mode emits tool parts in a terminal state: input and output arrive
    // together, so one raw event produces the call and its result.
    case "completed": {
      return [
        { input: state.input, name: part.tool, raw: obj, type: "tool-call" },
        {
          name: part.tool,
          output: state.output,
          raw: obj,
          type: "tool-result",
        },
      ];
    }
    case "error": {
      return [
        { input: state.input, name: part.tool, raw: obj, type: "tool-call" },
        { name: part.tool, output: state.error, raw: obj, type: "tool-result" },
      ];
    }
    default: {
      if (strict) {
        throw new AnyAgentError("Parse", `unknown tool state ${state.status}`);
      }
      return undefined;
    }
  }
};

const mapStepFinish = (obj: Json, ctx: Ctx): AgentEvent | undefined => {
  ctx.sessionId ??= obj.sessionID;
  ctx.stepFinish = obj;
  const tokens = obj.part?.tokens;
  if (!tokens) {
    return undefined;
  }
  ctx.usage.seen = true;
  ctx.usage.input += tokens.input ?? 0;
  ctx.usage.output += tokens.output ?? 0;
  ctx.usage.cost += obj.part?.cost ?? 0;
  // Each step reports its own tokens; the event carries the per-step share
  // and the final result carries the summed run totals.
  const usage: Usage = {
    costUsd: obj.part?.cost,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
  };
  return { raw: obj, type: "usage", usage };
};

const makeParse = (id: string) =>
  ndjsonParser<Ctx>({
    finalize: (ctx) => ({
      events: [],
      // There is no single final payload; compose one so the session id
      // needed for `resume` is reachable alongside the last step_finish.
      raw: { sessionId: ctx.sessionId, stepFinish: ctx.stepFinish },
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
        case "step_start": {
          ctx.sessionId ??= obj.sessionID;
          return undefined;
        }
        case "text": {
          const text = obj.part?.text ?? "";
          ctx.text.push(text);
          return { raw: obj, text, type: "text-delta" };
        }
        case "tool_use": {
          return mapToolUse(obj, strict);
        }
        case "step_finish": {
          return mapStepFinish(obj, ctx);
        }
        case "error": {
          const message =
            obj.error?.data?.message ?? obj.error?.name ?? "unknown error";
          throw new AnyAgentError("Invocation", `${id}: ${message}`, {
            raw: obj,
          });
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

const makeBuildInvocation =
  (command: string) =>
  (prompt: string, opts: RunOptions): Invocation => {
    const level = opts.permission ?? "edit";
    if (level === "read") {
      throw new AnyAgentError(
        "UnsupportedCapability",
        `${command} cannot honor permission "read"`
      );
    }
    const args = ["run", "--format", "json"];
    // `edit` is the CLI's default behavior (its own permission config still
    // applies); `auto` approves everything not explicitly denied.
    if (level === "auto") {
      args.push("--auto");
    }
    if (opts.model) {
      args.push("--model", opts.model);
    }
    if (opts.resume) {
      args.push("--session", opts.resume);
    }
    // With no positional message the CLI reads the prompt from stdin, so a
    // large prompt never hits the OS argv size limit.
    return {
      args,
      command,
      cwd: opts.cwd,
      env: opts.env,
      input: prompt,
    };
  };

export const opencodeFamilyAdapter = (meta: AdapterMeta): Adapter => ({
  buildInvocation: makeBuildInvocation(meta.bin[0] ?? meta.id),
  capabilities: CAPS,
  detection: {},
  meta,
  parse: makeParse(meta.id),
});
