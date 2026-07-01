import { expect, test } from "bun:test";

import { AgentImpl } from "../src/internal/agent.js";
import type { OutputSource } from "../src/internal/types.js";
import {
  fakeBinaryPerms,
  fakeStreaming,
  fakeText,
  runnerFromFixture,
} from "./fake-adapter.js";

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

test("requesting read-only on a binary-perms adapter throws UnsupportedCapability", async () => {
  const agent = new AgentImpl(
    fakeBinaryPerms,
    runnerFromFixture('{"t":"end"}')
  );
  await expect(
    agent.run("q", { permission: "read-only" })
  ).rejects.toMatchObject({
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

test("extraArgs escape hatch appends native flags to the argv", () => {
  const agent = new AgentImpl(fakeStreaming, runnerFromFixture(""));
  const inv = agent.raw.buildInvocation("hi", { extraArgs: ["--native", "x"] });
  expect(inv.args).toEqual(["-p", "hi", "--native", "x"]);
});
