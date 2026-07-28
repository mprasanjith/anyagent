import { AnyAgentError } from "../errors.js";
import type {
  Adapter,
  AgentEvent,
  Invocation,
  OutputSource,
  Run,
  RunOptions,
  RunResult,
  StdoutAdapter,
} from "../types.js";
import { validateOptions } from "./capabilities.js";
import { applyEmulations } from "./emulate.js";
import { extractJson, validateAgainstSchema } from "./structured.js";

type Runner = (invocation: Invocation, signal?: AbortSignal) => OutputSource;

/** A prompt and options with every emulated capability already folded in. */
export interface Composed {
  opts: RunOptions;
  prompt: string;
}

type Parsed = { json: unknown } | { errors: string[] };

const evaluate = (text: string, schema: Record<string, unknown>): Parsed => {
  let value: unknown;
  try {
    value = extractJson(text);
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)] };
  }
  const errors = validateAgainstSchema(value, schema);
  return errors.length ? { errors } : { json: value };
};

const schemaFailure = (errors: string[], text: string): AnyAgentError =>
  new AnyAgentError(
    "Parse",
    `reply did not match schema: ${errors.join("; ")}`,
    { issues: errors, raw: text }
  );

const correctionPrompt = (
  prompt: string,
  previous: string,
  errors: string[]
): string =>
  `${prompt}\n\nYour previous reply could not be used:\n\n<previous-reply>\n${previous}\n</previous-reply>\n\nIt failed these checks:\n${errors
    .map((e) => `- ${e}`)
    .join("\n")}\n\nReply again with only a corrected JSON value.`;

// `attempt` must withhold its terminal `done`: the caller emits exactly one,
// carrying the parsed result.
const runWithSchema = async (
  prompt: string,
  opts: RunOptions,
  attempt: (text: string) => Promise<RunResult>,
  emit: (event: AgentEvent) => void
): Promise<RunResult> => {
  const first = await attempt(prompt);
  if (opts.schema === undefined) {
    return first;
  }
  const parsed = evaluate(first.text, opts.schema);
  if ("json" in parsed) {
    return { ...first, json: parsed.json };
  }
  if (opts.schemaRetries === 0) {
    throw schemaFailure(parsed.errors, first.text);
  }
  emit({ issues: parsed.errors, type: "schema-retry" });
  const retry = await attempt(
    correctionPrompt(prompt, first.text, parsed.errors)
  );
  const second = evaluate(retry.text, opts.schema);
  if ("errors" in second) {
    throw schemaFailure(second.errors, retry.text);
  }
  return { ...retry, json: second.json };
};

export const whenAborted = (
  signal: AbortSignal,
  listener: () => void
): void => {
  if (signal.aborted) {
    listener();
    return;
  }
  signal.addEventListener("abort", listener);
};

const aborted = (): AnyAgentError =>
  new AnyAgentError("Aborted", "the run was aborted");

// One turn in flight: a real Promise (so `.rejects` matchers and
// `.catch`/`.finally` all work) that is also an event iterable. The driver
// feeds it through `push` and ends it through `settleOk`/`settleErr`; every
// consumer reads the same event log — iterators replay the buffer then follow
// live. Settling is first-wins: a late success must not overwrite the failure
// consumers were already handed.
export class TurnRun extends Promise<RunResult> implements Run {
  // `.then()` must chain plain promises, not construct new turns.
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  readonly #controller = new AbortController();
  readonly #events: AgentEvent[] = [];
  #notify: (() => void) | undefined;
  #settled = false;
  #failure: unknown;
  #iterating = false;
  readonly #resolve: (result: RunResult) => void;
  readonly #reject: (failure: unknown) => void;

  constructor() {
    let settle: {
      resolve: (result: RunResult) => void;
      reject: (failure: unknown) => void;
    } = {
      reject: () => {
        throw new Error("unreachable: promise executors run synchronously");
      },
      resolve: () => {
        throw new Error("unreachable: promise executors run synchronously");
      },
    };
    super((resolve, reject) => {
      settle = { reject, resolve };
    });
    this.#resolve = settle.resolve;
    this.#reject = settle.reject;
    // Iterators and abort() surface failures too; without this, a consumer
    // that only iterates would leave the rejection unhandled.
    this.catch(() => undefined);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get settled(): boolean {
    return this.#settled;
  }

  abort(): void {
    this.#controller.abort();
  }

  push(event: AgentEvent): void {
    this.#events.push(event);
    this.#notify?.();
    this.#notify = undefined;
  }

  settleOk(result: RunResult): void {
    if (this.#settled) {
      return;
    }
    this.push({ result, type: "done" });
    this.#finish();
    this.#resolve(result);
  }

  settleErr(failure: unknown): void {
    if (this.#settled) {
      return;
    }
    this.#failure = failure;
    this.#finish();
    this.#reject(failure);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent, undefined> {
    if (this.#iterating) {
      throw new AnyAgentError(
        "InvalidOptions",
        "this run is already being iterated; a Run supports one event consumer"
      );
    }
    this.#iterating = true;
    let index = 0;
    while (true) {
      if (index < this.#events.length) {
        const event = this.#events[index];
        index += 1;
        if (event !== undefined) {
          yield event;
        }
        continue;
      }
      if (this.#settled) {
        if (this.#failure !== undefined) {
          throw this.#failure;
        }
        return;
      }
      // biome-ignore lint/performance/noAwaitInLoops: a live follower must wait for each event as it lands.
      await new Promise<void>((resolve) => {
        this.#notify = resolve;
      });
    }
  }

  #finish(): void {
    this.#settled = true;
    this.#notify?.();
    this.#notify = undefined;
  }
}

