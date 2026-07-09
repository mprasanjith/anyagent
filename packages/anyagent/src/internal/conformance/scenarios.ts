import type { Invocation, OutputSource } from "../types.js";

/**
 * An {@link OutputSource} that replays a recorded stdout body with a clean
 * zero exit — the offline stand-in for a spawned CLI.
 */
export const sourceFromBody = (body: string): OutputSource => ({
  exitCode: Promise.resolve(0),
  async *lines() {
    for (const l of body.split("\n")) {
      yield l;
    }
  },
  stderr: () => Promise.resolve(""),
  text: () => Promise.resolve(body),
});

/**
 * A drop-in for `AgentImpl`'s runner that ignores the invocation and replays
 * `body`, so conformance drives adapters from fixtures, never subprocesses.
 */
export const fixedRunner =
  (body: string) =>
  (_inv: Invocation): OutputSource =>
    sourceFromBody(body);
