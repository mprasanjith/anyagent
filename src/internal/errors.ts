export type AnyAgentErrorCode =
  | "UnsupportedCapability"
  | "Invocation"
  | "Parse"
  | "Aborted";

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
