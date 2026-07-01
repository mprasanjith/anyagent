import { claudeCode } from "../claude-code/index.js";
import { runDetect } from "./detect.js";
import { realProbe } from "./runtime/spawn.js";
import type { Adapter, DetectResult, VersionProbe } from "./types.js";

/** Built-in adapters. A new adapter appends its factory result here. */
export const BUILTINS: Adapter[] = [claudeCode()];

export interface DetectOptions {
  adapters?: Adapter[];
  probe?: VersionProbe;
}

/**
 * Every supported coding agent installed on this machine, as an unordered list.
 * There is no "best" agent and no ranking; the caller picks one. Empty when none
 * are installed.
 */
export const detect = async (
  opts: DetectOptions = {}
): Promise<DetectResult[]> => {
  const adapters = opts.adapters ?? BUILTINS;
  const probe = opts.probe ?? realProbe;
  const results = await Promise.all(adapters.map((a) => runDetect(a, probe)));
  return results.filter((r) => r.installed);
};
