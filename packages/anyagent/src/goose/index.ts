import { AnyAgentError } from "../internal/errors.js";
import { ndjsonParser } from "../internal/ndjson.js";
import type {
  Adapter,
  AgentEvent,
  CapabilityTable,
  Invocation,
  PermissionLevel,
  RunOptions,
} from "../internal/types.js";

const CAPS: CapabilityTable = {
  cwd: "native",
  // Goose attaches MCP servers via --with-extension, but that surface is
  // unverified against real output; use extraArgs or raw.
  mcp: false,
  modelSelection: "native",
  // No `read` level: goose's chat mode disables tools entirely (the agent
  // could not even read files), and its approve modes can hang a
  // non-interactive run. `edit` is goose's own default; `auto` pins
  // GOOSE_MODE=auto.
  permissionLevels: ["edit", "auto"],
  sessionResume: "native",
  streaming: "native",
  structuredOutput: "emulated",
  systemPrompt: "native",
};

interface Ctx {
  text: string[];
  toolNames: Map<string, string>;
  complete?: unknown;
}

// oxlint-disable-next-line typescript/no-explicit-any -- the CLI's JSON is dynamically shaped.
type Json = any;

const mapContent = (
  block: Json,
  raw: Json,
  ctx: Ctx,
  strict: boolean
): AgentEvent | undefined => {
  switch (block.type) {
    case "text": {
      ctx.text.push(block.text);
      return { raw, text: block.text, type: "text-delta" };
    }
    case "toolRequest": {
      const call = block.toolCall?.value ?? {};
      ctx.toolNames.set(block.id, call.name);
      return {
        input: call.arguments,
        name: call.name,
        raw,
        type: "tool-call",
      };
    }
    case "toolResponse": {
      return {
        name: ctx.toolNames.get(block.id) ?? "unknown",
        output: block.toolResult?.value?.content,
        raw,
        type: "tool-result",
      };
    }
    default: {
      if (strict) {
        throw new AnyAgentError("Parse", `unknown content block ${block.type}`);
      }
      return undefined;
    }
  }
};

const parse = ndjsonParser<Ctx>({
  finalize: (ctx) => {
    const complete = ctx.complete as Json;
    const input = complete?.input_tokens;
    const output = complete?.output_tokens;
    return {
      events: [],
      raw: ctx.complete,
      text: ctx.text.join(""),
      // A failed run still ends with `complete` but null token counts;
      // goose reports no cost either way.
      usage:
        typeof input === "number" || typeof output === "number"
          ? {
              inputTokens: typeof input === "number" ? input : undefined,
              outputTokens: typeof output === "number" ? output : undefined,
            }
          : undefined,
    };
  },
  init: () => ({ text: [], toolNames: new Map() }),
  map: (raw: unknown, ctx, strict) => {
    const obj = raw as Json;
    switch (obj.type) {
      // Goose interleaves assistant messages (text tokens, tool requests)
      // with user-role tool responses; each content block maps on its own.
      case "message": {
        const out: AgentEvent[] = [];
        for (const block of obj.message?.content ?? []) {
          const ev = mapContent(block, obj, ctx, strict);
          if (ev) {
            out.push(ev);
          }
        }
        return out;
      }
      case "complete": {
        ctx.complete = obj;
        const input = obj.input_tokens;
        const output = obj.output_tokens;
        if (typeof input !== "number" && typeof output !== "number") {
          return undefined;
        }
        return {
          raw: obj,
          type: "usage",
          usage: {
            inputTokens: typeof input === "number" ? input : undefined,
            outputTokens: typeof output === "number" ? output : undefined,
          },
        };
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
  const level: PermissionLevel = opts.permission ?? "edit";
  if (level === "read") {
    throw new AnyAgentError(
      "UnsupportedCapability",
      'goose cannot honor permission "read"'
    );
  }
  // --quiet keeps stdout pure NDJSON (goose otherwise prints a banner);
  // `-i -` reads the prompt from stdin, so a large prompt never hits the OS
  // argv size limit.
  const args = ["run", "--output-format", "stream-json", "--quiet", "-i", "-"];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.systemPrompt) {
    args.push("--system", opts.systemPrompt);
  }
  if (opts.resume) {
    args.push("--name", opts.resume, "--resume");
  }
  // `edit` leaves GOOSE_MODE to the user's own config; `auto` pins auto.
  const env = level === "auto" ? { ...opts.env, GOOSE_MODE: "auto" } : opts.env;
  return {
    args,
    command: "goose",
    cwd: opts.cwd,
    env,
    input: prompt,
  };
};

/**
 * The adapter for goose (Block's open-source agent, now under the Agentic AI
 * Foundation). Drives `goose run --output-format stream-json --quiet` with
 * the prompt piped over stdin via `-i -`. Goose is BYOK: pick the backend
 * with `GOOSE_PROVIDER` plus the provider's key env var (or goose's own
 * config), and pass `model` in the provider's naming.
 *
 * ```ts
 * import { create } from "anyagent";
 * import { goose } from "anyagent/goose";
 *
 * const result = await create(goose()).run("summarize this repo");
 * ```
 *
 * Sessions are resumed by name: name the first run yourself via
 * `extraArgs: ["--name", "my-session"]`, then pass that same name as
 * `resume` — goose's headless stream carries no session id to hand back on
 * `raw`. Goose reports errors as ordinary assistant text with a final
 * `complete` event of null token counts, so a failed turn returns that text
 * rather than throwing.
 */
export const goose = (): Adapter => ({
  buildInvocation,
  capabilities: CAPS,
  detection: {},
  meta: { bin: ["goose"], id: "goose", name: "goose" },
  parse,
});
