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
} from "../types.js";
import { AcpSessionImpl } from "./acp-session.js";
import { RunImpl } from "./run.js";

type Runner = ConstructorParameters<typeof RunImpl>[1];

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
//
// This class is the tier seam: when the agent declares `session: "native"`
// with an ACP endpoint it delegates every verb to an {@link AcpSessionImpl}
// live session; otherwise the emulated path below runs untouched. `steer`/
// `respond` are native-tier verbs; the emulated tier throws.
export class SessionImpl<C extends Capabilities = Capabilities>
  implements Session<C>
{
  readonly agent: Agent<C>;
  readonly #runner: Runner;
  readonly #native: AcpSessionImpl<C> | undefined;
  #id: string | undefined;
  #resumeNext: string | undefined;
  #forkNext: boolean;
  readonly #seedFirstRunOptions: RunOptions | undefined;
  readonly #pending: PendingTurn[] = [];
  #draining = false;
  #turns = 0;

  constructor(
    agent: Agent<C>,
    runner: Runner,
    opts: SessionOptions = {},
    // The mixed-tier fallback constructs an emulated cursor directly; this flag
    // keeps it from re-selecting the native tier and looping back on itself.
    forceEmulated = false
  ) {
    this.agent = agent;
    this.#runner = runner;
    this.#forkNext = opts.fork === true;
    if (
      !forceEmulated &&
      agent.adapter.capabilities.session === "native" &&
      agent.adapter.acp
    ) {
      this.#native = new AcpSessionImpl(agent, runner, opts);
      return;
    }
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
    const seed = agent.adapter.sessionSeed?.();
    if (seed) {
      this.#id = seed.id;
      this.#seedFirstRunOptions = seed.firstRunOptions;
    }
  }

  get id(): string | undefined {
    return this.#native ? this.#native.id : this.#id;
  }

  supports(...keys: SessionKey[]): boolean {
    if (this.#native) {
      return this.#native.supports(...keys);
    }
    // The emulated tier has no live channel; ACP-backed sessions provide
    // these verbs by construction.
    return keys.length === 0;
  }

  steer(text: string): void {
    if (this.#native) {
      this.#native.steer(text);
      return;
    }
    throw new AnyAgentError(
      "UnsupportedCapability",
      `${this.agent.adapter.meta.id} has no live session channel to steer`
    );
  }

  respond(requestId: string, choice: string): void {
    if (this.#native) {
      this.#native.respond(requestId, choice);
      return;
    }
    throw new AnyAgentError(
      "UnsupportedCapability",
      `${this.agent.adapter.meta.id} has no live session channel to respond on`
    );
  }

  run(prompt: string, opts: RunOptions = {}): Run {
    if (this.#native) {
      return this.#native.run(prompt, opts);
    }
    if (opts.resume !== undefined || opts.forkSession !== undefined) {
      throw new AnyAgentError(
        "InvalidOptions",
        "resume and forkSession are owned by the session; use agent.session({ resume, fork })"
      );
    }

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
      this.agent.adapter,
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