/** A turn that never started: the failure was decided before it could run. */
export const rejectedRun = (failure: unknown): Run => {
  const run = new TurnRun();
  run.settleErr(failure);
  return run;
};

interface QueuedTurn {
  run: TurnRun;
  task: (run: TurnRun) => Promise<void>;
}

// The turn discipline both modes owe a session: one turn at a time, in the
// order they were asked for; a failed turn rejects the turns queued behind it;
// and aborting a queued turn never disturbs the one in flight.
export class TurnQueue {
  readonly #pending: QueuedTurn[] = [];
  readonly #cancelInFlight: (run: TurnRun) => boolean;
  #inFlight: TurnRun | undefined;
  #draining = false;

  // A queued turn is dropped where it stands; an aborted turn already in flight
  // has to reach whatever drives it, and answers whether it got there — when it
  // did not, the queue settles the turn itself.
  constructor(cancelInFlight: (run: TurnRun) => boolean = () => true) {
    this.#cancelInFlight = cancelInFlight;
  }

  get inFlight(): TurnRun | undefined {
    return this.#inFlight;
  }

  add(task: (run: TurnRun) => Promise<void>, signal?: AbortSignal): TurnRun {
    const turn: QueuedTurn = { run: new TurnRun(), task };
    this.#pending.push(turn);
    whenAborted(turn.run.signal, () => {
      this.#abort(turn);
    });
    if (signal) {
      whenAborted(signal, () => {
        turn.run.abort();
      });
    }
    this.#drain();
    return turn.run;
  }

  /** Drop every turn still queued; the one in flight is left alone. */
  abandonQueued(failure: unknown = aborted()): void {
    for (const queued of this.#pending.splice(0)) {
      queued.run.settleErr(failure);
    }
  }

  #abort(turn: QueuedTurn): void {
    if (this.#inFlight === turn.run && this.#cancelInFlight(turn.run)) {
      return;
    }
    const at = this.#pending.indexOf(turn);
    if (at >= 0) {
      this.#pending.splice(at, 1);
    }
    turn.run.settleErr(aborted());
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
      this.#inFlight = turn.run;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: turns are sequential by contract — each waits for the previous.
        await turn.task(turn.run);
      } catch (failure) {
        turn.run.settleErr(failure);
        this.abandonQueued(failure);
      } finally {
        this.#inFlight = undefined;
      }
      turn = this.#pending.shift();
    }
  }
}

/**
 * The seam every turn flows through, whichever mode drives it: options are
 * validated, emulated capabilities are folded into each attempt, and a reply
 * that fails the run's schema is re-asked for.
 */
export const runTurn = async (
  adapter: Adapter,
  prompt: string,
  opts: RunOptions,
  drive: (composed: Composed) => Promise<RunResult>,
  emit: (event: AgentEvent) => void
): Promise<RunResult> => {
  validateOptions(adapter, opts);
  return await runWithSchema(
    prompt,
    opts,
    (text) => drive(applyEmulations(adapter, text, opts)),
    emit
  );
};

// One CLI process: spawn, relay the adapter's events except its `done` (the
// turn emits one of those, carrying the final result), and return the
// attempt's result.
export const spawnOnce = async (
  adapter: StdoutAdapter,
  runner: Runner,
  composed: Composed,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void
): Promise<RunResult> => {
  const built = adapter.buildInvocation(composed.prompt, composed.opts);
  const { extraArgs } = composed.opts;
  const invocation = extraArgs?.length
    ? { ...built, args: [...built.args, ...extraArgs] }
    : built;
  const source = runner(invocation, signal);
  try {
    let result: RunResult | undefined;
    for await (const event of adapter.parse(source, { strict: false })) {
      if (event.type === "done") {
        ({ result } = event);
      } else {
        emit(event);
      }
    }
    if (!result) {
      throw new AnyAgentError(
        "Parse",
        "adapter produced no terminal done event"
      );
    }
    return result;
  } finally {
    source.close?.();
  }
};
