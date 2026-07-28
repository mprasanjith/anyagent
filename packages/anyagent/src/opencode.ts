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
 * standard provider key env vars — a hint, not a guarantee. `mcp` servers ride
 * the adapter-owned `OPENCODE_CONFIG_CONTENT` env var, each under the name you
 * key it by, added to whatever the machine already configures; a config
 * document you pass in `env` under that key is merged, not dropped. System
 * prompts and per-tool permissions live in opencode.json rather than flags;
 * reach them via config or `extraArgs`.
 */
/**
 * opencode's capabilities: the family's, with ACP-mode sessions — the ACP
 * transcript at `test/fixtures/acp/opencode.jsonl` backs the mode — and MCP on,
 * which `OPENCODE_CONFIG_CONTENT` carries per run. Kilo keeps the family's
 * stdout mode and no MCP until each is verified against its binary.
 */
export type OpencodeCapabilities = Omit<
  OpencodeFamilyCapabilities,
  "mcp" | "session"
> & { readonly mcp: "native"; readonly session: "acp" };

export const opencode = (): Adapter<OpencodeCapabilities> => {
  const adapter = opencodeFamilyAdapter({
    // Verified on 1.18.4: the CLI merges this document over the user's own
    // config rather than replacing it, so a run's servers add to what the
    // machine already has instead of hiding it.
    configEnv: "OPENCODE_CONFIG_CONTENT",
    dataDir: "opencode",
    meta: { bin: ["opencode"], id: "opencode", name: "opencode" },
    permissionEnv: "OPENCODE_PERMISSION",
  });
  return {
    ...adapter,
    capabilities: {
      ...adapter.capabilities,
      mcp: "native" as const,
      session: "acp" as const,
    },
  };
};
