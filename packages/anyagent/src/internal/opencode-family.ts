import { AnyAgentError } from "../errors.js";
import type {
  AcpAdapter,
  AcpConfigOption,
  AdapterMeta,
  AuthStatus,
  Capabilities,
  ModelInfo,
  SystemProbe,
  UsageStatus,
} from "../types.js";
import { credentialBilling } from "./billing.js";
import { fetchJson } from "./http.js";
import { vendorOf } from "./vendors.js";

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
  // The family baseline. `<bin> stats` is a local consumption ledger, not
  // remaining quota, and nothing else on the machine holds the meter — it
  // lives at the provider, or at the sibling's own gateway. A sibling with a
  // gateway that answers for it raises this to `"remote"` and supplies a
  // `usage` spec.
  usageStatus: false,
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

// Scan the auth store body: which providers hold credentials, and whether
// any entry is oauth-typed. The `type` per entry is the billing signal — an
// oauth entry is subscription-backed, anything else is metered.
const scanStore = (
  body: string | undefined,
  providers: Set<string>
): { keySeen: boolean; oauthSeen: boolean } => {
  const seen = { keySeen: false, oauthSeen: false };
  if (body === undefined) {
    return seen;
  }
  let store: unknown;
  try {
    store = JSON.parse(body);
  } catch {
    // A corrupt store proves nothing either way; env keys still count.
  }
  if (store !== null && typeof store === "object") {
    for (const [provider, cred] of Object.entries(store)) {
      providers.add(provider);
      if ((cred as { type?: unknown })?.type === "oauth") {
        seen.oauthSeen = true;
      } else {
        seen.keySeen = true;
      }
    }
  }
  return seen;
};

// Never exec `auth list` here: its exit code is untrustworthy (0 with zero
// credentials), so the auth store plus env vars are the whole probe.
const makeAuthStatus =
  (dataDir: string) =>
  async (probe: SystemProbe): Promise<AuthStatus> => {
    const providers = new Set<string>();
    const body = await probe.readFile(
      `${probe.homedir()}/.local/share/${dataDir}/auth.json`
    );
    const seen = scanStore(body, providers);
    for (const [envVar, provider] of ENV_PROVIDERS) {
      if (probe.env[envVar]) {
        providers.add(provider);
        seen.keySeen = true;
      }
    }
    return providers.size > 0
      ? {
          billing: credentialBilling(seen.oauthSeen, seen.keySeen),
          providers: [...providers],
          state: "authenticated",
        }
      : { billing: "unknown", state: "unauthenticated" };
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
        // The vendor, never the leading gateway segment: see `vendorOf`.
        const provider = vendorOf(id);
        return provider ? { id, provider } : { id };
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
  /**
   * The sibling's own gateway meter, for a CLI that sells inference under
   * its own brand. Omit it — as opencode's BYOK providers require — and the
   * sibling keeps `usageStatus: false`.
   */
  usage?: FamilyUsageSpec;
}

/**
 * How one sibling reads its gateway's remaining quota: which credential
 * store entry pays for it, where the meter lives, and how to read the
 * answer. Egress-only, so it runs solely under {@link CreateOptions.network}.
 */
export interface FamilyUsageSpec {
  /**
   * Env vars holding the same key, tried in order before the auth store.
   */
  keyEnv?: readonly string[];
  /** The `auth.json` entry whose `key` pays for the gateway. */
  storeProvider: string;
  /** Map the gateway's response body onto a status. */
  toStatus: (body: unknown) => UsageStatus | undefined;
  url: string;
}

// The gateway key: an env var if one is set, else the auth store entry the
// CLI itself writes at login.
const gatewayKey = async (
  probe: SystemProbe,
  dataDir: string,
  spec: FamilyUsageSpec
): Promise<string | undefined> => {
  for (const envVar of spec.keyEnv ?? []) {
    const value = probe.env[envVar]?.trim();
    if (value) {
      return value;
    }
  }
  const body = await probe.readFile(
    `${probe.homedir()}/.local/share/${dataDir}/auth.json`
  );
  if (body === undefined) {
    return;
  }
  let store: unknown;
  try {
    store = JSON.parse(body);
  } catch {
    return;
  }
  const entry = (store as Record<string, { key?: unknown }> | null)?.[
    spec.storeProvider
  ];
  return typeof entry?.key === "string" && entry.key !== ""
    ? entry.key
    : undefined;
};

const makeUsageStatus =
  (dataDir: string, spec: FamilyUsageSpec) =>
  async (probe: SystemProbe): Promise<UsageStatus> => {
    // No egress opt-in, no answer: the meter is only at the gateway.
    if (!probe.fetch) {
      return { state: "unknown" };
    }
    const key = await gatewayKey(probe, dataDir, spec);
    if (key === undefined) {
      return { state: "unknown" };
    }
    const res = await fetchJson(probe.fetch, spec.url, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (res?.status !== 200) {
      return { state: "unknown" };
    }
    return spec.toStatus(res.body) ?? { state: "unknown" };
  };

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
    ...(spec.usage
      ? { usageStatus: makeUsageStatus(spec.dataDir, spec.usage) }
      : {}),
  };
};
