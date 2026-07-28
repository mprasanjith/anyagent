import { AnyAgentError } from "../errors.js";
import type {
  Adapter,
  Agent,
  AuthStatus,
  Capabilities,
  ExtensionKey,
  Invocation,
  ModelInfo,
  OutputSource,
  Run,
  RunOptions,
  Session,
  SessionOptions,
  SupportedCapabilities,
  SystemProbe,
} from "../types.js";
import { EXTENSION_CAPABILITY } from "../types.js";
import type { AcpTransportFactory } from "./acp-session.js";
import { AcpSessionImpl } from "./acp-session.js";
import { realSystemProbe, spawnAndStream } from "./runtime/spawn.js";
import { SessionImpl } from "./session.js";
import { splitRunOptions } from "./settings.js";
import { rejectedRun } from "./turn.js";

type Runner = (invocation: Invocation, signal?: AbortSignal) => OutputSource;

/**
 * The I/O an agent does, swappable so tests drive every path without touching
 * the machine: `probe` answers discovery, `runner` spawns a stdout-mode turn,
 * and `transport` carries an ACP-mode connection.
 */
export interface AgentDeps {
  probe?: SystemProbe;
  runner?: Runner;
  transport?: AcpTransportFactory;
}

// The concrete {@link Agent}: every turn is a session turn, so `run` opens a
// thread for one turn and closes it again, and discovery answers through the
// injected probe.
export class AgentImpl<C extends Capabilities = Capabilities>
  implements Agent<C>
{
  readonly adapter: Adapter<C>;
  readonly #runner: Runner;
  readonly #probe: SystemProbe;
  readonly #transport: AcpTransportFactory | undefined;

  constructor(adapter: Adapter<C>, deps: AgentDeps = {}) {
    this.adapter = adapter;
    this.#runner = deps.runner ?? spawnAndStream;
    this.#probe = deps.probe ?? realSystemProbe;
    this.#transport = deps.transport;
  }

  get capabilities(): C {
    return this.adapter.capabilities;
  }

  supports<K extends ExtensionKey[]>(
    ...keys: K
  ): this is AgentImpl<C & SupportedCapabilities<K[number]>> {
    return keys.every((key) =>
      Boolean(this.adapter.capabilities[EXTENSION_CAPABILITY[key]])
    );
  }

  run(prompt: string, opts: RunOptions = {}): Run {
    try {
      const { settings, turn } = splitRunOptions(opts);
      const session = this.#open(settings);
      const run = session.run(prompt, turn);
      const close = (): Promise<void> => session.close();
      run.then(close, close).catch(() => undefined);
      return run;
    } catch (failure) {
      return rejectedRun(failure);
    }
  }

  session(opts: SessionOptions = {}): Session<C> {
    const { adapter } = this;
    if (adapter.mode === "stdout" && !adapter.capabilities.session) {
      throw new AnyAgentError(
        "UnsupportedCapability",
        `${adapter.meta.id} cannot continue a conversation`
      );
    }
    return this.#open(opts);
  }

  async authStatus(): Promise<AuthStatus> {
    const impl = this.adapter.authStatus;
    if (!(this.adapter.capabilities.authStatus && impl)) {
      throw new AnyAgentError(
        "UnsupportedCapability",
        `${this.adapter.meta.id} does not report auth status`
      );
    }
    return await impl(this.#probe);
  }

  async models(): Promise<ModelInfo[]> {
    const impl = this.adapter.listModels;
    if (!(this.adapter.capabilities.modelListing && impl)) {
      throw new AnyAgentError(
        "UnsupportedCapability",
        `${this.adapter.meta.id} does not list models`
      );
    }
    return await impl(this.#probe);
  }

  // A one-turn thread is not a conversation, so it opens without the gate
  // `session()` puts in front of continuing one.
  #open(opts: SessionOptions): Session<C> {
    const { adapter } = this;
    return adapter.mode === "acp"
      ? new AcpSessionImpl(this, opts, this.#transport)
      : new SessionImpl(this, this.#runner, opts);
  }
}
