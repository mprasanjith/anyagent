import {
  type OpencodeFamilyCapabilities,
  opencodeFamilyAdapter,
} from "./internal/opencode-family.js";
import type { AcpAdapter, UsageStatus, UsageWindow } from "./types.js";

/**
 * opencode's capabilities: the family's, plus the Zen gateway's meter —
 * the ACP transcript at `test/fixtures/acp/opencode.jsonl` backs the rest.
 * `effort` stays off: the endpoint's session advertises `model` and `mode`
 * options and nothing for reasoning effort.
 */
export type OpencodeCapabilities = Omit<
  OpencodeFamilyCapabilities,
  "usageStatus"
> & {
  readonly usageStatus: "remote";
};

// opencode's own gateway. A BYOK provider's quota is not here — this reports
// the Zen plan alone, which is what the CLI's own login pays for.
const ZEN_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

// Only `weekly` has a length its name fixes. A rolling window's span is not
// stated, and a month is not a constant number of minutes, so both leave
// `windowMinutes` absent rather than assert a wrong one.
const WINDOW_MINUTES: Record<string, number | undefined> = {
  monthly: undefined,
  rolling: undefined,
  weekly: 10_080,
};

// biome-ignore lint/suspicious/noExplicitAny: the gateway's JSON is dynamically shaped.
type Json = any;

const windowOf = (label: string, raw: Json): UsageWindow | undefined => {
  if (typeof raw?.percent !== "number" || !Number.isFinite(raw.percent)) {
    return;
  }
  const window: UsageWindow = { label, usedPercent: raw.percent };
  const resetsAt = Date.parse(raw.resetsAt);
  if (!Number.isNaN(resetsAt)) {
    window.resetsAt = new Date(resetsAt);
  }
  const minutes = WINDOW_MINUTES[label];
  if (minutes !== undefined) {
    window.windowMinutes = minutes;
  }
  return window;
};

/**
 * Map `GET /zen/go/v1/usage` onto a status. The gateway states each window's
 * own standing in `status`, so exhaustion is read from its word rather than
 * inferred from a percentage that has been seen to sit below 100 while the
 * window is already refusing work.
 */
const toStatus = (body: unknown): UsageStatus | undefined => {
  const usage = (body as Json)?.usage;
  if (!usage || typeof usage !== "object") {
    return;
  }
  const windows = Object.keys(WINDOW_MINUTES)
    .map((label) => windowOf(label, usage[label]))
    .filter((w): w is UsageWindow => w !== undefined);
  if (windows.length === 0) {
    return;
  }
  const limited = Object.keys(WINDOW_MINUTES).some(
    (label) => usage[label]?.status === "rate-limited"
  );
  return {
    asOf: new Date(),
    state: limited ? "exhausted" : "ok",
    windows,
  };
};

/**
 * The adapter for opencode (`opencode`). Every turn runs over the CLI's ACP
 * endpoint, `opencode acp`, on a connection `agent.session()` holds open.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { opencode } from "anyagent-js/opencode";
 *
 * const result = await create(opencode()).run("summarize this repo");
 * ```
 *
 * Models use opencode's `provider/model` form (e.g.
 * `"openrouter/openai/gpt-4o-mini"`); `models()` lists every id the CLI
 * accepts, and a session sets the one you pick as its `model` option.
 * `readOnly: true` switches the session into plan mode and denies every tool
 * that is not reading. `resume` continues a conversation from
 * `RunResult.sessionId`; `fork: true` branches it instead. `mcp` servers reach
 * the agent with the session, each under the name you key it by. Attachments
 * ride the prompt as resource links. `authStatus()` answers from opencode's
 * credential store and the standard provider key env vars — a hint, not a
 * guarantee. System prompts and per-tool permissions live in opencode.json.
 *
 * `usageStatus()` reports the Zen plan's rolling, weekly, and monthly
 * windows. It reaches opencode's gateway, so it answers only under
 * `create(opencode(), { network: true })` and only for the Zen key the CLI
 * stored at login (or `OPENCODE_GO_API_KEY`) — a BYOK provider's own quota
 * is metered at that provider, where nothing here can see it.
 */
export const opencode = (): AcpAdapter<OpencodeCapabilities> => {
  const adapter = opencodeFamilyAdapter({
    dataDir: "opencode",
    meta: { bin: ["opencode"], id: "opencode", name: "opencode" },
    usage: {
      keyEnv: ["OPENCODE_GO_API_KEY"],
      storeProvider: "opencode-go",
      toStatus,
      url: ZEN_USAGE_URL,
    },
  });
  return {
    ...adapter,
    capabilities: { ...adapter.capabilities, usageStatus: "remote" as const },
  };
};
