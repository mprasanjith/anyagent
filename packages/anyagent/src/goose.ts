import { randomUUID } from "node:crypto";
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
} from "./types.js";

const CAPS = {
  attachments: false,
  authStatus: "probed",
  cwd: "native",
  // Reasoning effort on goose is env-only per-provider config, unstable
  // across providers; extraArgs territory.
  effort: false,
  // `--with-extension` attaches a server but has no slot for its name: goose
  // derives one from the command's first token, so two servers launched the
  // same way (`npx …`, the common case) collide and one is dropped in silence
  // — verified on 1.43. The live tier names them properly, but capabilities
  // are per-adapter, so honoring `mcp` here would be a lie in print mode.
  mcp: false,
  modelListing: false,
  modelSelection: "native",
  // GOOSE_MODE=chat disables tools entirely (the agent could not even read
  // files) and the approve modes hang headless — no honest read-only run
  // exists.
  readOnly: false,
  // Native ACP tier, gated on a recorded real transcript (sessions.md §6 M-2):
  // test/fixtures/acp/goose.jsonl — initialize on protocolVersion 1, a session
  // id, an agent_message_chunk streaming "pong", and stopReason end_turn.
  session: "native",
  sessionFork: false,
  streaming: "native",
  structuredOutput: "emulated",
  systemPrompt: "native",
} as const satisfies Capabilities;

// Goose's text-editor tool multiplexes on a `command` argument; each command
// maps to what it actually does, so `write` and `edit` stay honest.
const EDITOR_COMMANDS: Record<string, ToolName> = {
  create: "write",
  insert: "edit",
  str_replace: "edit",
  undo_edit: "edit",
  write: "write",
};

// Goose namespaces tools as `<extension>__<tool>` (e.g. `developer__shell`);
// bare names also occur. Normalization matches on the bare tool; a tool
// outside the shared vocabulary keeps its full native name.
const normalizeTool = (nativeName: string, input: unknown): ToolName => {
  const sep = nativeName.indexOf("__");
  const bare = sep === -1 ? nativeName : nativeName.slice(sep + 2);
  if (bare === "shell") {
    return "bash";
  }
  if (bare === "text_editor") {
    const command = (input as { command?: unknown } | undefined)?.command;
    return typeof command === "string"
      ? (EDITOR_COMMANDS[command] ?? nativeName)
      : nativeName;
  }
  return nativeName;
};

interface Ctx {
  complete?: unknown;
  text: string[];
  tools: Map<string, { name: ToolName; nativeName: string }>;
}

// biome-ignore lint/suspicious/noExplicitAny: the CLI's JSON is dynamically shaped.
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
    case "thinking": {
      return { raw, text: block.thinking, type: "reasoning-delta" };
    }
    case "redactedThinking": {
      // Redacted thinking carries no readable text; known, so not a strict
      // error.
      return;
    }
    case "toolRequest": {
      const call = block.toolCall?.value ?? {};
      const nativeName = typeof call.name === "string" ? call.name : "unknown";
      const name = normalizeTool(nativeName, call.arguments);
      ctx.tools.set(block.id, { name, nativeName });
      return {
        callId: block.id,
        input: call.arguments,
        name,
        nativeName,
        raw,
        type: "tool-call",
      };
    }
    case "toolResponse": {
      const tool = ctx.tools.get(block.id);
      return {
        callId: block.id,
        name: tool?.name ?? "unknown",
        nativeName: tool?.nativeName ?? "unknown",
        output: block.toolResult?.value?.content,
        raw,
        type: "tool-result",
      };
    }
    default: {
      if (strict) {
        throw new AnyAgentError("Parse", `unknown content block ${block.type}`);
      }
      return;
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
      // No sessionId: goose's headless stream never reveals one.
      text: ctx.text.join(""),
      // A failed run still ends with `complete` but null token counts;
      // goose reports no cost or cache/reasoning split either way.
      usage:
        typeof input === "number" || typeof output === "number"
          ? {
              inputTokens: typeof input === "number" ? input : undefined,
              outputTokens: typeof output === "number" ? output : undefined,
            }
          : undefined,
    };
  },
  init: () => ({ text: [], tools: new Map() }),
  map: (raw: unknown, ctx, strict) => {
    const obj = raw as Json;
    switch (obj.type) {
      // Goose interleaves assistant messages (text tokens, thinking, tool
      // requests) with user-role tool responses; each content block maps on
      // its own.
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
          return;
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
        return;
      }
    }
  },
});

