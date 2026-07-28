import {
  type OpencodeFamilyCapabilities,
  opencodeFamilyAdapter,
} from "./internal/opencode-family.js";
import type { Adapter } from "./types.js";

/**
 * Kilo's capabilities: the family's, with ACP-mode sessions. The recorded
 * handshake at `test/fixtures/acp/kilo-handshake.jsonl` backs the mode —
 * protocol v1, `loadSession`, `sessionCapabilities.fork`, and a `session/new`
 * carrying the `model`, `effort`, and `mode` options the family's spec drives.
 */
export type KiloCodeCapabilities = Omit<
  OpencodeFamilyCapabilities,
  "mcp" | "session"
> & { readonly mcp: "native"; readonly session: "acp" };

/**
 * The adapter for Kilo Code's CLI (`kilo`). Kilo is an opencode fork with the
 * identical headless surface — verified against real `kilo` output, not
 * assumed from the lineage — and behaves like the opencode adapter: full
 * autonomy by default, `readOnly: true` denies file edits and
 * shell (the adapter owns the `KILO_PERMISSION` env var, overriding a value
 * you pass in `env` under that key), `resume` continues a session using
 * `RunResult.sessionId`, `effort` passes a provider-defined variant name
 * verbatim, models use `provider/model` form, and `mcp` servers ride the
 * adapter-owned `KILO_CONFIG_CONTENT` env var, merged into the machine's own
 * configured servers rather than replacing them. Sessions run in ACP mode, over
 * `kilo acp`: `agent.session()` holds one connection, `fork: true` branches
 * through `session/fork`, `readOnly` switches the session into plan mode, and
 * `effort` sets the session's effort level. Both modes pass `effort` through
 * verbatim and let kilo judge it, but they judge differently: a one-shot run's
 * `--variant` takes any provider-defined name, while a session's effort is a
 * closed list scoped to that session's model, so a name a run accepts can still
 * be refused in a session.
 * `authStatus()` answers from kilo's credential store and the standard
 * provider key env vars — a hint, not a guarantee.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { kiloCode } from "anyagent-js/kilo-code";
 *
 * const result = await create(kiloCode()).run("summarize this repo");
 * ```
 */
export const kiloCode = (): Adapter<KiloCodeCapabilities> => {
  const adapter = opencodeFamilyAdapter({
    acpEffort: "effort",
    configEnv: "KILO_CONFIG_CONTENT",
    dataDir: "kilo",
    meta: { bin: ["kilo", "kilocode"], id: "kilo-code", name: "Kilo Code" },
    permissionEnv: "KILO_PERMISSION",
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
