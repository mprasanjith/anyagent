import { AgentImpl } from "./internal/agent.js";
import { BUILTINS } from "./internal/builtins.js";
import { runDetect } from "./internal/detect.js";
import { realProbe } from "./internal/runtime/spawn.js";
import type {
  Adapter,
  Agent,
  Detection,
  DetectResult,
  VersionProbe,
} from "./types.js";

/**
 * Build a runnable {@link Agent}. Accepts either an adapter directly —
 * `create(claudeCode())` when you know which CLI you want — or one of
 * `detect()`'s results when you want whatever is installed.
 */
export const create = (source: Adapter | DetectResult): Agent =>
  new AgentImpl("adapter" in source ? source.adapter : source);

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
 * capability table; pass the one you pick to `create()`. The list follows
 * the adapter registry order, which carries no ranking — there is no "best"
 * agent — and is empty when nothing is installed.
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
      (d): d is Detection & { path: string } =>
        d.installed && d.path !== undefined
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
