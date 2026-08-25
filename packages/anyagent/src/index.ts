import { AgentImpl } from "./internal/agent.js";
import { BUILTINS } from "./internal/builtins.js";
import { runDetect } from "./internal/detect.js";
import { realProbe, realSystemProbe } from "./internal/runtime/spawn.js";
import type {
  Adapter,
  Agent,
  Capabilities,
  Detection,
  DetectResult,
  FetchLike,
  SystemProbe,
  VersionProbe,
} from "./types.js";

/**
 * How an agent may reach the network, and with whose `fetch`.
 *
 * `true` uses the platform `fetch`; an object supplies your own — for a
 * proxy, a timeout or retry policy, request logging, or a test double.
 * `false` is an explicit kill switch that holds even against a
 * {@link CreateOptions.probe} carrying its own `fetch`.
 */
export type NetworkOptions = boolean | { fetch?: FetchLike };

/**
 * Overrides for {@link create}. `probe` swaps the machine `authStatus()` and
 * `models()` consult for a fake, letting tests simulate any credentials and
 * files without touching the real system.
 *
 * `network` turns on egress, which is off by default. An agent without it
 * reads only local state, so an adapter whose usage lives solely at its
 * vendor (`usageStatus: "remote"`) answers `{ state: "unknown" }`. Turning it
 * on lets that adapter send the credential its CLI already stores to that
 * CLI's own vendor, and nowhere else. Adapters declaring `"native"` or
 * `"probed"` never need it, though some sharpen a cached answer into a live
 * one when it is present — {@link UsageStatus.asOf} is what reports
 * freshness.
 *
 * ```ts
 * const agent = create(cursor(), { network: true });
 * const agent = create(cursor(), { network: { fetch: viaProxy } });
 * ```
 *
 * Omitting `network` leaves a supplied `probe`'s own `fetch` in place, since
 * injecting one is itself the opt-in; setting it overrides that either way.
 */
export interface CreateOptions {
  network?: NetworkOptions;
  probe?: SystemProbe;
}

// The `fetch` an agent gets, or `undefined` for "no egress".
const resolveFetch = (network: NetworkOptions): FetchLike | undefined => {
  if (network === false) {
    return;
  }
  if (network === true) {
    return globalThis.fetch;
  }
  return network.fetch ?? globalThis.fetch;
};

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
  return new AgentImpl(adapter, {
    probe:
      opts.network === undefined
        ? opts.probe
        : {
            ...(opts.probe ?? realSystemProbe),
            fetch: resolveFetch(opts.network),
          },
  });
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
