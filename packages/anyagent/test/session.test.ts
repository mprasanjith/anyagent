import { expect, test } from "bun:test";

import { AnyAgentError } from "../src/errors.js";
import { AgentImpl } from "../src/internal/agent.js";
import type {
  Adapter,
  Invocation,
  RunOptions,
  StdoutAdapter,
} from "../src/types.js";
import {
  fakeClosedEffort,
  fakeStreaming,
  fakeText,
  runnerFromFixture,
  sourceFromBody,
} from "./fake-adapter.js";

const WITH_ID = '{"t":"session","v":"s1"}\n{"t":"text","v":"ok"}\n{"t":"end"}';
const NO_ID = '{"t":"text","v":"ok"}\n{"t":"end"}';

// Wraps a fake so each turn's options are observable.
const recording = (
  base: StdoutAdapter,
  calls: RunOptions[],
  overrides: Partial<StdoutAdapter> = {}
): StdoutAdapter => ({
  ...base,
  buildInvocation: (prompt, opts) => {
    calls.push(opts);
    return base.buildInvocation(prompt, opts);
  },
  ...overrides,
});

const forkable: StdoutAdapter = {
  ...fakeStreaming,
  capabilities: { ...fakeStreaming.capabilities, sessionFork: "native" },
};

const threading: StdoutAdapter = {
  ...fakeStreaming,
  buildInvocation: (prompt, opts) => ({
    args: opts.model ? ["-p", prompt, "--model", opts.model] : ["-p", prompt],
    command: "fake-stream",
    cwd: opts.cwd,
    env: opts.env,
  }),
};

const SETTINGS = {
  cwd: "/work",
  effort: "high",
  env: { TOKEN: "t" },
  extraArgs: ["--verbose"],
  mcp: { db: { command: "npx" } },
  model: "opus",
};

test("session() throws where the capability is false", () => {
  const agent = new AgentImpl(fakeText, { runner: runnerFromFixture("ok") });
  expect(() => agent.session()).toThrow(AnyAgentError);
  expect(() => agent.session()).toThrow("cannot continue a conversation");
});

test("a session threads the revealed id into later turns", async () => {
  const calls: RunOptions[] = [];
  const agent = new AgentImpl(recording(fakeStreaming, calls), {
    runner: runnerFromFixture(WITH_ID),
  });
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
  const agent = new AgentImpl(recording(fakeStreaming, calls), {
    runner: runnerFromFixture(WITH_ID),
  });
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
  const agent = new AgentImpl(flaky, { runner: runnerFromFixture(WITH_ID) });
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
  const agent = new AgentImpl(recording(fakeStreaming, calls), {
    runner: runnerFromFixture(WITH_ID),
  });
  const session = agent.session({ resume: "saved-9" });
  expect(session.id).toBe("saved-9");
  await session.run("continue");
  expect(calls[0]?.resume).toBe("saved-9");
});

