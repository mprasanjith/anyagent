import type { AnyMessage, JsonRpcId } from "@agentclientprotocol/sdk";

import type { AnyAgentError } from "../src/errors.js";
import type { AcpTransport } from "../src/internal/acp.js";

/**
 * The other end of an {@link AcpTransport}, as seen by a test script standing
 * in for an ACP agent. `next` awaits the client's next outgoing message (a
 * request, response, or notification); `emit` pushes one incoming message to
 * the client; `line` pushes one unframed stdout line, as a banner would be; and
 * `die` kills the channel the way a spawned agent's death does. A
 * {@link Script} interleaves them to replay a realistic ACP v1 exchange with no
 * subprocess and no network.
 */
/**
 * A permissive view of one wire message for a script to assert against — every
 * JSON-RPC field is optional so tests read `id`, `method`, `params`, or
 * `result` without narrowing the {@link AnyMessage} union first.
 */
export interface ScriptMessage {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
}

export interface ScriptApi {
  die: (failure: AnyAgentError) => void;
  emit: (message: AnyMessage) => void;
  line: (text: string) => void;
  next: () => Promise<ScriptMessage>;
}

export type Script = (api: ScriptApi) => Promise<void>;

/** A JSON-RPC success response for `id`, ready to `emit`. */
export const response = (
  id: JsonRpcId | undefined,
  result: unknown
): AnyMessage => ({ id, jsonrpc: "2.0", result }) as AnyMessage;

/** A JSON-RPC error response for `id`, ready to `emit`. */
export const errorResponse = (
  id: JsonRpcId | undefined,
  message: string
): AnyMessage =>
  ({ error: { code: -32_000, message }, id, jsonrpc: "2.0" }) as AnyMessage;

/** A JSON-RPC request from the agent to the client (reverse direction). */
export const request = (
  id: JsonRpcId | undefined,
  method: string,
  params: unknown
): AnyMessage => ({ id, jsonrpc: "2.0", method, params }) as AnyMessage;

/** A JSON-RPC notification from the agent to the client. */
export const notify = (method: string, params: unknown): AnyMessage =>
  ({ jsonrpc: "2.0", method, params }) as AnyMessage;

/** A `session/update` notification wrapping one update for `sessionId`. */
export const update = (sessionId: string, sessionUpdate: unknown): AnyMessage =>
  notify("session/update", { sessionId, update: sessionUpdate });

/**
 * A scripted fake transport. `script` runs as soon as the client connects and
 * drives the whole exchange through {@link ScriptApi}; the returned promise
 * ({@link ScriptedTransport.done}) settles when the script finishes, surfacing
 * any assertion failure it threw.
 */
export interface ScriptedTransport extends AcpTransport {
  readonly done: Promise<void>;
}

export const scriptedTransport = (script: Script): ScriptedTransport => {
  let listener: ((line: string) => void) | undefined;
  let onDeath: ((failure: AnyAgentError) => void) | undefined;
  const outgoing: AnyMessage[] = [];
  const waiters: Array<(message: AnyMessage) => void> = [];

  const api: ScriptApi = {
    die: (failure) => {
      onDeath?.(failure);
    },
    emit: (message) => {
      listener?.(JSON.stringify(message));
    },
    line: (text) => {
      listener?.(text);
    },
    next: () =>
      new Promise<ScriptMessage>((resolve) => {
        const buffered = outgoing.shift();
        if (buffered) {
          resolve(buffered);
          return;
        }
        waiters.push(resolve);
      }),
  };

  const transport: AcpTransport = {
    close: () => {
      listener = undefined;
    },
    onDeath: (cb) => {
      onDeath = cb;
    },
    onLine: (cb) => {
      listener = cb;
    },
    send: (line) => {
      const message = JSON.parse(line) as AnyMessage;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(message);
        return;
      }
      outgoing.push(message);
    },
  };

  // The script waits on `next()`, which resolves only once the client has
  // connected and started sending, so starting it here races nothing.
  const done = script(api);
  return { ...transport, done };
};
