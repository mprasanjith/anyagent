import { AnyAgentError } from "./errors.js";
import type { Adapter, AgentEvent, OutputSource, RunResult } from "./types.js";

/**
 * The three pieces an NDJSON adapter supplies to {@link ndjsonParser}:
 * `init` creates the per-run accumulator state, `map` turns one raw JSON
 * object from the CLI into normalized event(s), and `finalize` builds the
 * terminal {@link RunResult} from that state once the stream ends. `Ctx` is
 * whatever shape your adapter needs to carry between lines — accumulated
 * text, tool-call ids, the final raw payload.
 */
export interface NdjsonSpec<Ctx> {
  finalize: (ctx: Ctx) => RunResult;
  init: () => Ctx;
  /**
   * Map one raw NDJSON object to normalized event(s), or `undefined` to ignore
   * it. When `strict`, throw `AnyAgentError("Parse")` on an unrecognized event
   * type or a missing expected field so the live drift check can detect it.
   */
  map: (
    obj: unknown,
    ctx: Ctx,
    strict: boolean
  ) => AgentEvent | AgentEvent[] | undefined;
}

/**
 * Build an `Adapter.parse` from an {@link NdjsonSpec}, so an NDJSON adapter
 * only has to write its event mapping. The parser owns everything the NDJSON
 * adapters share: decoding one JSON object per line (a malformed line throws
 * `AnyAgentError` with `code: "Parse"` and the offending text), buffering
 * events into the result, awaiting the process exit (a nonzero exit throws
 * the descriptive `Invocation` error), and emitting the single terminal
 * `done` event.
 */
export const ndjsonParser = <Ctx>(spec: NdjsonSpec<Ctx>): Adapter["parse"] =>
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
        // biome-ignore lint/style/useErrorCause: AnyAgentError carries the original on `raw`, its documented cause field.
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
