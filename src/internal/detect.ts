import type { Adapter, DetectResult, VersionProbe } from "./types.js";

const DEFAULT_VERSION_COMMAND = ["--version"];
const DEFAULT_VERSION_REGEX = /(?<version>\d+\.\d+\.\d+\S*)/u;

export const defaultDetect = async (
  adapter: Adapter,
  probe: VersionProbe
): Promise<DetectResult> => {
  const base = {
    adapter,
    capabilities: adapter.capabilities,
    id: adapter.meta.id,
    name: adapter.meta.name,
  };

  // First bin that resolves wins; probe all in parallel, keep declared order.
  const resolved = await Promise.all(
    adapter.meta.bin.map((b) => probe.which(b))
  );
  const path = resolved.find((p): p is string => Boolean(p)) ?? null;
  if (!path) {
    return { ...base, installed: false, path: null, version: null };
  }

  const cmd = adapter.detection.versionCommand ?? DEFAULT_VERSION_COMMAND;
  const regex = adapter.detection.versionRegex ?? DEFAULT_VERSION_REGEX;
  let version: string | null = null;
  try {
    const { stdout, stderr } = await probe.exec(path, cmd);
    version = `${stdout}${stderr}`.match(regex)?.[1] ?? null;
  } catch {
    // A version probe that errors doesn't block use; version stays null.
  }
  return { ...base, installed: true, path, version };
};

export const runDetect = (
  adapter: Adapter,
  probe: VersionProbe
): Promise<DetectResult> =>
  adapter.detect ? adapter.detect(probe) : defaultDetect(adapter, probe);