const buildInvocation = (prompt: string, opts: RunOptions): Invocation => {
  // --quiet keeps stdout pure NDJSON (goose otherwise prints a banner);
  // `-i -` reads the prompt from stdin, so a large prompt never hits the OS
  // argv size limit.
  const args = ["run", "--output-format", "stream-json", "--quiet", "-i", "-"];
  if (opts.model) {
    // "provider/model" splits at the first slash into --provider/--model;
    // the model part may itself contain slashes (openrouter paths). A bare
    // name leaves the provider to goose's own config.
    const slash = opts.model.indexOf("/");
    if (slash === -1) {
      args.push("--model", opts.model);
    } else {
      args.push(
        "--provider",
        opts.model.slice(0, slash),
        "--model",
        opts.model.slice(slash + 1)
      );
    }
  }
  if (opts.systemPrompt) {
    args.push("--system", opts.systemPrompt);
  }
  if (opts.resume) {
    args.push("--name", opts.resume, "--resume");
  }
  return {
    args,
    command: "goose",
    cwd: opts.cwd,
    // The autonomous baseline: goose's approve modes would hang a headless
    // run. A caller-set GOOSE_MODE wins over the default.
    env: { GOOSE_MODE: "auto", ...opts.env },
    input: prompt,
  };
};

// Providers whose credentials goose reads from a well-known env var. A
// configured provider whose key is absent here may still hold it in goose's
// keyring — that case is honestly "unknown", never "unauthenticated".
const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  gemini: "GEMINI_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  xai: "XAI_API_KEY",
};

// `goose info -v` exits 0 and prints a `GOOSE_PROVIDER: <name>` line when a
// provider is configured (verified on 1.43; no line at all when
// unconfigured), with no LLM call either way.
const PROVIDER_LINE = /^\s*GOOSE_PROVIDER:\s*(?<provider>\S+)\s*$/mu;

const authStatus = async (probe: SystemProbe): Promise<AuthStatus> => {
  let exec: { stdout: string; stderr: string; code: number };
  try {
    exec = await probe.exec("goose", ["info", "-v"]);
  } catch {
    return { state: "unknown" };
  }
  if (exec.code !== 0) {
    return { state: "unknown" };
  }
  const provider = PROVIDER_LINE.exec(exec.stdout)?.groups?.provider;
  if (!provider) {
    return { state: "unauthenticated" };
  }
  const key = PROVIDER_KEY_ENV[provider];
  if (key && probe.env[key]) {
    return {
      method: "api-key",
      providers: [provider],
      state: "authenticated",
    };
  }
  return { providers: [provider], state: "unknown" };
};

/**
 * The adapter for the goose CLI (`goose`). Goose is BYOK: pass
 * `model: "provider/model"` — the part before the first `/` picks the
 * provider, the rest is the model in that provider's own naming (so an
 * openrouter path like `"openrouter/openai/gpt-4o-mini"` works verbatim). A
 * bare model name leaves the provider to goose's own config.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { goose } from "anyagent-js/goose";
 *
 * const result = await create(goose()).run("summarize this repo");
 * ```
 *
 * Sessions are resumed by name, and goose never reveals a session id
 * headless, so `RunResult.sessionId` stays absent. `agent.session()` handles
 * this for you by generating a name up front; to do it by hand, name the
 * first run via `extraArgs: ["--name", "my-session"]` and pass that same
 * name as `resume`. Goose reports provider errors as ordinary assistant
 * text, so a failed turn returns that text as the reply rather than
 * throwing.
 */
export const goose = (): Adapter<typeof CAPS> => ({
  acp: {
    command: ["goose", "acp"],
    // `thinking_effort` exists only on the live endpoint, so the declared
    // `effort: false` (a print-tier fact) still gates it everywhere today.
    settings: ({ effort, model }) => ({
      configOptions: [
        ...(model === undefined ? [] : [{ configId: "model", value: model }]),
        ...(effort === undefined
          ? []
          : [{ configId: "thinking_effort", value: effort }]),
      ],
    }),
  },
  authStatus,
  buildInvocation,
  capabilities: CAPS,
  detection: {},
  meta: { bin: ["goose"], id: "goose", name: "goose" },
  parse,
  // Goose sessions are keyed by name and the headless stream never reveals
  // one, so the session provides the handle: the first turn registers the
  // name via --name (without --resume), and later turns resume it.
  sessionSeed: () => {
    const id = `anyagent-${randomUUID().slice(0, 8)}`;
    return { firstRunOptions: { extraArgs: ["--name", id] }, id };
  },
});
