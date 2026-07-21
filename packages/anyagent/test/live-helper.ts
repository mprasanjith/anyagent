import { realProbe } from "../src/internal/runtime/spawn.js";

// Live tests run only under ANYAGENT_LIVE=1 and only if the binary resolves.
export const liveEnabled = async (bin: string): Promise<boolean> => {
  if (process.env.ANYAGENT_LIVE !== "1") {
    return false;
  }
  return (await realProbe.which(bin)) !== undefined;
};
