import { AnyAgentError } from "../errors.js";
import type {
  Agent,
  AgentEvent,
  Capabilities,
  Run,
  RunOptions,
  RunResult,
  Session,
  SessionKey,
  SessionOptions,
  StdoutAdapter,
} from "../types.js";
import { validateOptions } from "./capabilities.js";
import { RunImpl } from "./run.js";

type Runner = ConstructorParameters<typeof RunImpl>[1];

const SESSION_SETTINGS = [
  "cwd",
  "effort",
  "env",
  "extraArgs",
  "mcp",
  "model",
] as const;

const settingsOf = (opts: SessionOptions): RunOptions => {
  const settings: RunOptions = {};
  for (const key of SESSION_SETTINGS) {
    const value = opts[key];
    if (value !== undefined) {
      Object.assign(settings, { [key]: value });
    }
  }
  return settings;
};

// JS callers bypass the compile-time omission on `SessionRunOptionsFor`.
const rejectOwned = (opts: RunOptions): void => {
  if (opts.resume !== undefined || opts.forkSession !== undefined) {
    throw new AnyAgentError(
      "InvalidOptions",
      "resume and forkSession are owned by the session; use agent.session({ resume, fork })"
    );
  }
  const owned = SESSION_SETTINGS.filter((key) => opts[key] !== undefined);
  if (owned.length > 0) {
    const many = owned.length > 1;
    throw new AnyAgentError(
      "InvalidOptions",
      `${owned.join(", ")} ${many ? "are" : "is"} owned by the session; set ${many ? "them" : "it"} on agent.session()`
    );
  }
};

interface PendingTurn {
  opts: RunOptions;
  rejectGate: (failure: unknown) => void;
  resolveGate: (threaded: RunOptions) => void;
  run: Run;
}

// The concrete {@link Session}: client-side bookkeeping over the agent's
// one-process-per-turn model. Turns queue through an explicit FIFO — each
// gate resolves with the threaded options once every earlier turn settled. A
// failed turn rejects the turns queued behind it and the queue resets to the
// last good handle, so a later `run` retries from there.
export class SessionImpl<C extends Capabilities = Capabilities>
  implements Session<C>
{
  readonly agent: Agent<C>;
  readonly #adapter: StdoutAdapter;
  readonly #runner: Runner;
  #id: string | undefined;
  #resumeNext: string | undefined;
  #forkNext: boolean;
  readonly #seedFirstRunOptions: RunOptions | undefined;
  readonly #settings: RunOptions;
  readonly #pending: PendingTurn[] = [];
  #draining = false;
  #turns = 0;
  #closed = false;

  constructor(agent: Agent<C>, runner: Runner, opts: SessionOptions = {}) {
    const { adapter } = agent;
    if (adapter.mode !== "stdout") {
      throw new AnyAgentError(
        "UnsupportedCapability",
        `${adapter.meta.id} runs every turn over its ACP endpoint`
      );
    }
    this.agent = agent;
    this.#adapter = adapter;
    this.#runner = runner;
    this.#settings = settingsOf(opts);
    validateOptions(adapter, this.#settings);
    this.#forkNext = opts.fork === true;
    if (this.#forkNext && opts.resume === undefined) {
      throw new AnyAgentError(
        "InvalidOptions",
        "fork requires resume: only an existing conversation can branch"
      );
    }
    if (opts.resume !== undefined) {
      this.#id = opts.resume;
      this.#resumeNext = opts.resume;
      return;
    }
    const seed = adapter.sessionSeed?.();
    if (seed) {
      this.#id = seed.id;
      this.#seedFirstRunOptions = seed.firstRunOptions;
    }
  }

  get id(): string | undefined {
    return this.#id;
  }

  supports(...keys: SessionKey[]): boolean {
    return keys.length === 0;
  }

  steer(_text: string): void {
    throw new AnyAgentError(
      "UnsupportedCapability",
      `${this.agent.adapter.meta.id} runs sessions in stdout mode; steer needs an ACP-mode session`
    );
  }

  respond(_requestId: string, _choice: string): void {
    throw new AnyAgentError(
      "UnsupportedCapability",
      `${this.agent.adapter.meta.id} runs sessions in stdout mode; respond needs an ACP-mode session`
    );
  }

  close(): Promise<void> {
    this.#closed = true;
    for (const queued of this.#pending.splice(0)) {
      queued.rejectGate(new AnyAgentError("Aborted", "the run was aborted"));
    }
    // Stdout mode holds no process between turns, so an emptied queue is the
    // whole teardown.
    return Promise.resolve();
  }

  run(prompt: string, callOpts: RunOptions = {}): Run {
    if (this.#closed) {
      throw new AnyAgentError("InvalidOptions", "this session is closed");
    }
    rejectOwned(callOpts);
    const opts: RunOptions = { ...callOpts, ...this.#settings };

    let resolveGate: PendingTurn["resolveGate"] = () => {
      throw new Error("unreachable: promise executors run synchronously");
    };
    let rejectGate: PendingTurn["rejectGate"] = () => {
      throw new Error("unreachable: promise executors run synchronously");
    };
    const gate = new Promise<RunOptions>((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });

    const run = new RunImpl(
      this.#adapter,
      this.#runner,
      prompt,
      opts,
      gate,
      (event) => {
        this.#capture(event);
      }
    );
    this.#pending.push({ opts, rejectGate, resolveGate, run });
    this.#drain();
    return run;
  }

  #drain(): void {
    if (this.#draining) {
      return;
    }
    this.#draining = true;
    this.#processQueue().finally(() => {
      this.#draining = false;
      if (this.#pending.length > 0) {
        this.#drain();
      }
    });
  }

  async #processQueue(): Promise<void> {
    let turn = this.#pending.shift();
    while (turn) {
      // biome-ignore lint/performance/noAwaitInLoops: turns are sequential by contract — each waits for the previous.
      await this.#runTurn(turn);
      turn = this.#pending.shift();
    }
  }

  async #runTurn(turn: PendingTurn): Promise<void> {
    try {
      turn.resolveGate(this.#threadedOptions(turn.opts));
      this.#endTurn(await turn.run);
    } catch (failure) {
      turn.rejectGate(failure);
      for (const queued of this.#pending.splice(0)) {
        queued.rejectGate(failure);
      }
    }
  }

  #threadedOptions(opts: RunOptions): RunOptions {
    // The seed applies to whichever turn runs first — including a retry
    // after a failed first turn, when the conversation never started.
    const seed = this.#turns === 0 ? this.#seedFirstRunOptions : undefined;
    const merged: RunOptions = { ...seed, ...opts };
    if (seed?.extraArgs || opts.extraArgs) {
      merged.extraArgs = [
        ...(seed?.extraArgs ?? []),
        ...(opts.extraArgs ?? []),
      ];
    }
    if (this.#resumeNext !== undefined) {
      merged.resume = this.#resumeNext;
    }
    if (this.#forkNext) {
      this.#forkNext = false;
      merged.forkSession = true;
    }
    if (this.#turns > 0 && merged.resume === undefined) {
      throw new AnyAgentError(
        "Parse",
        `${this.agent.adapter.meta.id} revealed no session id to continue from`
      );
    }
    return merged;
  }

  #capture(event: AgentEvent): void {
    if (event.type === "session") {
      this.#id = event.sessionId;
      this.#resumeNext = event.sessionId;
    }
  }

  #endTurn(result: RunResult): void {
    this.#turns += 1;
    const handle = result.sessionId ?? this.#id;
    if (handle !== undefined) {
      this.#id = handle;
      this.#resumeNext = handle;
    }
  }
}
