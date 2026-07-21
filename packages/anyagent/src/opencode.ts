import { opencodeFamilyAdapter } from "./internal/opencode-family.js";
import type { Adapter } from "./types.js";

/**
 * The adapter for opencode (`opencode`). `edit` runs the CLI's default
 * behavior (its own permission config applies); `auto` auto-approves.
 * `resume` continues a session, whose id comes from
 * `RunResult.raw.sessionId` of a prior run.
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
