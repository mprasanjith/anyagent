import { AnyAgentError } from "./errors.js";
import type {
  AcpAdapter,
  AuthStatus,
  Capabilities,
  ModelInfo,
  SessionOptions,
  SystemProbe,
} from "./types.js";

const CAPS = {
  attachments: false,
  authStatus: "native",
  cwd: "native",
  // No reasoningEfforts list on purpose: effort rides in the model id's
  // bracket overrides, whose accepted values are per-model — the CLI itself
  // is the authority on validity.
  effort: "native",
  // The endpoint advertises mcpCapabilities, but no recorded run confirms a
  // server of ours reaches it.
  mcp: false,
  modelListing: "native",
  modelSelection: "native",
  // The `mode` config option offers `plan`, which the CLI enforces read-only
  // (live-verified: writes are refused, exit 0, no file).
  readOnly: "native",
  // The endpoint advertises `loadSession` (test/fixtures/acp/cursor.jsonl).
  resume: "native",
  sessionFork: false,
  streaming: "native",
  // A turn carries content blocks and nothing else, so neither has a channel
  // of its own.
  structuredOutput: "emulated",
  systemPrompt: "emulated",
  // `agent status` reports identity only — no plan or window fields
  // (verified live); Cursor's usage surface is its web dashboard.
  usageStatus: false,
} as const satisfies Capabilities;

// biome-ignore lint/suspicious/noExplicitAny: the CLI's JSON is dynamically shaped.
type Json = any;

// Effort's only surface is the bracket-override vocabulary inside the model
// id (there is no standalone flag), so it compiles into the model string; a
// caller-supplied bracket list gains effort as one more override.
const modelWithEffort = (
  opts: Pick<SessionOptions, "effort" | "model">
): string | undefined => {
  if (opts.effort === undefined) {
    return opts.model;
  }
  if (opts.model === undefined) {
    throw new AnyAgentError(
      "InvalidOptions",
      "cursor: effort is a bracket override on the model id, so it requires model"
    );
  }
  return opts.model.endsWith("]")
    ? `${opts.model.slice(0, -1)},effort=${opts.effort}]`
    : `${opts.model}[effort=${opts.effort}]`;
};

const authStatus = async (probe: SystemProbe): Promise<AuthStatus> => {
  let res: { stdout: string; stderr: string; code: number };
  try {
    res = await probe.exec("agent", ["status", "--format", "json"]);
  } catch {
    return { billing: "unknown", state: "unknown" };
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return res.code === 0
      ? { billing: "unknown", state: "unknown" }
      : { billing: "unknown", state: "unauthenticated" };
  }
  if (res.code !== 0 || parsed?.isAuthenticated !== true) {
    return { billing: "unknown", state: "unauthenticated" };
  }
  // Every Cursor login bills the Cursor account's plan — there is no BYOK
  // path on this CLI.
  return { billing: "subscription", state: "authenticated" };
};

// One model per `<id> - <label>` line; the header and the trailing tip line
// contain no ` - ` separator, so the shape alone filters them out.
const MODEL_LINE = /^(?<id>\S+) - \S.*$/u;

const listModels = async (probe: SystemProbe): Promise<ModelInfo[]> => {
  let res: { stdout: string; stderr: string; code: number };
  try {
    res = await probe.exec("agent", ["--list-models"]);
  } catch (error) {
    throw AnyAgentError.wrap(error);
  }
  if (res.code !== 0) {
    throw new AnyAgentError(
      "Invocation",
      `agent --list-models exited ${res.code}`,
      { argv: ["agent", "--list-models"], stderr: res.stderr }
    );
  }
  const models: ModelInfo[] = [];
  for (const line of res.stdout.split("\n")) {
    const match = MODEL_LINE.exec(line.trim());
    const id = match?.groups?.id;
    if (id) {
      models.push({ id, raw: match[0] });
    }
  }
  if (models.length === 0) {
    throw new AnyAgentError("Parse", "agent --list-models listed no models", {
      raw: res.stdout,
    });
  }
  return models;
};

/**
 * The adapter for the Cursor CLI, detected as the `agent` binary (legacy
 * `cursor-agent` also resolves) and driven over `agent acp`. A default run has
 * full autonomy; `readOnly: true` confines it to Cursor's enforced plan mode.
 * `model` takes any id from `models()`, including bracket overrides like
 * `"claude-opus-4-8[context=1m,effort=high]"`; `effort` composes into those
 * brackets and therefore requires `model`. `resume` continues a prior chat
 * using the id from {@link RunResult.sessionId}. `authStatus()` asks
 * `agent status`; `models()` asks `agent --list-models`.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { cursor } from "anyagent-js/cursor";
 *
 * const result = await create(cursor()).run("summarize this repo");
 * ```
 *
 * System prompts and structured output are emulated: a turn carries content
 * blocks only. MCP servers are undeclared; Cursor manages them through
 * `agent mcp` configuration.
 */
export const cursor = (): AcpAdapter<typeof CAPS> => ({
  acp: {
    command: ["agent", "acp"],
    // Cursor also advertises `session/set_mode`; the config option is the one
    // channel it shares with the rest of the ACP-mode adapters.
    readOnly: { configId: "mode", value: "plan" },
    settings: ({ effort, model }) => {
      const value = modelWithEffort({ effort, model });
      return { configOptions: value ? [{ configId: "model", value }] : [] };
    },
  },
  authStatus,
  capabilities: CAPS,
  detection: {},
  listModels,
  meta: { bin: ["agent", "cursor-agent"], id: "cursor", name: "Cursor" },
  mode: "acp",
});
