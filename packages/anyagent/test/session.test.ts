import { expect, test } from "bun:test";

import { AnyAgentError } from "../src/errors.js";
import { AgentImpl } from "../src/internal/agent.js";
import type { Adapter, RunOptions } from "../src/types.js";
import { fakeStreaming, fakeText, runnerFromFixture } from "./fake-adapter.js";

const WITH_ID = '{"t":"session","v":"s1"}\n{"t":"text","v":"ok"}\n{"t":"end"}';
const NO_ID = '{"t":"text","v":"ok"}\n{"t":"end"}';

// Wraps a fake so each turn's options are observable.
const recording = (
  base: Adapter,
  calls: RunOptions[],
  overrides: Partial<Adapter> = {}
): Adapter => ({
  ...base,
  buildInvocation: (prompt, opts) => {
    calls.push(opts);
    return base.buildInvocation(prompt, opts);
  },
  ...overrides,
});

const forkable: Adapter = {
  ...fakeStreaming,
  capabilities: { ...fakeStreaming.capabilities, sessionFork: "native" },
};

test("session() throws where the capability is false", () => {
  const agent = new AgentImpl(fakeText, runnerFromFixture("ok"));
  expect(() => agent.session()).toThrow(AnyAgentError);
  expect(() => agent.session()).toThrow("cannot continue a conversation");
});

test("a session threads the revealed id into later turns", async () => {
  const calls: RunOptions[] = [];
  const agent = new AgentImpl(
    recording(fakeStreaming, calls),
    runnerFromFixture(WITH_ID)
  );
  const session = agent.session();
  expect(session.id).toBeUndefined();

  await session.run("first");
  expect(session.id).toBe("s1");
  expect(calls[0]?.resume).toBeUndefined();

  await session.run("second");
  expect(calls[1]?.resume).toBe("s1");
});

test("turns queue: two runs fired together execute in order, threaded", async () => {
  const calls: RunOptions[] = [];
  const agent = new AgentImpl(
    recording(fakeStreaming, calls),
    runnerFromFixture(WITH_ID)
  );
  const session = agent.session();
  const first = session.run("first");
  const second = session.run("second");
  const [a, b] = await Promise.all([first, second]);
  expect(a.text).toBe("ok");
  expect(b.text).toBe("ok");
  expect(calls[0]?.resume).toBeUndefined();
  expect(calls[1]?.resume).toBe("s1");
});

test("a failed turn rejects its queued successors; a later run retries", async () => {
  const calls: RunOptions[] = [];
  let fail = true;
  const flaky = recording(fakeStreaming, calls, {
    async *parse(source, opts) {
      if (fail) {
        fail = false;
        throw new AnyAgentError("Invocation", "boom");
      }
      return yield* fakeStreaming.parse(source, opts);
    },
  });
  const agent = new AgentImpl(flaky, runnerFromFixture(WITH_ID));
  const session = agent.session();

  const first = session.run("first");
  const queued = session.run("second");
  await expect(first).rejects.toMatchObject({ code: "Invocation" });
  await expect(queued).rejects.toMatchObject({ code: "Invocation" });

  const retry = await session.run("third");
  expect(retry.text).toBe("ok");
});

test("session({ resume }) continues from a persisted id on the first turn", async () => {
  const calls: RunOptions[] = [];
  const agent = new AgentImpl(
    recording(fakeStreaming, calls),
    runnerFromFixture(WITH_ID)
  );
  const session = agent.session({ resume: "saved-9" });
  expect(session.id).toBe("saved-9");
  await session.run("continue");
  expect(calls[0]?.resume).toBe("saved-9");
});

test("fork requires resume and rides the first turn only", async () => {
  const calls: RunOptions[] = [];
  const agent = new AgentImpl(
    recording(forkable, calls),
    runnerFromFixture(WITH_ID)
  );
  expect(() => agent.session({ fork: true })).toThrow(
    expect.objectContaining({ code: "InvalidOptions" })
  );

  const session = agent.session({ fork: true, resume: "saved-9" });
  await session.run("first");
  expect(calls[0]).toMatchObject({ forkSession: true, resume: "saved-9" });
  // The forked conversation's own id takes over.
  expect(session.id).toBe("s1");

  await session.run("second");
  expect(calls[1]?.forkSession).toBeUndefined();
  expect(calls[1]?.resume).toBe("s1");
});

test("fork on an adapter without sessionFork throws UnsupportedCapability", async () => {
  const agent = new AgentImpl(fakeStreaming, runnerFromFixture(WITH_ID));
  const session = agent.session({ fork: true, resume: "saved-9" });
  await expect(session.run("first")).rejects.toMatchObject({
    code: "UnsupportedCapability",
  });
});

test("passing resume or forkSession through a session turn throws InvalidOptions", () => {
  const agent = new AgentImpl(fakeStreaming, runnerFromFixture(WITH_ID));
  const session = agent.session();
  expect(() => session.run("x", { resume: "s1" } as RunOptions)).toThrow(
    expect.objectContaining({ code: "InvalidOptions" })
  );
  expect(() => session.run("x", { forkSession: true } as RunOptions)).toThrow(
    expect.objectContaining({ code: "InvalidOptions" })
  );
});

test("a seeded adapter registers the handle on turn one, resumes it after", async () => {
  const calls: RunOptions[] = [];
  const seeded = recording(fakeStreaming, calls, {
    sessionSeed: () => ({
      firstRunOptions: { extraArgs: ["--name", "seeded-1"] },
      id: "seeded-1",
    }),
  });
  const agent = new AgentImpl(seeded, runnerFromFixture(NO_ID));
  const session = agent.session();
  expect(session.id).toBe("seeded-1");

  await session.run("first");
  expect(calls[0]?.resume).toBeUndefined();
  expect(calls[0]?.extraArgs).toEqual(["--name", "seeded-1"]);

  await session.run("second");
  expect(calls[1]?.resume).toBe("seeded-1");
  expect(calls[1]?.extraArgs).toBeUndefined();
});

test("iterating a session turn reveals the id as the session event arrives", async () => {
  const agent = new AgentImpl(fakeStreaming, runnerFromFixture(WITH_ID));
  const session = agent.session();
  const run = session.run("first");
  for await (const ev of run) {
    if (ev.type === "session") {
      expect(session.id).toBe("s1");
    }
  }
  await run;
});

test("steer and respond throw on the emulated tier, and supports says so", () => {
  const agent = new AgentImpl(fakeStreaming, runnerFromFixture(WITH_ID));
  const session = agent.session();
  expect(session.supports("steer")).toBe(false);
  expect(() => session.steer("go faster")).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
  expect(() => session.respond("r1", "allow")).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});

test("a session on an id-concealing, unseeded adapter fails the second turn honestly", async () => {
  const concealing = { ...fakeStreaming, sessionSeed: undefined };
  const agent = new AgentImpl(concealing, runnerFromFixture(NO_ID));
  const session = agent.session();
  await session.run("first");
  await expect(session.run("second")).rejects.toMatchObject({
    code: "Parse",
  });
});
