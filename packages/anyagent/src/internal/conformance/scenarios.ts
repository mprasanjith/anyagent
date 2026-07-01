import type { Invocation, OutputSource } from "../types.js";

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

export const fixedRunner =
  (body: string) =>
  (_inv: Invocation): OutputSource =>
    sourceFromBody(body);
