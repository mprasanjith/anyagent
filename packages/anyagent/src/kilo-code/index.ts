import { opencodeFamilyAdapter } from "../internal/opencode-family.js";
import type { Adapter } from "../types.js";

/**
 * The adapter for Kilo Code's CLI. Kilo is an opencode fork and exposes the
 * identical `kilo run --format json` surface — same flags, same
 * `step_start`/`text`/`tool_use`/`step_finish` stream — verified against real
 * `kilo` output, not assumed from the lineage. See the opencode adapter for
 * the shared behavior: prompt over stdin, `--auto` for `auto`,
 * `--session <sessionId>` for `resume` (id on `RunResult.raw.sessionId`),
 * models as `provider/model`.
 *
 * ```ts
 * import { create } from "anyagent";
 * import { kiloCode } from "anyagent/kilo-code";
 *
 * const result = await create(kiloCode()).run("summarize this repo");
 * ```
 */
export const kiloCode = (): Adapter =>
  opencodeFamilyAdapter({
    bin: ["kilo", "kilocode"],
    id: "kilo-code",
    name: "Kilo Code",
  });
