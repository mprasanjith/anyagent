import { AnyAgentError } from "../errors.js";
import type {
  Adapter,
  AgentEvent,
  Invocation,
  OutputSource,
  Run,
  RunOptions,
  RunResult,
} from "../types.js";
import { validateOptions } from "./capabilities.js";
import { applyEmulations } from "./emulate.js";
import { extractJson, validateAgainstSchema } from "./structured.js";

type Runner = (invocation: Invocation, signal?: AbortSignal) => OutputSource;

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

// The `schema` contract every tier shares: run the turn, and when a schema is
// asked for, parse the reply, then either fail fast (`schemaRetries: 0`) or
// announce the `schema-retry` boundary and re-ask once with the correction.
// `attempt` runs one turn of whatever drives the tier — a spawned process, a
// live ACP prompt — and must withhold its terminal `done` so the caller emits
// exactly one, carrying the parsed result.
export const runWithSchema = async (
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

// The push-fed core shared by every {@link Run}: a real Promise (so jest-style
// `.rejects` matchers and `.catch`/`.finally` all work) that is also an event
// iterable. Producers feed it through `emit`/`finish` and settle it through
// `resolve`/`reject`; every consumer reads the same event log — iterators
// replay the buffer then follow live. Subclasses supply what actually drives
// a turn ({@link RunImpl} a spawned CLI process, the ACP tier a live session)
// and how `abort` reaches it.
export abstract class RunHandle extends Promise<RunResult> implements Run {
  // `.then()` must chain plain promises, not construct new run handles.
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  readonly #events: AgentEvent[] = [];
  #notify: (() => void) | undefined;
  #settled = false;
  #failure: unknown;
  #iterating = false;
  readonly #onEvent: ((event: AgentEvent) => void) | undefined;
  protected readonly resolve: (result: RunResult) => void;
  protected readonly reject: (failure: unknown) => void;

  constructor(onEvent?: (event: AgentEvent) => void) {
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
    this.resolve = settle.resolve;
    this.reject = settle.reject;
    this.#onEvent = onEvent;
    // Iterators and abort() surface failures too; without this, a consumer
    // that only iterates would leave the rejection unhandled.
    this.catch(() => undefined);
  }

  abstract abort(): void;

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

  protected emit(event: AgentEvent): void {
    this.#events.push(event);
    this.#onEvent?.(event);
    this.#notify?.();
    this.#notify = undefined;
  }

  protected finish(failure?: unknown): void {
    this.#failure = failure;
    this.#settled = true;
    this.#notify?.();
    this.#notify = undefined;
  }
}

// The concrete {@link Run} for the print-mode tier: the turn starts as soon as
// `ready` resolves (immediately for agent.run; after the predecessor for a
// queued session turn). The terminal `done` is withheld from intermediate
// schema attempts and emitted once, carrying the same result awaiting resolves
// with.
export class RunImpl extends RunHandle {
  readonly #adapter: Adapter;
  readonly #runner: Runner;
  readonly #controller = new AbortController();

  constructor(
    adapter: Adapter,
    runner: Runner,
    prompt: string,
    opts: RunOptions,
    ready: Promise<RunOptions> = Promise.resolve(opts),
    onEvent?: (event: AgentEvent) => void
  ) {
    super(onEvent);
    this.#adapter = adapter;
    this.#runner = runner;
    this.#execute(prompt, opts, ready).then(this.resolve, this.reject);
  }

  override abort(): void {
    this.#controller.abort();
  }

  async #execute(
    prompt: string,
    callOpts: RunOptions,
    ready: Promise<RunOptions>
  ): Promise<RunResult> {
    try {
      const opts = await ready;
      if (callOpts.signal?.aborted) {
        this.#controller.abort();
      } else {
        callOpts.signal?.addEventListener("abort", () => {
          this.#controller.abort();
        });
      }
      validateOptions(this.#adapter, opts);

      const final = await runWithSchema(
        prompt,
        opts,
        (text) => this.#attempt(text, opts),
        (event) => {
          this.emit(event);
        }
      );
      this.emit({ result: final, type: "done" });
      this.finish();
      return final;
    } catch (error) {
      this.finish(error);
      throw error;
    }
  }

  // One CLI process: spawn, relay the adapter's events (except its `done`,
  // which the run re-emits once the final result is known), return the
  // attempt's result.
  async #attempt(prompt: string, opts: RunOptions): Promise<RunResult> {
    const emulated = applyEmulations(this.#adapter, prompt, opts);
    const invocation = this.#build(emulated.prompt, emulated.opts);
    const source = this.#runner(invocation, this.#controller.signal);
    try {
      let result: RunResult | undefined;
      for await (const event of this.#adapter.parse(source, {
        strict: false,
      })) {
        if (event.type === "done") {
          ({ result } = event);
        } else {
          this.emit(event);
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
  }

  #build(prompt: string, opts: RunOptions): Invocation {
    const invocation = this.#adapter.buildInvocation(prompt, opts);
    return opts.extraArgs?.length
      ? { ...invocation, args: [...invocation.args, ...opts.extraArgs] }
      : invocation;
  }
}
