import { expect, test } from "bun:test";
import { once } from "node:events";

import { AnyAgentError } from "../src/errors.js";
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
  fakeClosedEffort,
  fakeStreaming,
  fakeSystemProbe,
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

test("iterating a run yields events then a terminal done", async () => {
  const agent = new AgentImpl(
    fakeStreaming,
    runnerFromFixture(
      '{"t":"text","v":"Hi"}\n{"t":"tool","name":"Read","input":{}}\n{"t":"end"}'
    )
  );
  const types: string[] = [];
  for await (const ev of agent.run("go")) {
    types.push(ev.type);
  }
  expect(types).toEqual(["text-delta", "tool-call", "done"]);
});

test("one run serves an iterator and an awaiter at once", async () => {
  const agent = new AgentImpl(
    fakeStreaming,
    runnerFromFixture('{"t":"text","v":"Hi"}\n{"t":"end"}')
  );
  const run = agent.run("go");
  const types: string[] = [];
  for await (const ev of run) {
    types.push(ev.type);
  }
  const res = await run;
  expect(types).toEqual(["text-delta", "done"]);
  expect(res.text).toBe("Hi");
});

test("non-streaming adapter synthesizes a single delta", async () => {
  const agent = new AgentImpl(fakeText, runnerFromFixture("the answer"));
  const res = await agent.run("q");
  expect(res.text).toBe("the answer");
});

test("readOnly: true on an adapter that declares it false throws before spawning", async () => {
  const agent = new AgentImpl(fakeText, runnerFromFixture("ok"));
  await expect(agent.run("q", { readOnly: true })).rejects.toMatchObject({
    code: "UnsupportedCapability",
  });
});

test("readOnly: false is the default spelled out and never throws", async () => {
  const agent = new AgentImpl(fakeText, runnerFromFixture("ok"));
  const res = await agent.run("q", { readOnly: false });
  expect(res.text).toBe("ok");
});

test("run() rejects an effort outside the adapter's closed vocabulary", async () => {
  const agent = new AgentImpl(
    fakeClosedEffort,
    runnerFromFixture('{"t":"text","v":"ok"}\n{"t":"end"}')
  );
  await expect(agent.run("q", { effort: "medium" })).rejects.toMatchObject({
    code: "UnsupportedCapability",
  });
  const res = await agent.run("q", { effort: "low" });
  expect(res.text).toBe("ok");
});

test("supports() reflects capability truthiness and ANDs multiple keys", () => {
  const streaming = new AgentImpl(fakeStreaming, runnerFromFixture(""));
  expect(streaming.supports("effort", "mcp", "readOnly", "resume")).toBe(true);

  // fakeText: mcp is available, effort/readOnly/resume are false.
  const text = new AgentImpl(fakeText, runnerFromFixture(""));
  expect(text.supports("mcp")).toBe(true);
  expect(text.supports("effort")).toBe(false);
  expect(text.supports("readOnly")).toBe(false);
  expect(text.supports("resume")).toBe(false);
  // One false key fails the whole set.
  expect(text.supports("mcp", "effort")).toBe(false);
});

test("supports() treats an emulated capability as available", () => {
  const emulated: Adapter = {
    ...fakeText,
    capabilities: { ...fakeText.capabilities, effort: "emulated" },
  };
  const agent = new AgentImpl(emulated, runnerFromFixture(""));
  expect(agent.supports("effort")).toBe(true);
});

test("authStatus() and models() throw UnsupportedCapability on a false capability", async () => {
  const agent = new AgentImpl(fakeText, runnerFromFixture(""));
  await expect(agent.authStatus()).rejects.toMatchObject({
    code: "UnsupportedCapability",
  });
  await expect(agent.models()).rejects.toMatchObject({
    code: "UnsupportedCapability",
  });
});

test("a declared discovery capability with a missing impl throws, never crashes", async () => {
  const liar: Adapter = {
    ...fakeText,
    capabilities: {
      ...fakeText.capabilities,
      authStatus: "probed",
      modelListing: "native",
    },
  };
  const agent = new AgentImpl(liar, runnerFromFixture(""));
  await expect(agent.authStatus()).rejects.toMatchObject({
    code: "UnsupportedCapability",
  });
  await expect(agent.models()).rejects.toMatchObject({
    code: "UnsupportedCapability",
  });
});

// An adapter whose discovery reads the machine only through the probe, so a
// test can prove the injected probe is what the impl received.
const probeReader: Adapter = {
  ...fakeStreaming,
  authStatus: (probe) =>
    Promise.resolve({
      method: probe.env.FAKE_METHOD,
      state: probe.env.FAKE_TOKEN ? "authenticated" : "unauthenticated",
    }),
  listModels: async (probe) => {
    const file = await probe.readFile("/models.txt");
    return (file ?? "")
      .split(",")
      .filter(Boolean)
      .map((id) => ({ id }));
  },
};

test("authStatus() and models() delegate to the adapter with the injected probe", async () => {
  const probe = fakeSystemProbe({
    env: { FAKE_METHOD: "api-key", FAKE_TOKEN: "t" },
    readFile: (p) => Promise.resolve(p === "/models.txt" ? "m1,m2" : undefined),
  });
  const agent = new AgentImpl(probeReader, runnerFromFixture(""), probe);
  expect(await agent.authStatus()).toEqual({
    method: "api-key",
    state: "authenticated",
  });
  expect((await agent.models()).map((m) => m.id)).toEqual(["m1", "m2"]);
});

test("create({ probe }) hands the probe to discovery", async () => {
  const agent = create(probeReader, {
    probe: fakeSystemProbe({ env: { FAKE_TOKEN: "t" } }),
  });
  expect((await agent.authStatus()).state).toBe("authenticated");
  const bare = create(probeReader, { probe: fakeSystemProbe() });
  expect((await bare.authStatus()).state).toBe("unauthenticated");
});

test("create() accepts an adapter directly", () => {
  const agent = create(fakeStreaming);
  expect(agent.adapter).toBe(fakeStreaming);
  expect(agent.capabilities).toBe(fakeStreaming.capabilities);
  expect(agent.raw.buildInvocation("hi").args).toEqual(["-p", "hi"]);
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

test("breaking out of iteration stops watching while the run completes", async () => {
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
  const run = agent.run("go");
  for await (const ev of run) {
    if (ev.type === "text-delta") {
      break;
    }
  }
  // Breaking stops watching, never the agent: the run completes normally,
  // and the source is closed by that completion.
  const res = await run;
  expect(res.text).toBe("Hi");
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

test("aborting mid-iteration yields the events so far, then throws", async () => {
  // One event, then the process hangs, so the abort lands mid-stream.
  const stall: Adapter = {
    ...fakeStreaming,
    buildInvocation: () => ({
      args: ["-c", `printf '%s\\n' '{"t":"text","v":"Hi"}'; sleep 5`],
      command: "sh",
    }),
  };
  const run = new AgentImpl(stall).run("go");
  const types: string[] = [];
  let failure: unknown;
  try {
    for await (const ev of run) {
      types.push(ev.type);
      run.abort();
    }
  } catch (error) {
    failure = error;
  }
  expect(types).toEqual(["text-delta"]);
  expect(failure).toBeInstanceOf(AnyAgentError);
  expect(failure).toMatchObject({ code: "Aborted" });
});
