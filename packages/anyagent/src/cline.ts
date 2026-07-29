import type {
  AcpAdapter,
  AuthStatus,
  Capabilities,
  SystemProbe,
} from "./types.js";

const CAPS = {
  // The endpoint takes a resource_link and tells the model nothing was
  // attached: it advertises `embeddedContext: false`, and a live turn asked for
  // the attached file's path answered "NONE" (3.0.46).
  attachments: false,
  // Never exec for auth: cline's config subcommand needs a TTY headless.
  authStatus: "probed",
  cwd: "native",
  // The endpoint's session config options are model and provider, nothing else.
  effort: false,
  // MCP servers are cline's own `cline mcp` config, not a per-session channel.
  mcp: false,
  modelListing: false,
  modelSelection: "native",
  // Permission denial is the guarantee, live-verified against a mutating turn:
  // cline asked before every attempt (`run_commands` as `execute`,
  // `apply_patch` as `other` — no read-only kind among them), and rejecting
  // each one left the file uncreated.
  readOnly: "emulated",
  // ACP mode, gated on a recorded real transcript (sessions.md §6 M-2):
  // test/fixtures/acp/cline.jsonl — initialize on protocolVersion 1, a session
  // id, an agent_message_chunk streaming "pong", stopReason end_turn. The build
  // advertises `loadSession: true`, so resume reattaches over the same endpoint.
  resume: "native",
  sessionFork: false,
  streaming: "native",
  structuredOutput: "emulated",
  systemPrompt: "emulated",
  // The first-party provider's credits are metered server-side; no CLI
  // command reports the balance.
  usageStatus: false,
} as const satisfies Capabilities;

// biome-ignore lint/suspicious/noExplicitAny: the CLI's JSON is dynamically shaped.
type Json = any;

// Provider settings live at <data>/settings/providers.json. Precedence,
// live-verified on 3.0.46: CLINE_PROVIDER_SETTINGS_PATH names the exact
// file; CLINE_DATA_DIR is the data dir itself; CLINE_DIR keeps the data/
// level; then the default under the home directory. First existing file
// wins.
const providersPaths = (probe: SystemProbe): string[] => {
  const paths: string[] = [];
  if (probe.env.CLINE_PROVIDER_SETTINGS_PATH) {
    paths.push(probe.env.CLINE_PROVIDER_SETTINGS_PATH);
  }
  if (probe.env.CLINE_DATA_DIR) {
    paths.push(`${probe.env.CLINE_DATA_DIR}/settings/providers.json`);
  }
  if (probe.env.CLINE_DIR) {
    paths.push(`${probe.env.CLINE_DIR}/data/settings/providers.json`);
  }
  paths.push(`${probe.homedir()}/.cline/data/settings/providers.json`);
  return paths;
};

const authStatus = async (probe: SystemProbe): Promise<AuthStatus> => {
  // Candidates are read concurrently; precedence is decided by list order —
  // the first path with a readable file wins.
  const paths = providersPaths(probe);
  const bodies = await Promise.all(paths.map((p) => probe.readFile(p)));
  const index = bodies.findIndex((b) => b !== undefined);
  const body = bodies[index];
  if (body === undefined) {
    return { billing: "unknown", state: "unauthenticated" };
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { billing: "unknown", state: "unknown" };
  }
  const providers = Object.keys(parsed?.providers ?? {});
  if (providers.length === 0) {
    return { billing: "unknown", state: "unauthenticated" };
  }
  // BYOK provider keys are metered; the first-party `cline` provider is
  // credits whose semantics the CLI never states, so it asserts nothing.
  const billing = providers.includes("cline") ? "unknown" : "api-key";
  return { billing, providers, state: "authenticated" };
};

/**
 * The adapter for Cline's CLI (`cline`), driven over its ACP endpoint
 * (`cline --acp`). Cline is BYOK: configure a provider once via
 * `cline auth -p <provider> -k <key>` (e.g. openrouter). `authStatus()` reports
 * which providers are configured, read from cline's provider settings.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { cline } from "anyagent-js/cline";
 *
 * const result = await create(cline()).run("summarize this repo");
 * ```
 *
 * `model` selects the session's model: pin one, because a session that leaves
 * it unset inherits cline's stored choice, which need not be a model the
 * signed-in provider serves, and the turn then ends with no output.
 * `readOnly: true` denies every tool outside the read-only kinds for the turn.
 * Reasoning effort, MCP servers and attachments have no channel on the endpoint
 * and throw; system prompts and structured output are provided by AnyAgent.
 */
export const cline = (): AcpAdapter<typeof CAPS> => ({
  acp: {
    command: ["cline", "--acp"],
    // No `readOnly` option here: cline's ACP endpoint offers plan mode, but
    // plan mode still runs shell commands, so permission denial is what holds
    // the line.
    settings: ({ model }) => ({
      configOptions:
        model === undefined ? [] : [{ configId: "model", value: model }],
    }),
  },
  authStatus,
  capabilities: CAPS,
  detection: {},
  meta: { bin: ["cline"], id: "cline", name: "Cline" },
  mode: "acp",
});
