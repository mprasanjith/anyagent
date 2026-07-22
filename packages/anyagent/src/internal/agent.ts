import type { ChildProcess } from "node:child_process";
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
  RawHandle,
  Run,
  RunOptions,
  Session,
  SessionOptions,
  SupportedCapabilities,
  SystemProbe,
} from "../types.js";
import { EXTENSION_CAPABILITY } from "../types.js";
import { RunImpl } from "./run.js";
import {
  realSystemProbe,
  spawnAndStream,
  spawnChild,
} from "./runtime/spawn.js";
import { SessionImpl } from "./session.js";

type Runner = (invocation: Invocation, signal?: AbortSignal) => OutputSource;

// The concrete {@link Agent}: hands each turn to a {@link RunImpl} (which
// validates options, spawns via the injected runner, and parses through the
// adapter), answers discovery through the injected probe, and opens
// {@link SessionImpl} cursors.
export class AgentImpl<C extends Capabilities = Capabilities>
  implements Agent<C>
{
  readonly adapter: Adapter<C>;
  private readonly runner: Runner;
  private readonly probe: SystemProbe;
  readonly raw: RawHandle = {
    buildInvocation: (prompt: string, opts: RunOptions = {}) =>
      this.build(prompt, opts),
    spawn: (prompt: string, opts: RunOptions = {}): ChildProcess =>
      spawnChild(this.build(prompt, opts), opts.signal),
  };

  constructor(
    adapter: Adapter<C>,
    runner: Runner = spawnAndStream,
    probe: SystemProbe = realSystemProbe
  ) {
    this.adapter = adapter;
    this.runner = runner;
    this.probe = probe;
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
    return new RunImpl(this.adapter, this.runner, prompt, opts);
  }

  session(opts: SessionOptions = {}): Session<C> {
    if (!this.adapter.capabilities.session) {
      throw new AnyAgentError(
        "UnsupportedCapability",
        `${this.adapter.meta.id} cannot continue a conversation`
      );
    }
    return new SessionImpl(this, this.runner, opts);
  }

  async authStatus(): Promise<AuthStatus> {
    const impl = this.adapter.authStatus;
    if (!(this.adapter.capabilities.authStatus && impl)) {
      throw new AnyAgentError(
        "UnsupportedCapability",
        `${this.adapter.meta.id} does not report auth status`
      );
    }
    return await impl(this.probe);
  }

  async models(): Promise<ModelInfo[]> {
    const impl = this.adapter.listModels;
    if (!(this.adapter.capabilities.modelListing && impl)) {
      throw new AnyAgentError(
        "UnsupportedCapability",
        `${this.adapter.meta.id} does not list models`
      );
    }
    return await impl(this.probe);
  }

  private build(prompt: string, opts: RunOptions): Invocation {
    const invocation = this.adapter.buildInvocation(prompt, opts);
    return opts.extraArgs?.length
      ? { ...invocation, args: [...invocation.args, ...opts.extraArgs] }
      : invocation;
  }
}
