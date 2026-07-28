import { AnyAgentError } from "../errors.js";
import { ndjsonParser } from "../ndjson.js";
import type {
  AcpAdapter,
  AcpConfigOption,
  AdapterMeta,
  AgentEvent,
  AuthStatus,
  Capabilities,
  Invocation,
  McpConfig,
  ModelInfo,
  RunOptions,
  StdoutAdapter,
  SystemProbe,
  Usage,
} from "../types.js";

// Shared implementation for opencode and its fork Kilo Code. Both CLIs expose
// the same `run --format json` surface and emit the same
// `step_start`/`text`/`tool_use`/`step_finish` event stream — verified
// separately against real output of each. Only the identity, the data dir,
// and the permission env var differ, so each adapter passes its own spec.

const CAPS = {
  // `-f, --file  file(s) to attach to message` — an array flag, so each path
  // repeats it (verified against `opencode run --help`, 1.18.3).
  attachments: "native",
  authStatus: "probed",
  cwd: "native",
  // `--variant` takes provider-defined names — an open vocabulary, so no
  // `reasoningEfforts` list; the CLI itself rejects a bad value.
  effort: "native",
  // Off for the family: delivery needs a `configEnv`, and only a sibling whose
  // own config env var is verified declares one.
  mcp: false,
  modelListing: "native",
  modelSelection: "native",
  readOnly: "native",
  resume: "native",
  // `--fork  fork the session before continuing (requires --continue or
  // --session)` — the core only sends `forkSession` alongside `resume`, which
  // maps to `--session`, so the prerequisite always holds.
  sessionFork: "native",
  streaming: "native",
  structuredOutput: "emulated",
  // No per-run append-system-prompt flag (system prompts are config-file /
  // agent-file concerns); the core folds the system prompt into the prompt.
  systemPrompt: "emulated",
} as const satisfies Capabilities;

export type OpencodeFamilyCapabilities = typeof CAPS;

interface Ctx {
  sessionId?: string;
  stepFinish?: unknown;
  text: string[];
  usage: {
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    input: number;
    output: number;
    reasoning: number;
    seen: boolean;
  };
}

// biome-ignore lint/suspicious/noExplicitAny: the CLI's JSON is dynamically shaped.
type Json = any;

// This family's native names for the shared tools (read/write/edit/bash/
// grep/glob) already are the shared vocabulary, and everything else keeps
// its native name — `webfetch` included, which reads the web but is not
// webSearch — so `name` and `nativeName` coincide here.
const mapToolUse = (obj: Json, strict: boolean): AgentEvent[] | undefined => {
  const part = obj.part ?? {};
  const state = part.state ?? {};
  const base = {
    callId: part.callID ?? part.id,
    name: part.tool,
    nativeName: part.tool,
  };
  switch (state.status) {
    // JSON mode emits tool parts in a terminal state: input and output arrive
    // together, so one raw event produces the call and its result.
    case "completed": {
      return [
        { ...base, input: state.input, raw: obj, type: "tool-call" },
        { ...base, output: state.output, raw: obj, type: "tool-result" },
      ];
    }
    case "error": {
      return [
        { ...base, input: state.input, raw: obj, type: "tool-call" },
        { ...base, output: state.error, raw: obj, type: "tool-result" },
      ];
    }
    default: {
      if (strict) {
        throw new AnyAgentError("Parse", `unknown tool state ${state.status}`);
      }
      return;
    }
  }
};

const mapStepFinish = (obj: Json, ctx: Ctx): AgentEvent | undefined => {
  ctx.stepFinish = obj;
  const tokens = obj.part?.tokens;
  if (!tokens) {
    return;
  }
  const sums = ctx.usage;
  sums.seen = true;
  sums.input += tokens.input ?? 0;
  sums.output += tokens.output ?? 0;
  sums.reasoning += tokens.reasoning ?? 0;
  sums.cacheRead += tokens.cache?.read ?? 0;
  sums.cacheWrite += tokens.cache?.write ?? 0;
  sums.cost += obj.part?.cost ?? 0;
  // Each step reports its own tokens; the event carries the per-step share
  // and the final result carries the summed run totals.
  const usage: Usage = {
    cacheReadTokens: tokens.cache?.read,
    cacheWriteTokens: tokens.cache?.write,
    costUsd: obj.part?.cost,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    reasoningTokens: tokens.reasoning,
  };
  return { raw: obj, type: "usage", usage };
};

const mapEvent = (
  id: string,
  obj: Json,
  ctx: Ctx,
  strict: boolean
): AgentEvent | AgentEvent[] | undefined => {
  switch (obj.type) {
    case "step_start": {
      return;
    }
    case "text": {
      const text = obj.part?.text ?? "";
      ctx.text.push(text);
      return { raw: obj, text, type: "text-delta" };
    }
    // Kilo names its thinking stream `reasoning`; the shared parser maps it
    // for both siblings so a fork-side appearance never trips strict mode.
    case "reasoning": {
      return { raw: obj, text: obj.part?.text ?? "", type: "reasoning-delta" };
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
      throw new AnyAgentError("Invocation", `${id}: ${message}`, { raw: obj });
    }
    default: {
      if (strict) {
        throw new AnyAgentError("Parse", `unknown event type ${obj.type}`);
      }
      return;
    }
  }
};

