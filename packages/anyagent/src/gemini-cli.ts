import type {
  AcpAdapter,
  AuthStatus,
  Capabilities,
  ModelInfo,
  SystemProbe,
} from "./types.js";

const CAPS = {
  // The endpoint advertises promptCapabilities image/audio/embeddedContext,
  // but no recorded turn shows an attached file reaching the model.
  attachments: false,
  // Credentials live in ~/.gemini files, provider env vars, or the OS
  // keychain, so the answer is a best-effort probe, not the CLI's own word.
  authStatus: "probed",
  cwd: "native",
  effort: false,
  // The endpoint advertises mcpCapabilities, but no recorded turn shows a
  // server passed to session/new being reached.
  mcp: false,
  // The endpoint names its models only inside an open session, which a probe
  // cannot reach; the list is the documented vocabulary instead — a hint.
  modelListing: "probed",
  modelSelection: "native",
  // In the endpoint's default mode every mutating tool asks the client for
  // permission, so the read-only line is the core's denial, not the CLI's own
  // guarantee. Plan mode is NOT used: `exit_plan_mode` self-approves and the
  // agent then writes freely (verified live on 0.46).
  readOnly: "emulated",
  // Reattachment is broken upstream (#15502): the endpoint advertises
  // `loadSession` and `session/load` then fails, so a session here only ever
  // starts fresh.
  resume: false,
  sessionFork: false,
  streaming: "native",
  structuredOutput: "emulated",
  // No append-system-prompt channel; GEMINI_SYSTEM_MD replaces the built-in
  // prompt rather than extending it, so the core folds the text in instead.
  systemPrompt: "emulated",
  // Limits exist (account request quotas), but the only dial is the TUI's
  // /stats — `-p "/stats"` becomes a prompt (verified live), so there is no
  // surface a probe can read.
  usageStatus: false,
} as const satisfies Capabilities;

// The documented model vocabulary (geminicli.com docs: CLI reference plus
// the configuration reference's `model.name` values), each valid verbatim
// as `-m`. The two pages drift against each other — aliases resolve to
// older ids than the config list carries — which is exactly why this is
// "probed": the union is the hint, the CLI stays the authority.
const MODELS = [
  "auto",
  "pro",
  "flash",
  "flash-lite",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
] as const;

const listModels = (): Promise<ModelInfo[]> =>
  Promise.resolve(MODELS.map((id) => ({ id, provider: "google" })));

const authStatus = async (probe: SystemProbe): Promise<AuthStatus> => {
  const home = probe.homedir();
  const oauth = await probe.readFile(`${home}/.gemini/oauth_creds.json`);
  if (oauth !== undefined) {
    // An oauth login draws on the Google account's request quotas, not a
    // metered key.
    return { billing: "subscription", method: "oauth", state: "authenticated" };
  }
  if (probe.env.GEMINI_API_KEY || probe.env.GOOGLE_API_KEY) {
    return { billing: "api-key", method: "api-key", state: "authenticated" };
  }
  // A selected auth type with no visible credentials means the key lives
  // somewhere the probe cannot read (the OS keychain, a .env file the CLI
  // discovers itself) — "unknown" is the honest answer, not a denial.
  const settings = await probe.readFile(`${home}/.gemini/settings.json`);
  if (settings !== undefined) {
    try {
      const parsed = JSON.parse(settings) as {
        security?: { auth?: { selectedType?: unknown } };
      };
      const selected = parsed?.security?.auth?.selectedType;
      if (typeof selected === "string" && selected.length > 0) {
        return { billing: "unknown", method: selected, state: "unknown" };
      }
    } catch {
      // A corrupt settings file proves nothing either way.
    }
  }
  return { billing: "unknown", state: "unauthenticated" };
};

/**
 * The adapter for the Gemini CLI (`gemini`), driven over its ACP endpoint.
 * A turn runs with full autonomy; `readOnly: true` denies every tool that
 * could change the machine. `model` passes through in Gemini's own vocabulary
 * (pin one — the CLI's automatic routing can spend minutes on trivial
 * prompts). System prompt and structured output are emulated. `models()`
 * lists the documented vocabulary — aliases and full ids — as a hint.
 * A session always starts fresh: reattachment is broken upstream (#15502), so
 * `resume` throws.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { geminiCli } from "anyagent-js/gemini-cli";
 *
 * const result = await create(geminiCli()).run("summarize this repo");
 * ```
 */
export const geminiCli = (): AcpAdapter<typeof CAPS> => ({
  acp: {
    // Without --skip-trust the endpoint downgrades its approval mode with only
    // a stderr notice, so a live turn would silently lose its autonomy.
    command: ["gemini", "--acp", "--skip-trust"],
    // No `readOnly` here: plan mode's exit_plan_mode self-approves headless, so
    // the mode would be a false guarantee; permission denial holds the line.
    settings: ({ model }) => ({ args: model ? ["-m", model] : [] }),
  },
  authStatus,
  capabilities: CAPS,
  detection: {},
  listModels,
  meta: { bin: ["gemini"], id: "gemini-cli", name: "Gemini CLI" },
  mode: "acp",
});
