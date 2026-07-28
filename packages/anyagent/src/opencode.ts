import {
  type OpencodeFamilyCapabilities,
  opencodeFamilyAdapter,
} from "./internal/opencode-family.js";
import type { Adapter } from "./types.js";

/**
 * The adapter for opencode (`opencode`). A run gets the CLI's full
 * autonomy by default; `readOnly: true` denies file edits and shell for the
 * run — the adapter owns the `OPENCODE_PERMISSION` env var to guarantee that,
 * so a value you pass in `env` under that key is overridden. `resume`
 * continues a session using the id from `RunResult.sessionId`; `effort`
 * passes a provider-defined variant name to the CLI verbatim.
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
 * accepts. `authStatus()` answers from opencode's credential store and the
 * standard provider key env vars — a hint, not a guarantee. System prompts,
 * MCP servers, and per-tool permissions live in opencode.json rather than
 * flags; reach them via config or `extraArgs`.
 */
/**
 * opencode's capabilities: the family's, with sessions live — the ACP
 * transcript at `test/fixtures/acp/opencode.jsonl` backs the native tier.
 * Kilo keeps the family's emulated tier until it records its own.
 */
export type OpencodeCapabilities = Omit<
  OpencodeFamilyCapabilities,
  "session"
> & { readonly session: "native" };

export const opencode = (): Adapter<OpencodeCapabilities> => {
  const adapter = opencodeFamilyAdapter({
    dataDir: "opencode",
    meta: { bin: ["opencode"], id: "opencode", name: "opencode" },
    permissionEnv: "OPENCODE_PERMISSION",
  });
  return {
    ...adapter,
    capabilities: { ...adapter.capabilities, session: "native" as const },
  };
};
