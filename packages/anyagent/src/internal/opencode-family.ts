import { AnyAgentError } from "../errors.js";
import type {
  AcpAdapter,
  AcpConfigOption,
  AdapterMeta,
  AuthStatus,
  Capabilities,
  ModelInfo,
  SystemProbe,
} from "../types.js";

// Shared implementation for opencode and its fork Kilo Code. Both CLIs expose
// the same ACP endpoint, the same auth store layout, and the same `models`
// output — verified separately against real output of each. Only the identity,
// the data dir, and the endpoint's effort option differ, so each adapter passes
// its own spec.

const CAPS = {
  // The protocol carries attachments itself, as resource links beside the
  // prompt text; both endpoints advertise `promptCapabilities`.
  attachments: "native",
  authStatus: "probed",
  cwd: "native",
  // The family baseline: only a sibling whose endpoint advertises an effort
  // option raises this, and it names that option in `acpEffort`.
  effort: false,
  // `session/new` carries the servers; both endpoints advertise
  // `mcpCapabilities`.
  mcp: "native",
  modelListing: "native",
  modelSelection: "native",
  // Two core-driven mechanisms together: the endpoint's `plan` mode, which
  // both advertise and which covers edits, and permission denial for every
  // tool kind that is not read-only, which covers the rest — shell included.
  readOnly: "native",
  resume: "native",
  sessionFork: "native",
  streaming: "native",
  structuredOutput: "emulated",
  // No per-run system prompt channel (system prompts are config-file /
  // agent-file concerns); the core folds the system prompt into the prompt.
  systemPrompt: "emulated",
} as const satisfies Capabilities;

export type OpencodeFamilyCapabilities = typeof CAPS;

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
   * the endpoint advertises no such option — a sibling without one declares
   * `effort` false and throws for it on a session instead.
   */
  acpEffort?: string;
  /** App dir under `~/.local/share` holding the CLI's `auth.json`. */
  dataDir: string;
  meta: AdapterMeta;
}

export const opencodeFamilyAdapter = (
  spec: OpencodeFamilySpec
): AcpAdapter<OpencodeFamilyCapabilities> => {
  const command = spec.meta.bin[0] ?? spec.meta.id;
  return {
    // Both siblings ship an `acp` subcommand (`opencode acp` and `kilo acp`
    // both verified locally against the recorded transcripts).
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
              `${spec.meta.id}: this agent has no reasoning effort setting`
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
    capabilities: CAPS,
    detection: {},
    listModels: makeListModels(command),
    meta: spec.meta,
    mode: "acp",
  };
};
