import type {
  AcpAdapter,
  AuthStatus,
  BillingMode,
  Capabilities,
  SystemProbe,
} from "./types.js";

const CAPS = {
  attachments: false,
  authStatus: "probed",
  cwd: "native",
  // The endpoint publishes `thinking_effort` as a select whose values are
  // goose's own, not a provider's.
  effort: "native",
  // `session/new` takes the servers, and the endpoint advertises
  // `mcpCapabilities.http`, so both the stdio and the URL shape carry.
  mcp: "native",
  modelListing: false,
  modelSelection: "native",
  // Permission denial is the guarantee, and it only reaches goose in `approve`
  // mode: live-verified on a mutating turn, the default `auto` mode ran the
  // write with no permission request at all, while `approve` asked before every
  // call (`kind: "other"` throughout — no read-only kind among them) and
  // rejecting each one left the file uncreated.
  readOnly: "emulated",
  reasoningEfforts: ["off", "low", "medium", "high", "max"],
  resume: "native",
  sessionFork: false,
  streaming: "native",
  structuredOutput: "emulated",
  // A turn carries content blocks and nothing else, so the core folds the
  // system prompt into the prompt text.
  systemPrompt: "emulated",
  // BYOK: the meter lives at the configured provider, where no probe can
  // read.
  usageStatus: false,
} as const satisfies Capabilities;

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
    return { billing: "unknown", state: "unknown" };
  }
  if (exec.code !== 0) {
    return { billing: "unknown", state: "unknown" };
  }
  const provider = PROVIDER_LINE.exec(exec.stdout)?.groups?.provider;
  if (!provider) {
    return { billing: "unknown", state: "unauthenticated" };
  }
  // The chatgpt-backed providers ride a ChatGPT login's rolling window —
  // the same meter Codex's own CLI reports on this machine. Only the known
  // key-configured providers assert "api-key"; anything else stays unknown
  // rather than guessed.
  let billing: BillingMode = "unknown";
  if (provider.startsWith("chatgpt")) {
    billing = "subscription";
  } else if (provider in PROVIDER_KEY_ENV) {
    billing = "api-key";
  }
  const key = PROVIDER_KEY_ENV[provider];
  if (key && probe.env[key]) {
    return {
      billing,
      method: "api-key",
      providers: [provider],
      state: "authenticated",
    };
  }
  return { billing, providers: [provider], state: "unknown" };
};

/**
 * The adapter for the goose CLI (`goose`), driven over ACP (`goose acp`).
 * Goose is BYOK: configure a provider with `goose configure`, and pass `model`
 * as one of the ids that provider serves (e.g.
 * `"anthropic/claude-sonnet-4.5"` on openrouter) — it sets the session's
 * `model` option, and a session that leaves it unset uses goose's configured
 * default. `effort` sets `thinking_effort` (`off` through `max`), `mcp`
 * servers ride `session/new`, and `resume` reattaches to a
 * `RunResult.sessionId` from an earlier turn.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { goose } from "anyagent-js/goose";
 *
 * const result = await create(goose()).run("summarize this repo");
 * ```
 *
 * `readOnly: true` runs the turn in goose's `approve` mode and denies each
 * tool call it asks about; goose labels those `other` rather than by kind, so
 * a read-only turn answers from the conversation. System prompts and `schema`
 * are emulated. Goose reports provider errors as ordinary assistant text, so a
 * failed turn returns that text as the reply rather than throwing.
 * `authStatus()` reads `goose info -v` and the provider's key env var — a
 * hint, not a guarantee.
 */
export const goose = (): AcpAdapter<typeof CAPS> => ({
  acp: {
    command: ["goose", "acp"],
    // Not a read-only mode — `approve` only makes goose ask, which is what
    // puts every tool call in front of the core's denial.
    readOnly: { configId: "mode", value: "approve" },
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
  capabilities: CAPS,
  detection: {},
  meta: { bin: ["goose"], id: "goose", name: "goose" },
  mode: "acp",
});
