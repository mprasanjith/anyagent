import { expect, test } from "bun:test";

import { realRpc } from "../src/internal/runtime/rpc.js";
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
  });
});

test("nonzero exit reports code and stderr snippet", async () => {
  const src = spawnAndStream({
    args: ["-c", "echo boom 1>&2; exit 3"],
    command: "sh",
  });
  await expect(src.exitCode).rejects.toMatchObject({
    code: "Invocation",
    stderr: expect.stringContaining("boom"),
  });
});

test("aborting the signal rejects exitCode with an Aborted error", async () => {
  const controller = new AbortController();
  const src = spawnAndStream(
    { args: ["-c", "sleep 5"], command: "sh" },
    controller.signal
  );
  controller.abort();
  await expect(src.exitCode).rejects.toMatchObject({
    argv: ["sh", "-c", "sleep 5"],
    code: "Aborted",
  });
});

test("realProbe.which resolves an existing binary and undefined for a missing one", async () => {
  expect(await realProbe.which("sh")).toBeTruthy();
  expect(
    await realProbe.which("definitely-not-a-real-binary-xyz")
  ).toBeUndefined();
});

// A tiny JSON-RPC echo service: emits one unsolicited notification, answers
// every request with its own method name, and errors on "boom" — enough to
// exercise ordering, notification handling, and error outcomes for real.
const ECHO_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "server/noise", params: {} }) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = m.method === "boom"
    ? { jsonrpc: "2.0", id: m.id, error: { code: -1, message: "kaboom" } }
    : { jsonrpc: "2.0", id: m.id, result: { method: m.method } };
  process.stdout.write(JSON.stringify(reply) + "\\n");
});
`;

test("rpc runs exchanges in order and aligns outcomes by index", async () => {
  const outcomes = await realRpc(
    "bun",
    ["-e", ECHO_SERVER],
    [
      { method: "initialize", params: { a: 1 } },
      { method: "initialized", notification: true },
      { method: "account/read" },
      { method: "boom" },
    ]
  );
  expect(outcomes).toEqual([
    { result: { method: "initialize" } },
    undefined,
    { result: { method: "account/read" } },
    { error: { code: -1, message: "kaboom" } },
  ]);
});

test("rpc kills a process that answers with non-JSON output", async () => {
  await expect(
    realRpc("sh", ["-c", "echo hello; sleep 5"], [{ method: "x" }])
  ).rejects.toMatchObject({ code: "Parse" });
});

test("rpc fails loud when the process dies mid-dialogue", async () => {
  await expect(
    realRpc("sh", ["-c", "exit 0"], [{ method: "x" }])
  ).rejects.toMatchObject({ code: "Invocation" });
});

test("rpc times out on a silent service", async () => {
  await expect(
    realRpc("sh", ["-c", "sleep 5"], [{ method: "x" }], { timeoutMs: 300 })
  ).rejects.toMatchObject({ code: "Invocation" });
});
