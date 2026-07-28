import {
  type OpencodeFamilyCapabilities,
  opencodeFamilyAdapter,
} from "./internal/opencode-family.js";
import type { AcpAdapter } from "./types.js";

/**
 * Kilo's capabilities: the family's, plus reasoning effort — the ACP
 * transcript at `test/fixtures/acp/kilo.jsonl` backs them, its session
 * advertising an `effort` option beside `model` and `mode`.
 */
export type KiloCodeCapabilities = Omit<
  OpencodeFamilyCapabilities,
  "effort"
> & {
  readonly effort: "native";
};

/**
 * The adapter for Kilo Code's CLI (`kilo`). Kilo is an opencode fork with the
 * identical ACP endpoint — verified against real `kilo` output, not assumed
 * from the lineage — so every turn runs over `kilo acp`, on a connection
 * `agent.session()` holds open.
 *
 * ```ts
 * import { create } from "anyagent-js";
 * import { kiloCode } from "anyagent-js/kilo-code";
 *
 * const result = await create(kiloCode()).run("summarize this repo");
 * ```
 *
 * Models use `provider/model` form; `models()` lists every id the CLI accepts,
 * and a session sets the one you pick as its `model` option. `effort` sets the
 * session's effort level, from a list the endpoint scopes to that session's
 * model — it judges the value, so a name one model accepts can be refused
 * under another. `readOnly: true` switches the session into plan mode and
 * denies every tool that is not reading. `resume` continues a conversation
 * from `RunResult.sessionId`; `fork: true` branches it instead. `mcp` servers
 * reach the agent with the session, each under the name you key it by.
 * Attachments ride the prompt as resource links. `authStatus()` answers from
 * kilo's credential store and the standard provider key env vars — a hint, not
 * a guarantee.
 */
export const kiloCode = (): AcpAdapter<KiloCodeCapabilities> => {
  const adapter = opencodeFamilyAdapter({
    acpEffort: "effort",
    dataDir: "kilo",
    meta: { bin: ["kilo", "kilocode"], id: "kilo-code", name: "Kilo Code" },
  });
  return {
    ...adapter,
    capabilities: { ...adapter.capabilities, effort: "native" as const },
  };
};
