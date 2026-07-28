import type {
  AgentCapabilities,
  AnyMessage,
  ClientCapabilities,
  ClientConnection,
  ClientContext,
  ContentBlock,
  Implementation,
  NewSessionRequest,
  PromptResponse,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  Stream,
} from "@agentclientprotocol/sdk";
import {
  client as createClientApp,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { AnyAgentError } from "../errors.js";

/**
 * The line-oriented duplex an {@link AcpClient} speaks over. ACP v1 frames
 * JSON-RPC 2.0 messages one-per-line, so the transport only has to move whole
 * lines: `send` writes one outgoing line, `onLine` delivers each incoming line,
 * `close` tears the channel down, and `onDeath` reports the failure that ended
 * it — carrying whatever diagnostics (`argv`, `stderr`) the transport can see —
 * so a request that can never be answered rejects instead of hanging. A real
 * transport wraps a spawned agent's stdin/stdout; tests inject a scripted fake,
 * so the client never touches a process or socket directly.
 */
export interface AcpTransport {
  close: () => void;
  onDeath: (listener: (failure: AnyAgentError) => void) => void;
  onLine: (listener: (line: string) => void) => void;
  send: (line: string) => void;
}

/** Options for the reverse `initialize` handshake. */
export interface InitializeOptions {
  clientCapabilities?: ClientCapabilities;
  clientInfo?: Implementation;
}

/** What the agent advertised in its `initialize` response. */
export interface InitializeResult {
  agentCapabilities: AgentCapabilities | undefined;
  protocolVersion: number;
}

/** Ergonomic input for `session/new`; `mcpServers` defaults to none. */
export interface NewSessionInput {
  additionalDirectories?: string[];
  cwd: string;
  mcpServers?: NewSessionRequest["mcpServers"];
}

/** Ergonomic input for `session/load`; carries the id to reattach. */
export interface LoadSessionInput {
  additionalDirectories?: string[];
  cwd: string;
  mcpServers?: NewSessionRequest["mcpServers"];
  sessionId: string;
}

/** A prompt string, or the raw content blocks when the caller needs them. */
export type PromptInput = string | ContentBlock[];

/**
 * Called for every `session/update` the agent streams during a prompt turn.
 * Receives the decoded {@link SessionUpdate} plus its full notification (which
 * carries the `sessionId` and any `_meta`).
 */
export type UpdateListener = (
  update: SessionUpdate,
  notification: SessionNotification
) => void;

/**
 * The agent's reverse `session/request_permission` call. The integrator sets
 * one handler; it receives the request verbatim — including the agent's own
 * `options` list, each option keeping its `optionId`, `kind`, and `name`
 * (label) — and answers with a {@link RequestPermissionOutcome}, either
 * selecting one `optionId` or cancelling. When no handler is set the client
 * cancels the request.
 */
export type PermissionHandler = (
  request: RequestPermissionRequest
) => RequestPermissionOutcome | Promise<RequestPermissionOutcome>;

/**
 * A running `session/prompt` turn. `result` settles with the agent's final
 * {@link PromptResponse} (carrying the `stopReason`) once the turn ends; the
 * turn's streamed output is delivered to the `onUpdate` listener passed to
 * `prompt`.
 */
export interface PromptTurn {
  readonly result: Promise<PromptResponse>;
}

export interface ConfigOptionInput {
  configId: string;
  value: string;
}

/** A live ACP session: the unit that prompts, streams, and cancels. */
export interface AcpSession {
  cancel: () => Promise<void>;
  // Ends the session agent-side; the connection itself stays open.
  close: () => Promise<void>;
  // Each select-type config option's value as the session opened.
  readonly config: ReadonlyMap<string, string>;
  prompt: (input: PromptInput, onUpdate?: UpdateListener) => PromptTurn;
  readonly sessionId: string;
  setConfigOption: (option: ConfigOptionInput) => Promise<void>;
}

// Shared routing state between the client-app handlers and its sessions.
interface Dispatch {
  readonly dead: Promise<never>;
  permissionHandler: PermissionHandler | undefined;
  readonly updateListeners: Map<string, UpdateListener>;
}

const toContentBlocks = (input: PromptInput): ContentBlock[] =>
  typeof input === "string" ? [{ text: input, type: "text" }] : input;

const LINE_SNIPPET_LEN = 120;

// A dead channel can never answer, so everything the client waits on races
// `dead` rather than hanging on it.
interface Channel {
  readonly dead: Promise<never>;
  readonly stream: Stream;
}

const channelFor = (transport: AcpTransport): Channel => {
  let kill: (failure: AnyAgentError) => void = () => undefined;
  const dead = new Promise<never>((_resolve, reject) => {
    kill = reject;
  });
  // A channel can die with nothing racing it — between turns, or after close.
  dead.catch(() => undefined);

  let controller: ReadableStreamDefaultController<AnyMessage> | undefined;
  let dying = false;
  const die = (failure: AnyAgentError): void => {
    if (dying) {
      return;
    }
    dying = true;
    kill(failure);
    try {
      controller?.close();
    } catch {
      // The connection may have closed the stream first, which is the same end.
    }
  };

  const readable = new ReadableStream<AnyMessage>({
    start(active) {
      controller = active;
      transport.onLine((line) => {
        const trimmed = line.trim();
        if (dying || trimmed.length === 0) {
          return;
        }
        let message: AnyMessage;
        try {
          message = JSON.parse(trimmed) as AnyMessage;
        } catch (error) {
          die(
            new AnyAgentError(
              "Parse",
              `invalid JSON line: ${trimmed.slice(0, LINE_SNIPPET_LEN)}`,
              { raw: error }
            )
          );
          return;
        }
        active.enqueue(message);
      });
    },
  });
  transport.onDeath(die);

  const writable = new WritableStream<AnyMessage>({
    write(message) {
      if (dying) {
        return;
      }
      transport.send(JSON.stringify(message));
    },
  });
  return { dead, stream: { readable, writable } };
};

const currentValues = (
  options: SessionConfigOption[] | null | undefined
): Map<string, string> => {
  const config = new Map<string, string>();
  for (const option of options ?? []) {
    if (option.type === "select") {
      config.set(option.id, option.currentValue);
    }
  }
  return config;
};

class AcpSessionImpl implements AcpSession {
  readonly sessionId: string;
  readonly config: ReadonlyMap<string, string>;
  readonly #context: ClientContext;
  readonly #dispatch: Dispatch;

  constructor(
    sessionId: string,
    context: ClientContext,
    dispatch: Dispatch,
    config: ReadonlyMap<string, string>
  ) {
    this.sessionId = sessionId;
    this.#context = context;
    this.#dispatch = dispatch;
    this.config = config;
  }

  async setConfigOption(option: ConfigOptionInput): Promise<void> {
    await Promise.race([
      this.#context.request("session/set_config_option", {
        configId: option.configId,
        sessionId: this.sessionId,
        value: option.value,
      }),
      this.#dispatch.dead,
    ]);
  }

  async close(): Promise<void> {
    await Promise.race([
      this.#context.request("session/close", { sessionId: this.sessionId }),
      this.#dispatch.dead,
    ]);
  }

  prompt(input: PromptInput, onUpdate?: UpdateListener): PromptTurn {
    if (onUpdate) {
      this.#dispatch.updateListeners.set(this.sessionId, onUpdate);
    }
    // The listener is scoped to this turn: routed updates carry no turn id, so
    // it is cleared once the turn settles rather than leaking into the next.
    const result = Promise.race([
      this.#context.request("session/prompt", {
        prompt: toContentBlocks(input),
        sessionId: this.sessionId,
      }),
      this.#dispatch.dead,
    ]).finally(() => {
      this.#dispatch.updateListeners.delete(this.sessionId);
    });
    return { result };
  }

  async cancel(): Promise<void> {
    await this.#context.notify("session/cancel", { sessionId: this.sessionId });
  }
}

