import {
  type OpencodeFamilyCapabilities,
  opencodeFamilyAdapter,
} from "./internal/opencode-family.js";
import type { Adapter } from "./types.js";

/**
 * The adapter for Kilo Code's CLI (`kilo`). Kilo is an opencode fork with the
 * identical headless surface — verified against real `kilo` output, not
 * assumed from the lineage — and behaves like the opencode adapter: full
 * full autonomy by default, `readOnly: true` denies file edits and
 * shell (the adapter owns the `KILO_PERMISSION` env var, overriding a value
 * you pass in `env` under that key), `resume` continues a session using
 * `RunResult.sessionId`, `effort` passes a provider-defined variant name
 * verbatim, and models use `provider/model` form. `authStatus()` answers
 * from kilo's credential store and the standard provider key env vars — a
 * hint, not a guarantee.
 *
 * ```ts
 * import { create } from "anyagent";
 * import { kiloCode } from "anyagent/kilo-code";
 *
 * const result = await create(kiloCode()).run("summarize this repo");
 * ```
 */
export const kiloCode = (): Adapter<OpencodeFamilyCapabilities> =>
  opencodeFamilyAdapter({
    dataDir: "kilo",
    meta: { bin: ["kilo", "kilocode"], id: "kilo-code", name: "Kilo Code" },
    permissionEnv: "KILO_PERMISSION",
  });
