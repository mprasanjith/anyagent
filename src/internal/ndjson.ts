import { AnyAgentError } from "./errors.js";
import type { AgentEvent, OutputSource, RunResult } from "./types.js";

export interface NdjsonSpec<Ctx> {
  init: () => Ctx;
  /**
   * Map one raw NDJSON object to normalized event(s), or `null` to ignore it.
   * When `strict`, throw `AnyAgentError("Parse")` on an unrecognized event type
   * or a missing expected field so the live drift check can detect it.
   */
  map: (
    obj: unknown,
    ctx: Ctx,
    strict: boolean
  ) => AgentEvent | AgentEvent[] | null;
  finalize: (ctx: Ctx) => RunResult;
}

export const ndjsonParser = <Ctx>(spec: NdjsonSpec<Ctx>) =>
  async function* parse(
    source: OutputSource,
    opts: { strict: boolean }
  ): AsyncGenerator<AgentEvent, RunResult> {
    const ctx = spec.init();
    const events: AgentEvent[] = [];
    for await (const line of source.lines()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch (error) {
        throw new AnyAgentError(
          "Parse",
          `invalid JSON line: ${trimmed.slice(0, 120)}`,
          {
            raw: error,
          }
        );
      }
      const mapped = spec.map(obj, ctx, opts.strict);
      if (!mapped) {
        continue;
      }
      for (const ev of Array.isArray(mapped) ? mapped : [mapped]) {
        events.push(ev);
        yield ev;
      }
    }
    // A nonzero exit rejects here, surfacing the descriptive Invocation error.
    await source.exitCode;
    const result = spec.finalize(ctx);
    result.events = events;
    yield { result, type: "done" };
    return result;
  };
