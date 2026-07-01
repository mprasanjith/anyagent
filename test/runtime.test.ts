import { expect, test } from "bun:test";

import { realProbe, spawnAndStream } from "../src/internal/runtime/spawn.js";

test("streams stdout lines from a real process", async () => {
  const src = spawnAndStream({ args: ["a\nb\nc"], command: "printf" });
  const got: string[] = [];
  for await (const l of src.lines()) {
    got.push(l);
  }
  expect(got).toEqual(["a", "b", "c"]);
  expect(await src.exitCode).toBe(0);
});

test("text() buffers whole stdout", async () => {
  const src = spawnAndStream({ args: ["hello"], command: "printf" });
  expect(await src.text()).toBe("hello");
});

test("spawn failure surfaces a descriptive Invocation error with argv", async () => {
  const src = spawnAndStream({
    args: [],
    command: "definitely-not-a-real-binary-xyz",
  });
  await expect(
    (async () => {
      for await (const _ of src.lines()) {
        // drain
      }
    })()
  ).rejects.toMatchObject({
    argv: ["definitely-not-a-real-binary-xyz"],
    code: "Invocation",
    message: expect.stringContaining("failed to spawn"),
  });
});

test("nonzero exit reports code and stderr snippet", async () => {
  const src = spawnAndStream({
    args: ["-c", "echo boom 1>&2; exit 3"],
    command: "sh",
  });
  await expect(src.exitCode).rejects.toMatchObject({
    code: "Invocation",
    message: expect.stringContaining("boom"),
    stderr: expect.stringContaining("boom"),
  });
});

test("realProbe.which resolves an existing binary and null for a missing one", async () => {
  expect(await realProbe.which("sh")).toBeTruthy();
  expect(await realProbe.which("definitely-not-a-real-binary-xyz")).toBeNull();
});
