import type { ChildProcess } from "node:child_process";

import { resolvePermission, validateOptions } from "./capabilities.js";
import { AnyAgentError } from "./errors.js";
import { spawnAndStream, spawnChild } from "./runtime/spawn.js";
import type {
  Adapter,
  Agent,
  AgentEvent,
  DetectResult,
  Invocation,
  OutputSource,
  RawHandle,
  RunOptions,
  RunResult,
} from "./types.js";

type Runner = (invocation: Invocation, signal?: AbortSignal) => OutputSource;

/**
 * The concrete {@link Agent}: validates options against the adapter's
 * capability table, spawns via the injected runner (real process spawn by
 * default; tests inject fixture-backed runners), and delegates output
 * parsing to the adapter.
 */
export class AgentImpl implements Agent {
  readonly adapter: Adapter;
  private readonly runner: Runner;
  readonly raw: RawHandle = {
    buildInvocation: (prompt: string, opts: RunOptions = {}) =>
      this.build(prompt, opts),
    spawn: (prompt: string, opts: RunOptions = {}): ChildProcess =>
      spawnChild(this.build(prompt, opts), opts.signal),
  };

  constructor(adapter: Adapter, runner: Runner = spawnAndStream) {
    this.adapter = adapter;
    this.runner = runner;
  }

  get capabilities() {
    return this.adapter.capabilities;
  }

  private build(prompt: string, opts: RunOptions): Invocation {
    const resolved = { ...opts, permission: resolvePermission(opts) };
    const invocation = this.adapter.buildInvocation(prompt, resolved);
    return resolved.extraArgs?.length
      ? { ...invocation, args: [...invocation.args, ...resolved.extraArgs] }
      : invocation;
  }

  async *runStream(
    prompt: string,
    opts: RunOptions = {}
  ): AsyncGenerator<AgentEvent, RunResult> {
    validateOptions(this.adapter, opts);
    const source = this.runner(this.build(prompt, opts), opts.signal);
    try {
      return yield* this.adapter.parse(source, { strict: false });
    } finally {
      // Runs on normal completion (child already exited: no-op) and when a
      // consumer breaks early, terminating a stream nobody is reading.
      source.close?.();
    }
  }

  async run(prompt: string, opts: RunOptions = {}): Promise<RunResult> {
    for await (const ev of this.runStream(prompt, opts)) {
      if (ev.type === "done") {
        return ev.result;
      }
    }
    throw new AnyAgentError("Parse", "adapter produced no terminal done event");
  }
}

/**
 * Build a runnable {@link Agent}. Accepts either an adapter directly —
 * `create(claudeCode())` when you know which CLI you want — or one of
 * `detect()`'s results when you want whatever is installed.
 */
export const create = (source: Adapter | DetectResult): Agent =>
  new AgentImpl("adapter" in source ? source.adapter : source);
