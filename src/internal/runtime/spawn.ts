import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

import type { Invocation, OutputSource, VersionProbe } from "../types.js";
import { outputSourceFromChild } from "./output-source.js";

export const spawnAndStream = (
  invocation: Invocation,
  signal?: AbortSignal
): OutputSource => {
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env ? { ...process.env, ...invocation.env } : process.env,
    signal,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (invocation.input === undefined) {
    child.stdin?.end();
  } else {
    child.stdin?.end(invocation.input);
  }
  return outputSourceFromChild(child, invocation);
};

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

export const realProbe: VersionProbe = {
  exec: (bin, args) =>
    // oxlint-disable-next-line promise/avoid-new -- child_process events need callback interop.
    new Promise((resolve) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c) => {
        stdout += c.toString();
      });
      child.stderr?.on("data", (c) => {
        stderr += c.toString();
      });
      child.on("error", () => resolve({ code: -1, stderr, stdout }));
      child.on("close", (code) =>
        resolve({ code: code ?? -1, stderr, stdout })
      );
    }),
  which: resolveOnPath,
};
