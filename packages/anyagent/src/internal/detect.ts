import type { Adapter, Detection, VersionProbe } from "./types.js";

const DEFAULT_VERSION_COMMAND = ["--version"];
const DEFAULT_VERSION_REGEX = /(?<version>\d+\.\d+\.\d+\S*)/u;

/**
 * The built-in detection an adapter gets when it does not supply its own
 * `detect`: resolve the first of `meta.bin` on `PATH`, then read the version
 * per the adapter's {@link DetectionSpec}. A missing binary yields
 * `installed: false`; a failing version probe never blocks use — `version`
 * just stays absent.
 */
export const defaultDetect = async (
  adapter: Adapter,
  probe: VersionProbe
): Promise<Detection> => {
  const base = {
    adapter,
    capabilities: adapter.capabilities,
    id: adapter.meta.id,
    name: adapter.meta.name,
  };

  // The first *declared* bin wins, even if a later one resolves faster.
  const resolved = await Promise.all(
    adapter.meta.bin.map((bin) => probe.which(bin))
  );
  const path = resolved.find((p): p is string => Boolean(p));
  if (!path) {
    return { ...base, installed: false };
  }

  const versionArgs =
    adapter.detection.versionCommand ?? DEFAULT_VERSION_COMMAND;
  const versionRegex = adapter.detection.versionRegex ?? DEFAULT_VERSION_REGEX;
  let version: string | undefined;
  try {
    const { stdout, stderr } = await probe.exec(path, versionArgs);
    version = `${stdout}${stderr}`.match(versionRegex)?.[1];
  } catch {
    // A version probe that errors doesn't block use; version stays absent.
  }
  return { ...base, installed: true, path, version };
};

/**
 * Detect one agent: the adapter's own `detect` when present, else
 * {@link defaultDetect}.
 */
export const runDetect = (
  adapter: Adapter,
  probe: VersionProbe
): Promise<Detection> =>
  adapter.detect ? adapter.detect(probe) : defaultDetect(adapter, probe);