const makeParse = (id: string) =>
  ndjsonParser<Ctx>({
    finalize: (ctx) => ({
      events: [],
      // There is no single final payload; compose one so the last step_finish
      // stays reachable alongside the session id.
      raw: { sessionId: ctx.sessionId, stepFinish: ctx.stepFinish },
      sessionId: ctx.sessionId,
      text: ctx.text.join(""),
      usage: ctx.usage.seen
        ? {
            cacheReadTokens: ctx.usage.cacheRead,
            cacheWriteTokens: ctx.usage.cacheWrite,
            costUsd: ctx.usage.cost,
            inputTokens: ctx.usage.input,
            outputTokens: ctx.usage.output,
            reasoningTokens: ctx.usage.reasoning,
          }
        : undefined,
    }),
    init: () => ({
      text: [],
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        seen: false,
      },
    }),
    map: (raw: unknown, ctx, strict) => {
      const obj = raw as Json;
      const events: AgentEvent[] = [];
      // Every event carries the session id; surface it once, on first sight,
      // so a caller can persist it before the run ends.
      if (ctx.sessionId === undefined && typeof obj.sessionID === "string") {
        ctx.sessionId = obj.sessionID;
        events.push({ raw: obj, sessionId: obj.sessionID, type: "session" });
      }
      const mapped = mapEvent(id, obj, ctx, strict);
      if (mapped !== undefined) {
        events.push(...(Array.isArray(mapped) ? mapped : [mapped]));
      }
      return events.length > 0 ? events : undefined;
    },
  });

// Category keys only — the CLIs silently ignore per-tool-name keys
// (live-verified). `webfetch` stays allowed: it reads, it does not change
// the machine, and the readOnly contract is "nothing on the machine changes".
const READ_ONLY_MATRIX = JSON.stringify({ bash: "deny", edit: "deny" });

// The config `mcp` map is keyed by the name the agent sees, matching
// {@link McpConfig} exactly, so the caller's key survives the trip.
const toConfigMcp = (mcp: McpConfig): Record<string, unknown> => {
  const servers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(mcp)) {
    if (server.url !== undefined) {
      servers[name] = { enabled: true, type: "remote", url: server.url };
      continue;
    }
    if (server.command === undefined) {
      throw new AnyAgentError(
        "InvalidOptions",
        `mcp server "${name}" needs a command or a url`
      );
    }
    servers[name] = {
      command: [server.command, ...(server.args ?? [])],
      enabled: true,
      environment: server.env,
      type: "local",
    };
  }
  return servers;
};

const parseConfig = (caller: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(caller) as Record<string, unknown>;
  } catch {
    // Reported by the caller, which owns the message.
  }
};

// The config env var carries a whole config document, so a caller may already
// be using it for unrelated settings: merge into what they sent rather than
// replacing it, and let this run's servers win name by name.
const configWithMcp = (caller: string | undefined, mcp: McpConfig): string => {
  const base = caller === undefined ? {} : parseConfig(caller);
  if (base === undefined) {
    throw new AnyAgentError(
      "InvalidOptions",
      "the config env var holds invalid JSON, so this run's mcp servers cannot be merged into it",
      { raw: caller }
    );
  }
  const existing = base.mcp as Record<string, unknown> | undefined;
  return JSON.stringify({
    ...base,
    mcp: { ...existing, ...toConfigMcp(mcp) },
  });
};

const makeBuildInvocation =
  (command: string, permissionEnv: string, configEnv: string | undefined) =>
  (prompt: string, opts: RunOptions): Invocation => {
    // `--auto` always: the v2 default is the CLI's maximum
    // autonomy, and readOnly confines it via the deny matrix rather than by
    // dropping the flag.
    const args = ["run", "--format", "json", "--auto"];
    if (opts.model) {
      args.push("--model", opts.model);
    }
    if (opts.resume) {
      args.push("--session", opts.resume);
    }
    // `--fork` requires --continue or --session; the core only sends
    // `forkSession` with `resume`, so `--session` above is always present.
    if (opts.forkSession) {
      args.push("--fork");
    }
    if (opts.effort) {
      args.push("--variant", opts.effort);
    }
    // `-f, --file` is an array flag: repeat it once per attachment path.
    for (const file of opts.attachments ?? []) {
      args.push("-f", file);
    }
    // Single-writer rule (api-v2 §8.1): the permission env var is
    // adapter-owned. Caller env merges first and the adapter's key lands
    // last, so a caller-supplied value can never weaken the readOnly
    // contract.
    let env = opts.readOnly
      ? { ...opts.env, [permissionEnv]: READ_ONLY_MATRIX }
      : opts.env;
    if (configEnv && opts.mcp) {
      env = {
        ...env,
        [configEnv]: configWithMcp(opts.env?.[configEnv], opts.mcp),
      };
    }
    // With no positional message the CLI reads the prompt from stdin, so a
    // large prompt never hits the OS argv size limit.
    return { args, command, cwd: opts.cwd, env, input: prompt };
  };

