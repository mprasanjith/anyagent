import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

import type { Invocation, OutputSource, VersionProbe } from "../types.js";
import { outputSourceFromChild } from "./output-source.js";

/**
 * Launch an invocation's process: merge its env over the parent's, and close
 * stdin (carrying the prompt payload, if any) so an agent reading it isn't
 * left waiting on EOF.
 */
export const spawnChild = (
  invocation: Invocation,
  signal?: AbortSignal
): ChildProcess => {
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env ? { ...process.env, ...invocation.env } : process.env,
    signal,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.end(invocation.input);
  return child;
};

export const spawnAndStream = (
  invocation: Invocation,
  signal?: AbortSignal
): OutputSource =>
  outputSourceFromChild(spawnChild(invocation, signal), invocation);

const isExecutable = async (candidate: string): Promise<string | null> => {
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
};

export const resolveOnPath = async (bin: string): Promise<string | null> => {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const candidates = dirs.flatMap((dir) =>
    exts.map((ext) => path.join(dir, bin + ext))
  );
  const results = await Promise.all(candidates.map(isExecutable));
  return results.find((r): r is string => r !== null) ?? null;
};

const PROBE_TIMEOUT_MS = 10_000;

export const realProbe: VersionProbe = {
  exec: (bin, args) =>
    // oxlint-disable-next-line promise/avoid-new -- child_process events need callback interop.
    new Promise((resolve) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      // A hung binary must not stall detect(), which awaits every probe together.
      const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
      timer.unref?.();
      let settled = false;
      const done = (code: number) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        // oxlint-disable-next-line promise/no-multiple-resolved -- the settled guard makes the second call a no-op; error/close/timeout race to settle once.
        resolve({ code, stderr, stdout });
      };
      child.stdout?.on("data", (c) => {
        stdout += c.toString();
      });
      child.stderr?.on("data", (c) => {
        stderr += c.toString();
      });
      child.on("error", () => done(-1));
      child.on("close", (code) => done(code ?? -1));
    }),
  which: resolveOnPath,
};
