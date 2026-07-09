import { opencodeFamilyAdapter } from "../internal/opencode-family.js";
import type { Adapter } from "../internal/types.js";

/**
 * The adapter for opencode. Drives `opencode run --format json` with the
 * prompt piped over stdin, mapping the `step_start`/`text`/`tool_use`/
 * `step_finish` event stream onto normalized events. `edit` runs the CLI's
 * default behavior (its own permission config applies); `auto` adds
 * `--auto`. `resume` runs `opencode run --session <sessionId>`, where the
 * session id comes from `RunResult.raw.sessionId` of a prior run.
 *
 * ```ts
 * import { create } from "anyagent";
 * import { opencode } from "anyagent/opencode";
 *
 * const result = await create(opencode()).run("summarize this repo");
 * ```
 *
 * Models use opencode's `provider/model` form (e.g.
 * `"openrouter/openai/gpt-4o-mini"`). System prompts, MCP servers, and
 * per-tool permissions live in opencode.json rather than flags; reach them
 * via config or `extraArgs`. There is no read-only level — a config-denied
 * permission can hang a non-interactive run waiting for an approval that
 * never comes.
 */
export const opencode = (): Adapter =>
  opencodeFamilyAdapter({
    bin: ["opencode"],
    id: "opencode",
    name: "opencode",
  });
