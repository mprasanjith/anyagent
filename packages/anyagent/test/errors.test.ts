import { expect, test } from "bun:test";

import { AnyAgentError } from "../src/internal/errors.js";

test("AnyAgentError carries its code plus argv/stderr context", () => {
  const e = new AnyAgentError("Invocation", "boom", {
    argv: ["claude", "-p"],
    stderr: "bad",
  });
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe("AnyAgentError");
  expect(e.code).toBe("Invocation");
  expect(e.argv).toEqual(["claude", "-p"]);
  expect(e.stderr).toBe("bad");
});

test("wrap returns an AnyAgentError as-is and wraps a native error with the given code", () => {
  const orig = new AnyAgentError("Parse", "x");
  expect(AnyAgentError.wrap(orig)).toBe(orig);
  const wrapped = AnyAgentError.wrap(new Error("native"), "Invocation");
  expect(wrapped.code).toBe("Invocation");
  expect(wrapped.message).toBe("native");
  expect(wrapped.raw).toBeInstanceOf(Error);
});