// Provider key env vars both CLIs auto-detect; any one present is a usable
// credential even with an empty auth store.
const ENV_PROVIDERS: readonly (readonly [string, string])[] = [
  ["OPENROUTER_API_KEY", "openrouter"],
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["OPENAI_API_KEY", "openai"],
  ["GEMINI_API_KEY", "google"],
  ["GOOGLE_GENERATIVE_AI_API_KEY", "google"],
  ["XAI_API_KEY", "xai"],
  ["GROQ_API_KEY", "groq"],
  ["MISTRAL_API_KEY", "mistral"],
  ["DEEPSEEK_API_KEY", "deepseek"],
];

// Never exec `auth list` here: its exit code is untrustworthy (0 with zero
// credentials), so the auth store plus env vars are the whole probe.
const makeAuthStatus =
  (dataDir: string) =>
  async (probe: SystemProbe): Promise<AuthStatus> => {
    const providers = new Set<string>();
    let store: unknown;
    const body = await probe.readFile(
      `${probe.homedir()}/.local/share/${dataDir}/auth.json`
    );
    if (body !== undefined) {
      try {
        store = JSON.parse(body);
      } catch {
        // A corrupt store proves nothing either way; env keys still count.
      }
      if (store !== null && typeof store === "object") {
        for (const provider of Object.keys(store)) {
          providers.add(provider);
        }
      }
    }
    for (const [envVar, provider] of ENV_PROVIDERS) {
      if (probe.env[envVar]) {
        providers.add(provider);
      }
    }
    return providers.size > 0
      ? { providers: [...providers], state: "authenticated" }
      : { state: "unauthenticated" };
  };

// `<bin> models` prints one `provider/model` id per line and nothing else.
const makeListModels =
  (bin: string) =>
  async (probe: SystemProbe): Promise<ModelInfo[]> => {
    const { code, stderr, stdout } = await probe.exec(bin, ["models"]);
    if (code !== 0) {
      throw new AnyAgentError("Invocation", `${bin} models exited ${code}`, {
        argv: [bin, "models"],
        stderr,
      });
    }
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((id) => {
        const slash = id.indexOf("/");
        return slash > 0 ? { id, provider: id.slice(0, slash) } : { id };
      });
  };

export interface OpencodeFamilySpec {
  /**
   * The ACP endpoint's config option id for reasoning effort. Omit it where
   * the endpoint advertises no such option — a sibling without one throws for
   * `effort` on a session instead.
   */
  acpEffort?: string;
  /**
   * The adapter-owned env var carrying an inline config document, which is how
   * a run's MCP servers are delivered. Omit it where the CLI's own name for it
   * is unverified — a sibling without one cannot declare `mcp`.
   */
  configEnv?: string;
  /** App dir under `~/.local/share` holding the CLI's `auth.json`. */
  dataDir: string;
  meta: AdapterMeta;
  /** The adapter-owned env var carrying the permission matrix. */
  permissionEnv: string;
}

export const opencodeFamilyAdapter = (
  spec: OpencodeFamilySpec
): AcpAdapter<OpencodeFamilyCapabilities> &
  Pick<
    StdoutAdapter<OpencodeFamilyCapabilities>,
    "buildInvocation" | "parse"
  > => {
  const command = spec.meta.bin[0] ?? spec.meta.id;
  return {
    // Both siblings ship an `acp` subcommand (`opencode acp` verified locally,
    // kilo's documented at the kilo CLI reference).
    acp: {
      command: [command, "acp"],
      readOnly: { configId: "mode", value: "plan" },
      settings: ({ effort, model }) => {
        const configOptions: AcpConfigOption[] = [];
        if (model !== undefined) {
          configOptions.push({ configId: "model", value: model });
        }
        if (effort !== undefined) {
          if (spec.acpEffort === undefined) {
            throw new AnyAgentError(
              "UnsupportedCapability",
              `${spec.meta.id}: a session cannot set reasoning effort; run it outside the session`
            );
          }
          // Ordered after `model`: the endpoint scopes the effort levels it
          // accepts to the session's current model, and rejects any other.
          configOptions.push({ configId: spec.acpEffort, value: effort });
        }
        return { configOptions };
      },
    },
    authStatus: makeAuthStatus(spec.dataDir),
    buildInvocation: makeBuildInvocation(
      command,
      spec.permissionEnv,
      spec.configEnv
    ),
    capabilities: CAPS,
    detection: {},
    listModels: makeListModels(command),
    meta: spec.meta,
    mode: "acp",
    parse: makeParse(spec.meta.id),
  };
};
