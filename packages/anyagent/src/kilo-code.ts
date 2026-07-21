import { opencodeFamilyAdapter } from "./internal/opencode-family.js";
import type { Adapter } from "./types.js";

/**
 * The adapter for Kilo Code's CLI (`kilo`). Kilo is an opencode fork with the
 * identical headless surface — verified against real `kilo` output, not
 * assumed from the lineage. It behaves like the opencode adapter: `auto`
 * auto-approves, `resume` continues a session (id on
 * `RunResult.raw.sessionId`), and models use `provider/model` form.
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
