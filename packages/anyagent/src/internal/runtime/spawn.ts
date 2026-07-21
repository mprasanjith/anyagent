import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type {
  Invocation,
  OutputSource,
  SystemProbe,
  VersionProbe,
} from "../../types.js";
import { outputSourceFromChild } from "./output-source.js";

// Launch an invocation's process: merge its env over the parent's, and close
// stdin (carrying the prompt payload, if any) so an agent reading it isn't
// left waiting on EOF.
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

// The default runner: spawn the invocation and wrap the child in an
// {@link OutputSource} for an adapter's `parse` to consume.
export const spawnAndStream = (
  invocation: Invocation,
  signal?: AbortSignal
): OutputSource =>
  outputSourceFromChild(spawnChild(invocation, signal), invocation);

const isExecutable = async (candidate: string): Promise<string | undefined> => {
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    // Not executable (or missing): this candidate simply does not resolve.
  }
};

// Find `bin` on the `PATH`, trying Windows executable extensions on win32.
// Resolves to the first executable match in `PATH` order, or `undefined`.
export const resolveOnPath = async (
  bin: string
): Promise<string | undefined> => {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const candidates = dirs.flatMap((dir) =>
    exts.map((ext) => path.join(dir, bin + ext))
  );
  const results = await Promise.all(candidates.map(isExecutable));
  return results.find((r): r is string => r !== undefined);
};

const PROBE_TIMEOUT_MS = 10_000;

// The production {@link VersionProbe}: real `PATH` lookup and real version
// commands. Tests pass a fake via `detect({ probe })` instead of this.
export const realProbe: VersionProbe = {
  exec: (bin, args) =>
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
        // The settled guard makes the second call a no-op; error/close/timeout race to settle once.
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

// The production {@link SystemProbe}: the real environment, home directory,
// and filesystem behind discovery. Tests pass a fake via
// `create(source, { probe })` instead of this.
export const realSystemProbe: SystemProbe = {
  ...realProbe,
  env: process.env,
  homedir,
  readFile: async (file) => {
    try {
      return await readFile(file, "utf8");
    } catch {
      // Missing and unreadable both mean "no answer here": resolve undefined.
    }
  },
};
