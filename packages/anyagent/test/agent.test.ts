import { expect, test } from "bun:test";
import { once } from "node:events";

import { create } from "../src/index.js";
import { AgentImpl } from "../src/internal/agent.js";
import type {
  Adapter,
  AgentEvent,
  DetectResult,
  OutputSource,
  RunResult,
} from "../src/types.js";
import {
  fakeBinaryPerms,
  fakeStreaming,
  fakeText,
  runnerFromFixture,
} from "./fake-adapter.js";

const readAll = async (
  stream: NodeJS.ReadableStream | null
): Promise<string> => {
  let out = "";
  if (!stream) {
    return out;
  }
  for await (const chunk of stream) {
    out += chunk.toString();
  }
  return out;
};

test("run() returns final result with concatenated text (streaming adapter)", async () => {
  const agent = new AgentImpl(
    fakeStreaming,
    runnerFromFixture(
      '{"t":"text","v":"Hel"}\n{"t":"text","v":"lo"}\n{"t":"end"}'
    )
  );
  const res = await agent.run("hi");
  expect(res.text).toBe("Hello");
  // done is yielded, not stored in the events list
  expect(res.events.some((e) => e.type === "done")).toBe(false);
});

test("runStream() yields events then a terminal done", async () => {
  const agent = new AgentImpl(
    fakeStreaming,
    runnerFromFixture(
      '{"t":"text","v":"Hi"}\n{"t":"tool","name":"Read","input":{}}\n{"t":"end"}'
    )
  );
  const types: string[] = [];
  for await (const ev of agent.runStream("go")) {
    types.push(ev.type);
  }
  expect(types).toEqual(["text-delta", "tool-call", "done"]);
});

test("non-streaming adapter synthesizes a single delta", async () => {
  const agent = new AgentImpl(fakeText, runnerFromFixture("the answer"));
  const res = await agent.run("q");
  expect(res.text).toBe("the answer");
});

test("requesting read on a binary-perms adapter throws UnsupportedCapability", async () => {
  const agent = new AgentImpl(
    fakeBinaryPerms,
    runnerFromFixture('{"t":"end"}')
  );
  await expect(agent.run("q", { permission: "read" })).rejects.toMatchObject({
    code: "UnsupportedCapability",
  });
});

test("breaking out of runStream early terminates the underlying process", async () => {
  let closed = false;
  const runner = (): OutputSource => ({
    close: () => {
      closed = true;
    },
    exitCode: Promise.resolve(0),
    // biome-ignore lint/suspicious/useAwait: replays in-memory data through the async OutputSource interface.
    async *lines() {
      yield '{"t":"text","v":"Hi"}';
      yield '{"t":"end"}';
    },
    stderr: () => Promise.resolve(""),
    text: () => Promise.resolve(""),
  });
  const agent = new AgentImpl(fakeStreaming, runner);
  for await (const ev of agent.runStream("go")) {
    if (ev.type === "text-delta") {
      break;
    }
  }
  expect(closed).toBe(true);
});

test("raw.buildInvocation exposes native argv", () => {
  const agent = new AgentImpl(fakeStreaming, runnerFromFixture(""));
  expect(agent.raw.buildInvocation("hi").args).toEqual(["-p", "hi"]);
});

test("raw returns the same handle across accesses", () => {
  const agent = new AgentImpl(fakeStreaming, runnerFromFixture(""));
  expect(agent.raw).toBe(agent.raw);
});

test("extraArgs escape hatch appends native flags to the argv", () => {
  const agent = new AgentImpl(fakeStreaming, runnerFromFixture(""));
  const inv = agent.raw.buildInvocation("hi", { extraArgs: ["--native", "x"] });
  expect(inv.args).toEqual(["-p", "hi", "--native", "x"]);
});

test("run() throws Parse when the adapter never yields a done event", async () => {
  const noDone: Adapter = {
    ...fakeStreaming,
    async *parse() {
      await Promise.resolve();
      yield { text: "x", type: "text-delta" } as AgentEvent;
      return { events: [], raw: undefined, text: "" } as RunResult;
    },
  };
  const agent = new AgentImpl(noDone, runnerFromFixture(""));
  await expect(agent.run("q")).rejects.toMatchObject({
    code: "Parse",
    message: expect.stringContaining("no terminal done"),
  });
});

test("create() accepts a DetectResult and builds an agent for its adapter", () => {
  const detected: DetectResult = {
    adapter: fakeStreaming,
    capabilities: fakeStreaming.capabilities,
    id: "fake-stream",
    name: "Fake Stream",
    path: "/usr/bin/fake-stream",
    version: "1.0.0",
  };
  const agent = create(detected);
  expect(agent.adapter).toBe(fakeStreaming);
  expect(agent.capabilities).toBe(fakeStreaming.capabilities);
});

test("raw.spawn wires prompt to stdin and merges env into the child", async () => {
  const shAdapter: Adapter = {
    ...fakeStreaming,
    buildInvocation: (prompt, opts) => ({
      args: ["-c", `printf '%s/%s' "$(cat)" "$MY_VAR"`],
      command: "sh",
      env: opts.env,
      input: prompt,
    }),
  };
  const agent = new AgentImpl(shAdapter);
  const child = agent.raw.spawn("hi", { env: { MY_VAR: "xyz" } });
  const out = await readAll(child.stdout);
  await once(child, "close");
  expect(out).toBe("hi/xyz");
});

test("aborting the signal terminates the run and rejects", async () => {
  const sleeper: Adapter = {
    ...fakeStreaming,
    buildInvocation: () => ({ args: ["-c", "sleep 5"], command: "sh" }),
  };
  const agent = new AgentImpl(sleeper);
  const controller = new AbortController();
  const pending = agent.run("go", { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "Aborted" });
});