/**
 * A client for one ACP v1 connection, built on `@agentclientprotocol/sdk`. It
 * negotiates the protocol version, opens and reattaches sessions, streams
 * prompt turns, answers the agent's reverse permission requests, and cancels.
 * Construct one with {@link connect}; nothing here is wired into AnyAgent's
 * public API — a later change integrates it into the session layer.
 */
export class AcpClient {
  readonly #connection: ClientConnection;
  readonly #transport: AcpTransport;
  readonly #dispatch: Dispatch;
  #capabilities: AgentCapabilities | undefined;

  constructor(
    connection: ClientConnection,
    transport: AcpTransport,
    dispatch: Dispatch
  ) {
    this.#connection = connection;
    this.#transport = transport;
    this.#dispatch = dispatch;
  }

  /** The agent capabilities advertised by `initialize`, once negotiated. */
  get capabilities(): AgentCapabilities | undefined {
    return this.#capabilities;
  }

  /**
   * Runs the `initialize` handshake, offering this client's protocol version
   * (the SDK's stable integer). If the agent answers with a different version
   * the connection is closed and an error is thrown — the versions are
   * incompatible. On success the advertised {@link AgentCapabilities} are
   * stored and returned.
   */
  async initialize(options?: InitializeOptions): Promise<InitializeResult> {
    const response = await this.#alive(
      this.#connection.agent.request("initialize", {
        clientCapabilities: options?.clientCapabilities ?? {},
        clientInfo: options?.clientInfo ?? null,
        protocolVersion: PROTOCOL_VERSION,
      })
    );
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      this.close();
      throw new AnyAgentError(
        "Invocation",
        `ACP protocol version mismatch: agent requires ${response.protocolVersion}, this client speaks ${PROTOCOL_VERSION}`
      );
    }
    this.#capabilities = response.agentCapabilities;
    return {
      agentCapabilities: response.agentCapabilities,
      protocolVersion: response.protocolVersion,
    };
  }

  #alive<T>(pending: Promise<T>): Promise<T> {
    return Promise.race([pending, this.#dispatch.dead]);
  }

  /** Opens a fresh session with `session/new`. */
  async newSession(request: NewSessionInput): Promise<AcpSession> {
    const response = await this.#alive(
      this.#connection.agent.request("session/new", {
        additionalDirectories: request.additionalDirectories,
        cwd: request.cwd,
        mcpServers: request.mcpServers ?? [],
      })
    );
    return new AcpSessionImpl(
      response.sessionId,
      this.#connection.agent,
      this.#dispatch,
      currentValues(response.configOptions)
    );
  }

  /**
   * Reattaches an existing session with `session/load`. Gated on the agent's
   * advertised `loadSession` capability: throws before sending if `initialize`
   * did not advertise it.
   */
  async loadSession(request: LoadSessionInput): Promise<AcpSession> {
    if (!this.#capabilities?.loadSession) {
      throw new AnyAgentError(
        "UnsupportedCapability",
        "the agent did not advertise session/load support"
      );
    }
    const response = await this.#alive(
      this.#connection.agent.request("session/load", {
        additionalDirectories: request.additionalDirectories,
        cwd: request.cwd,
        mcpServers: request.mcpServers ?? [],
        sessionId: request.sessionId,
      })
    );
    return new AcpSessionImpl(
      request.sessionId,
      this.#connection.agent,
      this.#dispatch,
      currentValues(response.configOptions)
    );
  }

  /** Sets the handler answering the agent's `session/request_permission`. */
  onPermissionRequest(handler: PermissionHandler): void {
    this.#dispatch.permissionHandler = handler;
  }

  /** Closes the connection and the underlying transport. */
  close(): void {
    this.#connection.close();
    this.#transport.close();
  }
}

/**
 * Builds an {@link AcpClient} over `transport`. Registers the client-side
 * handlers ACP requires — the `session/update` notification (routed to the
 * active turn's listener) and the reverse `session/request_permission` request
 * (routed to the integrator's handler, defaulting to cancel) — and opens the
 * connection. Call {@link AcpClient.initialize} next to negotiate the protocol.
 */
export const connect = (
  transport: AcpTransport,
  options?: { name?: string }
): AcpClient => {
  const channel = channelFor(transport);
  const dispatch: Dispatch = {
    dead: channel.dead,
    permissionHandler: undefined,
    updateListeners: new Map(),
  };
  const app = createClientApp({ name: options?.name ?? "anyagent" });
  app.onNotification("session/update", ({ params }) => {
    dispatch.updateListeners.get(params.sessionId)?.(params.update, params);
  });
  app.onRequest("session/request_permission", async ({ params }) => {
    const handler = dispatch.permissionHandler;
    const outcome: RequestPermissionOutcome = handler
      ? await handler(params)
      : { outcome: "cancelled" };
    return { outcome };
  });
  const connection = app.connect(channel.stream);
  return new AcpClient(connection, transport, dispatch);
};
