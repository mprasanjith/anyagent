import type { ChildProcess } from "node:child_process";

import { resolvePermission, validateOptions } from "./capabilities.js";
import { applyEmulations } from "./emulate.js";
import { AnyAgentError } from "../errors.js";
import { spawnAndStream, spawnChild } from "./runtime/spawn.js";
import { extractJson, validateAgainstSchema } from "./structured.js";
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
} from "../types.js";

type Runner = (invocation: Invocation, signal?: AbortSignal) => OutputSource;

type Parsed = { json: unknown } | { errors: string[] };

/** Extract and validate a reply against a schema, in one pass. */
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

const correctionPrompt = (
  prompt: string,
  previous: string,
  errors: string[]
): string =>
  `${prompt}\n\nYour previous reply could not be used:\n\n<previous-reply>\n${previous}\n</previous-reply>\n\nIt failed these checks:\n${errors
    .map((e) => `- ${e}`)
    .join("\n")}\n\nReply again with only a corrected JSON value.`;

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
    // Emulated capabilities are folded into the prompt (and stripped from the
    // opts) here, never in the raw path — raw is the native surface.
    const emulated = applyEmulations(this.adapter, prompt, opts);
    const invocation = this.build(emulated.prompt, emulated.opts);
    const source = this.runner(invocation, opts.signal);
    try {
      return yield* this.adapter.parse(source, { strict: false });
    } finally {
      // Runs on normal completion (child already exited: no-op) and when a
      // consumer breaks early, terminating a stream nobody is reading.
      source.close?.();
    }
  }

  private async collect(prompt: string, opts: RunOptions): Promise<RunResult> {
    for await (const ev of this.runStream(prompt, opts)) {
      if (ev.type === "done") {
        return ev.result;
      }
    }
    throw new AnyAgentError("Parse", "adapter produced no terminal done event");
  }

  async run(prompt: string, opts: RunOptions = {}): Promise<RunResult> {
    const result = await this.collect(prompt, opts);
    if (opts.schema === undefined) {
      return result;
    }

    const first = evaluate(result.text, opts.schema);
    if ("json" in first) {
      return { ...result, json: first.json };
    }

    // One fixed retry: re-ask with the failed reply and errors quoted, letting
    // the same emulation pipeline re-append the schema instructions.
    const retry = await this.collect(
      correctionPrompt(prompt, result.text, first.errors),
      opts
    );
    const second = evaluate(retry.text, opts.schema);
    if ("json" in second) {
      return { ...retry, json: second.json };
    }
    throw new AnyAgentError(
      "Parse",
      `reply did not match schema: ${second.errors.join("; ")}`,
      { raw: retry.text }
    );
  }
}

/**
 * Build a runnable {@link Agent}. Accepts either an adapter directly —
 * `create(claudeCode())` when you know which CLI you want — or one of
 * `detect()`'s results when you want whatever is installed.
 */
export const create = (source: Adapter | DetectResult): Agent =>
  new AgentImpl("adapter" in source ? source.adapter : source);
