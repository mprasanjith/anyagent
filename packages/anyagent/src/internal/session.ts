import { AnyAgentError } from "../errors.js";
import type {
  Agent,
  AgentEvent,
  Capabilities,
  Invocation,
  OutputSource,
  Run,
  RunOptions,
  RunResult,
  Session,
  SessionKey,
  SessionOptions,
  StdoutAdapter,
} from "../types.js";
import { validateOptions } from "./capabilities.js";
import {
  rejectTurnOptions,
  sessionRunOptions,
  settingsOf,
} from "./settings.js";
import type { TurnRun } from "./turn.js";
import { runTurn, spawnOnce, TurnQueue } from "./turn.js";

type Runner = (invocation: Invocation, signal?: AbortSignal) => OutputSource;

// The concrete {@link Session}: client-side bookkeeping over the agent's
// one-process-per-turn model. The resume handle is threaded at dequeue, so a
// turn that failed leaves the queue on the last good handle and a later `run`
// retries from there.
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
  readonly #queue = new TurnQueue();
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
    validateOptions(adapter, sessionRunOptions(opts));
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
    this.#queue.abandonQueued();
    // Stdout mode holds no process between turns, so an emptied queue is the
    // whole teardown.
    return Promise.resolve();
  }

  run(prompt: string, callOpts: RunOptions = {}): Run {
    if (this.#closed) {
      throw new AnyAgentError("InvalidOptions", "this session is closed");
    }
    rejectTurnOptions(callOpts);
    const opts: RunOptions = { ...callOpts, ...this.#settings };
    return this.#queue.add(
      (turn) => this.#turn(prompt, opts, turn),
      opts.signal
    );
  }

  async #turn(prompt: string, opts: RunOptions, run: TurnRun): Promise<void> {
    const emit = (event: AgentEvent): void => {
      this.#capture(event);
      run.push(event);
    };
    const result = await runTurn(
      this.#adapter,
      prompt,
      this.#threadedOptions(opts),
      (composed) =>
        spawnOnce(this.#adapter, this.#runner, composed, run.signal, emit),
      emit
    );
    this.#endTurn(result);
    run.settleOk(result);
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