test("fork requires resume and rides the first turn only", async () => {
  const calls: RunOptions[] = [];
  const agent = new AgentImpl(recording(forkable, calls), {
    runner: runnerFromFixture(WITH_ID),
  });
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

test("fork on an adapter without sessionFork throws UnsupportedCapability", () => {
  const agent = new AgentImpl(fakeStreaming, {
    runner: runnerFromFixture(WITH_ID),
  });
  expect(() => agent.session({ fork: true, resume: "saved-9" })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});

test("passing resume or forkSession through a session turn throws InvalidOptions", () => {
  const agent = new AgentImpl(fakeStreaming, {
    runner: runnerFromFixture(WITH_ID),
  });
  const session = agent.session();
  expect(() => session.run("x", { resume: "s1" } as RunOptions)).toThrow(
    expect.objectContaining({ code: "InvalidOptions" })
  );
  expect(() => session.run("x", { forkSession: true } as RunOptions)).toThrow(
    expect.objectContaining({ code: "InvalidOptions" })
  );
});

test("settings from agent.session() ride every turn, resumed ones included", async () => {
  const calls: RunOptions[] = [];
  const invocations: Invocation[] = [];
  const agent = new AgentImpl(recording(threading, calls), {
    runner: (inv: Invocation) => {
      invocations.push(inv);
      return sourceFromBody(WITH_ID);
    },
  });
  const session = agent.session(SETTINGS);

  await session.run("first");
  await session.run("second");

  expect(invocations.map((inv) => inv.cwd)).toEqual(["/work", "/work"]);
  expect(invocations.map((inv) => inv.env)).toEqual([
    { TOKEN: "t" },
    { TOKEN: "t" },
  ]);
  for (const inv of invocations) {
    expect(inv.args).toEqual(expect.arrayContaining(["opus", "--verbose"]));
  }
  expect(calls[0]).toMatchObject(SETTINGS);
  expect(calls[1]).toMatchObject({ ...SETTINGS, resume: "s1" });
});

test("a setting passed per-turn throws InvalidOptions and spawns nothing", () => {
  let spawns = 0;
  const agent = new AgentImpl(fakeStreaming, {
    runner: () => {
      spawns += 1;
      return sourceFromBody(WITH_ID);
    },
  });
  const session = agent.session({ model: "opus" });

  expect(() => session.run("x", { model: "sonnet" } as RunOptions)).toThrow(
    "owned by the session"
  );
  for (const opts of [
    { cwd: "/elsewhere" },
    { effort: "low" },
    { env: { TOKEN: "t" } },
    { extraArgs: ["--verbose"] },
    { mcp: {} },
  ] as RunOptions[]) {
    expect(() => session.run("x", opts)).toThrow(
      expect.objectContaining({ code: "InvalidOptions" })
    );
  }
  expect(spawns).toBe(0);
});

test("a setting on session.run does not compile", () => {
  const agent = new AgentImpl(fakeStreaming, {
    runner: runnerFromFixture(WITH_ID),
  });
  const session = agent.session();
  expect(() =>
    // @ts-expect-error model is the session's setting, not a turn option.
    session.run("x", { model: "opus" })
  ).toThrow(expect.objectContaining({ code: "InvalidOptions" }));
  expect(() =>
    // @ts-expect-error cwd is the session's setting, not a turn option.
    session.run("x", { cwd: "/elsewhere" })
  ).toThrow(expect.objectContaining({ code: "InvalidOptions" }));
});

test("an unsupported setting throws at session(), before any turn", () => {
  const noModel: Adapter = {
    ...fakeStreaming,
    capabilities: { ...fakeStreaming.capabilities, modelSelection: false },
  };
  const agent = new AgentImpl(noModel, { runner: runnerFromFixture(WITH_ID) });
  expect(() => agent.session({ model: "opus" })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );

  const closed = new AgentImpl(fakeClosedEffort, {
    runner: runnerFromFixture(WITH_ID),
  });
  expect(() => closed.session({ effort: "medium" })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
  expect(() => closed.session({ effort: "high" })).not.toThrow();
});

test("a seeded adapter registers the handle on turn one, resumes it after", async () => {
  const calls: RunOptions[] = [];
  const seeded = recording(fakeStreaming, calls, {
    sessionSeed: () => ({
      firstRunOptions: { extraArgs: ["--name", "seeded-1"] },
      id: "seeded-1",
    }),
  });
  const agent = new AgentImpl(seeded, { runner: runnerFromFixture(NO_ID) });
  const session = agent.session({ extraArgs: ["--verbose"] });
  expect(session.id).toBe("seeded-1");

  await session.run("first");
  expect(calls[0]?.resume).toBeUndefined();
  expect(calls[0]?.extraArgs).toEqual(["--name", "seeded-1", "--verbose"]);

  await session.run("second");
  expect(calls[1]?.resume).toBe("seeded-1");
  expect(calls[1]?.extraArgs).toEqual(["--verbose"]);
});

test("iterating a session turn reveals the id as the session event arrives", async () => {
  const agent = new AgentImpl(fakeStreaming, {
    runner: runnerFromFixture(WITH_ID),
  });
  const session = agent.session();
  const run = session.run("first");
  for await (const ev of run) {
    if (ev.type === "session") {
      expect(session.id).toBe("s1");
    }
  }
  await run;
});

test("steer and respond throw in stdout mode, and supports says so", () => {
  const agent = new AgentImpl(fakeStreaming, {
    runner: runnerFromFixture(WITH_ID),
  });
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
  const agent = new AgentImpl(concealing, { runner: runnerFromFixture(NO_ID) });
  const session = agent.session();
  await session.run("first");
  await expect(session.run("second")).rejects.toMatchObject({
    code: "Parse",
  });
});
