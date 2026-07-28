import { AgentImpl } from "./internal/agent.js";
import { BUILTINS } from "./internal/builtins.js";
import { runDetect } from "./internal/detect.js";
import { realProbe } from "./internal/runtime/spawn.js";
import type {
  Adapter,
  Agent,
  Capabilities,
  Detection,
  DetectResult,
  SystemProbe,
  VersionProbe,
} from "./types.js";

/**
 * Overrides for {@link create}. `probe` swaps the machine `authStatus()` and
 * `models()` consult for a fake, letting tests simulate any credentials and
 * files without touching the real system.
 */
export interface CreateOptions {
  probe?: SystemProbe;
}

/**
 * Build a runnable {@link Agent}. Accepts either an adapter directly —
 * `create(claudeCode())` when you know which CLI you want — or one of
 * `detect()`'s results when you want whatever is installed.
 *
 * From an adapter factory the agent is typed to that adapter's literal
 * capabilities, so an unsupported option fails to compile; from a
 * `detect()` result they are dynamic and {@link Agent.supports} is the
 * honest gate.
 */
export const create = <C extends Capabilities = Capabilities>(
  source: Adapter<C> | DetectResult,
  opts: CreateOptions = {}
): Agent<C> => {
  const adapter = ("adapter" in source ? source.adapter : source) as Adapter<C>;
  return new AgentImpl(adapter, { probe: opts.probe });
};

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
 * capabilities; pass the one you pick to `create()`. The list follows
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
