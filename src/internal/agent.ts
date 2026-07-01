import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { resolvePermission, validateOptions } from "./capabilities.js";
import { AnyAgentError } from "./errors.js";
import { spawnAndStream } from "./runtime/spawn.js";
import type {
  Adapter,
  Agent,
  AgentEvent,
  Invocation,
  OutputSource,
  RawHandle,
  RunOptions,
  RunResult,
} from "./types.js";

type Runner = (invocation: Invocation, signal?: AbortSignal) => OutputSource;

const withPermission = (opts: RunOptions): RunOptions => ({
  ...opts,
  permission: resolvePermission(opts),
});

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

  async *runStream(
    prompt: string,
    opts: RunOptions = {}
  ): AsyncGenerator<AgentEvent, RunResult> {
    validateOptions(this.adapter.capabilities, opts);
    const invocation = this.adapter.buildInvocation(
      prompt,
      withPermission(opts)
    );
    const source = this.run_(invocation, opts.signal);
    return yield* this.adapter.parse(source, { strict: false });
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
        this.adapter.buildInvocation(prompt, withPermission(opts)),
      spawn: (prompt: string, opts: RunOptions = {}): ChildProcess => {
        const inv = this.adapter.buildInvocation(prompt, withPermission(opts));
        const child = spawn(inv.command, inv.args, {
          cwd: inv.cwd,
          env: inv.env ? { ...process.env, ...inv.env } : process.env,
        });
        if (inv.input !== undefined) {
          child.stdin?.end(inv.input);
        }
        return child;
      },
    };
  }
}

export interface CreateOptions {
  adapter: Adapter;
}

/** Build an {@link Agent} for an adapter, e.g. one from `detect()` or `claudeCode()`. */
export const create = (opts: CreateOptions): Promise<Agent> =>
  Promise.resolve(new AgentImpl(opts.adapter));
