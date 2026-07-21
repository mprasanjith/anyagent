import type { ChildProcess } from "node:child_process";
import { AnyAgentError } from "../errors.js";
import type {
  Adapter,
  Agent,
  AgentEvent,
  AuthStatus,
  Capabilities,
  ExtensionKey,
  Invocation,
  ModelInfo,
  OutputSource,
  RawHandle,
  RunOptions,
  RunResult,
  SupportedCapabilities,
  SystemProbe,
} from "../types.js";
import { EXTENSION_CAPABILITY } from "../types.js";
import { validateOptions } from "./capabilities.js";
import { applyEmulations } from "./emulate.js";
import {
  realSystemProbe,
  spawnAndStream,
  spawnChild,
} from "./runtime/spawn.js";
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

const correctionPrompt = (
  prompt: string,
  previous: string,
  errors: string[]
): string =>
  `${prompt}\n\nYour previous reply could not be used:\n\n<previous-reply>\n${previous}\n</previous-reply>\n\nIt failed these checks:\n${errors
    .map((e) => `- ${e}`)
    .join("\n")}\n\nReply again with only a corrected JSON value.`;

// The concrete {@link Agent}: validates options against the adapter's
// capabilities, spawns via the injected runner (real process spawn by
// default; tests inject fixture-backed runners), answers discovery through
// the injected probe, and delegates output parsing to the adapter.
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
