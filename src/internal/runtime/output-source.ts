import type { ChildProcess } from "node:child_process";

import { AnyAgentError } from "../errors.js";
import type { Invocation, OutputSource } from "../types.js";

export const outputSourceFromChild = (
  child: ChildProcess,
  invocation: Invocation
): OutputSource => {
  let spawnError: Error | null = null;
  let stderrBuf = "";

  child.stderr?.on("data", (c) => {
    stderrBuf += c.toString();
  });
  child.on("error", (err) => {
    spawnError = err;
  });

  const argv = [invocation.command, ...invocation.args];
  // oxlint-disable-next-line promise/avoid-new -- child_process lifecycle events need callback interop.
  const exitCode = new Promise<number>((resolve, reject) => {
    child.on("error", (err) =>
      reject(
        new AnyAgentError(
          "Invocation",
          `failed to spawn ${invocation.command}: ${err.message}`,
          {
            argv,
            raw: err,
          }
        )
      )
    );
    child.on("close", (code) => {
      if (spawnError) {
        // The 'error' handler already rejected.
        return;
      }
      if (code === 0) {
        resolve(0);
      } else {
        reject(
          new AnyAgentError(
            "Invocation",
            `${invocation.command} exited ${code}`,
            {
              argv,
              stderr: stderrBuf,
            }
          )
        );
      }
    });
  });
  // Fire-and-forget guard so an unawaited exitCode never becomes an unhandled rejection.
  // oxlint-disable-next-line promise/prefer-await-to-then -- deliberate detached guard.
  exitCode.catch(() => {
    // intentionally ignored
  });

  const failIfSpawnError = (): void => {
    if (spawnError) {
      throw new AnyAgentError(
        "Invocation",
        `failed to spawn ${invocation.command}`,
        {
          argv,
          raw: spawnError,
        }
      );
    }
  };

  const lines = async function* lines(): AsyncIterable<string> {
    const { stdout } = child;
    if (!stdout) {
      return;
    }
    let buf = "";
    try {
      for await (const chunk of stdout) {
        buf += chunk.toString("utf-8");
        let idx = buf.indexOf("\n");
        while (idx >= 0) {
          yield buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          idx = buf.indexOf("\n");
        }
      }
    } catch (error) {
      throw AnyAgentError.wrap(error, "Invocation");
    }
    failIfSpawnError();
    if (buf.length) {
      yield buf;
    }
  };

  const text = async (): Promise<string> => {
    const { stdout } = child;
    if (!stdout) {
      return "";
    }
    let out = "";
    try {
      for await (const chunk of stdout) {
        out += chunk.toString("utf-8");
      }
    } catch (error) {
      throw AnyAgentError.wrap(error, "Invocation");
    }
    failIfSpawnError();
    return out;
  };

  return {
    exitCode,
    lines,
    stderr: () => Promise.resolve(stderrBuf),
    text,
  };
};
