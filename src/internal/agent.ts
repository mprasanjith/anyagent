import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { resolvePermission, validateOptions } from "./capabilities.js";
import { AnyAgentError } from "./errors.js";
import { spawnAndStream } from "./runtime/spawn.js";
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

export class AgentImpl implements Agent {
  readonly adapter: Adapter;
  private readonly run_: Runner;

  constructor(adapter: Adapter, run: Runner = spawnAndStream) {
    this.adapter = adapter;
    this.run_ = run;
  }

  get capabilities() {
    return this.adapter.capabilities;
  }

  private build(prompt: string, opts: RunOptions): Invocation {
    const resolved = { ...opts, permission: resolvePermission(opts) };
    const inv = this.adapter.buildInvocation(prompt, resolved);
    return resolved.extraArgs?.length
      ? { ...inv, args: [...inv.args, ...resolved.extraArgs] }
      : inv;
  }

  async *runStream(
    prompt: string,
    opts: RunOptions = {}
  ): AsyncGenerator<AgentEvent, RunResult> {
    validateOptions(this.adapter, opts);
    const source = this.run_(this.build(prompt, opts), opts.signal);
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

  get raw(): RawHandle {
    return {
      buildInvocation: (prompt: string, opts: RunOptions = {}) =>
        this.build(prompt, opts),
      spawn: (prompt: string, opts: RunOptions = {}): ChildProcess => {
        const inv = this.build(prompt, opts);
        const child = spawn(inv.command, inv.args, {
          cwd: inv.cwd,
          env: inv.env ? { ...process.env, ...inv.env } : process.env,
          signal: opts.signal,
        });
        // Close stdin so an agent that reads it isn't left waiting on EOF.
        child.stdin?.end(inv.input);
        return child;
      },
    };
  }
}

/**
 * Build an {@link Agent} from an adapter (`claudeCode()`) or a `detect()` result.
 */
export const create = (source: Adapter | DetectResult): Agent =>
  new AgentImpl("adapter" in source ? source.adapter : source);
