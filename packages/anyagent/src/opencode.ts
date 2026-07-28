import {
  type OpencodeFamilyCapabilities,
  opencodeFamilyAdapter,
} from "./internal/opencode-family.js";
import type { AcpAdapter } from "./types.js";

/**
 * opencode's capabilities: the family's as they stand — the ACP transcript at
 * `test/fixtures/acp/opencode.jsonl` backs them. `effort` stays off: the
 * endpoint's session advertises `model` and `mode` options and nothing for
 * reasoning effort.
 */
export type OpencodeCapabilities = OpencodeFamilyCapabilities;

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
 */
export const opencode = (): AcpAdapter<OpencodeCapabilities> =>
  opencodeFamilyAdapter({
    dataDir: "opencode",
    meta: { bin: ["opencode"], id: "opencode", name: "opencode" },
  });
