import type { ChildProcess } from "node:child_process";

import { AnyAgentError } from "../errors.js";
import type { Invocation, OutputSource } from "../types.js";

const STDERR_SNIPPET_LEN = 200;

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
  const invocationError = (
    message: string,
    extra?: { raw?: unknown; stderr?: string }
  ) => new AnyAgentError("Invocation", message, { argv, ...extra });

  // oxlint-disable-next-line promise/avoid-new -- child_process lifecycle events need callback interop.
  const exitCode = new Promise<number>((resolve, reject) => {
    child.on("error", (err) =>
      reject(
        invocationError(
          `failed to spawn ${invocation.command}: ${err.message}`,
          {
            raw: err,
          }
        )
      )
    );
    child.on("close", (code) => {
      if (spawnError) {
        return;
      }
      if (code === 0) {
        resolve(0);
      } else {
        const tail = stderrBuf.trim().slice(0, STDERR_SNIPPET_LEN);
        reject(
          invocationError(
            `${invocation.command} exited ${code}${tail ? `: ${tail}` : ""}`,
            { stderr: stderrBuf }
          )
        );
      }
    });
  });
  // Fire-and-forget guard so an unawaited exitCode never becomes an unhandled rejection.
  // oxlint-disable-next-line promise/prefer-await-to-then, no-empty-function -- deliberate detached guard.
  exitCode.catch(() => {});

  // A stdout read error is almost always a downstream symptom of the process
  // failing to spawn or exiting nonzero. Prefer that descriptive error (it
  // carries argv/stderr) over the raw "Premature close" stream error.
  const readError = async (error: unknown): Promise<never> => {
    await exitCode;
    throw AnyAgentError.wrap(error, "Invocation");
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
      await readError(error);
    }
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
      await readError(error);
    }
    return out;
  };

  return {
    close: () => {
      child.kill();
    },
    exitCode,
    lines,
    stderr: () => Promise.resolve(stderrBuf),
    text,
  };
};
