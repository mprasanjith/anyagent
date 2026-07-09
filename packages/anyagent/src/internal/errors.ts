/**
 * Which way a run failed. Every error AnyAgent throws carries exactly one of
 * these on its `code`:
 *
 * - `"UnsupportedCapability"` — you asked for something this agent's CLI
 *   cannot do: an option its capability table does not declare, or a
 *   permission level it does not offer. Thrown before anything spawns.
 * - `"Invocation"` — the CLI itself went wrong: it failed to spawn, exited
 *   nonzero, or reported an agent-level error. `argv` and `stderr` on the
 *   error tell you what ran and what it said.
 * - `"Parse"` — the CLI ran, but its output did not match the shape the
 *   adapter expects, or the stream ended without a terminal `done` event.
 * - `"Aborted"` — your `AbortSignal` fired and the run was terminated.
 */
export type AnyAgentErrorCode =
  | "UnsupportedCapability"
  | "Invocation"
  | "Parse"
  | "Aborted";

/**
 * The single error type everything in AnyAgent throws — there is no subclass
 * tree to match against. Branch on `code`:
 *
 * ```ts
 * try {
 *   await agent.run(prompt, { signal });
 * } catch (err) {
 *   if (err instanceof AnyAgentError && err.code === "Aborted") {
 *     return; // the user cancelled; not a failure
 *   }
 *   throw err;
 * }
 * ```
 *
 * `raw` preserves the underlying cause (a native error, or the CLI's own
 * error payload); `argv` and `stderr` are attached when a process was
 * involved.
 */
export class AnyAgentError extends Error {
  readonly code: AnyAgentErrorCode;
  readonly raw?: unknown;
  readonly argv?: string[];
  readonly stderr?: string;

  constructor(
    code: AnyAgentErrorCode,
    message: string,
    opts?: { raw?: unknown; argv?: string[]; stderr?: string }
  ) {
    super(message);
    this.name = "AnyAgentError";
    this.code = code;
    this.raw = opts?.raw;
    this.argv = opts?.argv;
    this.stderr = opts?.stderr;
  }

  /**
   * Coerce any thrown value into an `AnyAgentError` under the given `code`
   * (default `"Invocation"`), keeping the original on `raw`. An
   * `AnyAgentError` passes through untouched, so wrapping never masks a more
   * specific code set earlier.
   */
  static wrap(
    err: unknown,
    code: AnyAgentErrorCode = "Invocation"
  ): AnyAgentError {
    if (err instanceof AnyAgentError) {
      return err;
    }
    const message = err instanceof Error ? err.message : String(err);
    return new AnyAgentError(code, message, { raw: err });
  }
}
