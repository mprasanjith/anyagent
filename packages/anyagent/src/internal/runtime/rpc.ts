import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { AnyAgentError } from "../../errors.js";
import type { RpcExchange, RpcOutcome } from "../../types.js";

// A service dialogue is short; a server that takes longer than this per
// response is treated as hung and killed, like a hung version probe.
const DEFAULT_TIMEOUT_MS = 30_000;

interface RpcResponse {
  error?: { code?: number; message?: string };
  id?: unknown;
  result?: unknown;
}

/**
 * The production {@link SystemProbe.rpc}: spawn `bin args`, speak JSON-RPC
 * 2.0 as NDJSON over stdio, and run the exchanges strictly in order — each
 * request waits for its response before the next exchange is sent, which is
 * what service handshakes (initialize → response → initialized) require.
 *
 * Unsolicited server traffic (notifications, server-initiated requests) is
 * dropped; a line that is not JSON at all kills the process and throws
 * `Parse` immediately, so a CLI that misreads the dialogue as a prompt
 * fails fast instead of being fed further input. The process is terminated
 * once the last response lands — service processes never exit on their own.
 */
export const realRpc = (
  bin: string,
  args: string[],
  exchanges: RpcExchange[],
  opts: { timeoutMs?: number } = {}
): Promise<RpcOutcome[]> =>
  new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const outcomes: RpcOutcome[] = new Array(exchanges.length).fill(undefined);
    // The pending request's exchange index, or undefined between requests.
    let awaiting: number | undefined;
    let cursor = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (failure?: AnyAgentError) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      child.kill();
      if (failure) {
        reject(failure);
      } else {
        resolve(outcomes);
      }
    };

    const arm = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        finish(
          new AnyAgentError(
            "Invocation",
            `${bin} rpc: no response within ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      timer.unref?.();
    };

    // Send exchanges from `cursor`: notifications flush immediately, the
    // first request arms the timeout and waits for its response.
    const pump = () => {
      while (cursor < exchanges.length) {
        const index = cursor;
        const exchange = exchanges[index] as RpcExchange;
        cursor += 1;
        const message: Record<string, unknown> = {
          jsonrpc: "2.0",
          method: exchange.method,
          params: exchange.params ?? {},
        };
        if (!exchange.notification) {
          message.id = index;
          awaiting = index;
        }
        child.stdin?.write(`${JSON.stringify(message)}\n`);
        if (!exchange.notification) {
          arm();
          return;
        }
      }
      finish();
    };

    const lines = createInterface({
      input: child.stdout as NodeJS.ReadableStream,
    });
    lines.on("line", (line) => {
      if (settled || line.trim().length === 0) {
        return;
      }
      let response: RpcResponse;
      try {
        response = JSON.parse(line) as RpcResponse;
      } catch {
        // Not JSON: the process is answering some other protocol — plausibly
        // a prompt loop. Stop feeding it input before anything can bill.
        finish(
          new AnyAgentError(
            "Parse",
            `${bin} rpc: non-JSON output; not a JSON-RPC service`,
            { raw: line }
          )
        );
        return;
      }
      // Unsolicited traffic — server notifications and requests — is dropped;
      // only the response to the pending request advances the dialogue.
      if (awaiting === undefined || response.id !== awaiting) {
        return;
      }
      outcomes[awaiting] = response.error
        ? {
            error: {
              code: response.error.code,
              message: response.error.message ?? "unknown error",
            },
          }
        : { result: response.result };
      awaiting = undefined;
      pump();
    });

    child.on("error", (error) => {
      finish(
        new AnyAgentError("Invocation", `${bin} rpc: ${error.message}`, {
          raw: error,
        })
      );
    });
    child.on("close", () => {
      // Early exit with the dialogue unfinished means the service died.
      finish(
        new AnyAgentError(
          "Invocation",
          `${bin} rpc: process exited before the dialogue finished`
        )
      );
    });

    pump();
  });
