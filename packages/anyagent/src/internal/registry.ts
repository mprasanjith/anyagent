import { claudeCode } from "../claude-code/index.js";
import { codex } from "../codex/index.js";
import { runDetect } from "./detect.js";
import { realProbe } from "./runtime/spawn.js";
import type {
  Adapter,
  Detection,
  DetectResult,
  VersionProbe,
} from "./types.js";

/** Built-in adapters. A new adapter appends its factory result here. */
export const BUILTINS: Adapter[] = [claudeCode(), codex()];

/**
 * Overrides for {@link detect}. `adapters` swaps the built-in list for your
 * own — scan a subset, or include a custom adapter. `probe` swaps the real
 * PATH-and-exec probe for a fake, letting tests simulate any machine without
 * spawning processes.
 */
export interface DetectOptions {
  adapters?: Adapter[];
  probe?: VersionProbe;
}

/**
 * Find every supported coding agent installed on this machine. Each result
 * carries the resolved binary path, the reported version, and the adapter's
 * capability table; pass the one you pick to `create()`. The list is
 * unordered — there is no "best" agent and no ranking — and empty when
 * nothing is installed.
 *
 * ```ts
 * const installed = await detect();
 * const agent = create(installed[0] ?? claudeCode());
 * ```
 */
export const detect = async (
  opts: DetectOptions = {}
): Promise<DetectResult[]> => {
  const adapters = opts.adapters ?? BUILTINS;
  const probe = opts.probe ?? realProbe;
  const results = await Promise.all(adapters.map((a) => runDetect(a, probe)));
  return results
    .filter(
      (d): d is Detection & { path: string } => d.installed && d.path !== null
    )
    .map((d) => ({
      adapter: d.adapter,
      capabilities: d.capabilities,
      id: d.id,
      name: d.name,
      path: d.path,
      version: d.version,
    }));
};
