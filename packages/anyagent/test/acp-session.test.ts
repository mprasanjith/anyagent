import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AcpSessionImpl } from "../src/internal/acp-session.js";
import { AgentImpl } from "../src/internal/agent.js";
import type { Adapter, AgentEvent } from "../src/types.js";
import {
  request,
  response,
  type ScriptApi,
  scriptedTransport,
  update,
} from "./acp-transport.js";
import { fakeStreaming, runnerFromFixture } from "./fake-adapter.js";

// A native-tier adapter: an ACP endpoint plus `session: "native"`. Everything
// else mirrors the streaming fake so the emulated fallback has a real parser.
const nativeAdapter: Adapter = {
  ...fakeStreaming,
  acp: { command: ["fake-acp"] },
  capabilities: { ...fakeStreaming.capabilities, session: "native" },
};

const nativeAgent = (runner = runnerFromFixture("")): AgentImpl =>
  new AgentImpl(nativeAdapter, runner);

// Answers the `initialize` handshake from the agent side with the given
// capabilities; the client stores them.
const handshake = async (
  api: ScriptApi,
  agentCapabilities: Record<string, unknown>
): Promise<void> => {
  const init = await api.next();
  expect(init.method).toBe("initialize");
  api.emit(response(init.id, { agentCapabilities, protocolVersion: 1 }));
};

const collect = async (
  events: AgentEvent[],
  run: AsyncIterable<AgentEvent>
): Promise<void> => {
  for await (const event of run) {
    events.push(event);
  }
};

test("a native turn translates updates into events, text, and a sessionId", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    expect(created.method).toBe("session/new");
    expect(created.params).toMatchObject({ cwd: "/repo" });
    api.emit(response(created.id, { sessionId: "s1" }));

    const prompt = await api.next();
    expect(prompt.method).toBe("session/prompt");
    api.emit(
      update("s1", {
        content: { text: "Hello", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    api.emit(
      update("s1", {
        content: { text: "thinking", type: "text" },
        sessionUpdate: "agent_thought_chunk",
      })
    );
    api.emit(
      update("s1", {
        name: "Read",
        rawInput: { path: "a.txt" },
        sessionUpdate: "tool_call",
        status: "in_progress",
        title: "Reading",
        toolCallId: "t1",
      })
    );
    api.emit(
      update("s1", {
        rawOutput: "file body",
        sessionUpdate: "tool_call_update",
        status: "completed",
        toolCallId: "t1",
      })
    );
    // An update kind this build does not surface is ignored.
    api.emit(update("s1", { entries: [], sessionUpdate: "plan" }));
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const run = session.run("hi", { cwd: "/repo" });
  const events: AgentEvent[] = [];
  await collect(events, run);
  const result = await run;

  expect(result.text).toBe("Hello");
  expect(result.sessionId).toBe("s1");
  expect(session.id).toBe("s1");
  expect(events.map((e) => e.type)).toEqual([
    "text-delta",
    "reasoning-delta",
    "tool-call",
    "tool-result",
    "done",
  ]);
  const toolCall = events.find((e) => e.type === "tool-call");
  if (toolCall?.type === "tool-call") {
    expect(toolCall.name).toBe("read");
    expect(toolCall.nativeName).toBe("Read");
    expect(toolCall.callId).toBe("t1");
    expect(toolCall.input).toEqual({ path: "a.txt" });
  }
  const toolResult = events.find((e) => e.type === "tool-result");
  if (toolResult?.type === "tool-result") {
    expect(toolResult.output).toBe("file body");
  }
  await transport.done;
});

test("turns queue on one connection, threaded in order", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));

    const first = await api.next();
    expect(first.params).toMatchObject({
      prompt: [{ text: "first", type: "text" }],
    });
    api.emit(
      update("s1", {
        content: { text: "one", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    api.emit(response(first.id, { stopReason: "end_turn" }));

    const second = await api.next();
    expect(second.params).toMatchObject({
      prompt: [{ text: "second", type: "text" }],
    });
    api.emit(
      update("s1", {
        content: { text: "two", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    api.emit(response(second.id, { stopReason: "end_turn" }));
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const [a, b] = await Promise.all([
    session.run("first"),
    session.run("second"),
  ]);
  expect(a.text).toBe("one");
  expect(b.text).toBe("two");
  await transport.done;
});

test("steer sends an additional prompt on the live session mid-turn", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));

    const prompt = await api.next();
    expect(prompt.params).toMatchObject({
      prompt: [{ text: "go", type: "text" }],
    });
    api.emit(
      update("s1", {
        content: { text: "working", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    const steer = await api.next();
    expect(steer.method).toBe("session/prompt");
    expect(steer.params).toMatchObject({
      prompt: [{ text: "faster", type: "text" }],
      sessionId: "s1",
    });
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const run = session.run("go");
  for await (const event of run) {
    if (event.type === "text-delta" && event.text === "working") {
      session.steer("faster");
    }
  }
  await run;
  await transport.done;
});

test("a permission request is surfaced as an event then auto-allowed", async () => {
  const options = [
    { kind: "reject_once", name: "Reject", optionId: "no" },
    { kind: "allow_once", name: "Allow", optionId: "yes" },
  ];
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));

    const prompt = await api.next();
    api.emit(
      request(100, "session/request_permission", {
        options,
        sessionId: "s1",
        toolCall: {
          name: "write_file",
          rawInput: { path: "a" },
          status: "pending",
          title: "Write file",
          toolCallId: "t1",
        },
      })
    );
    const answer = await api.next();
    expect(answer.id).toBe(100);
    // The first allow-kind option is selected even though it is listed second.
    expect(answer.result).toEqual({
      outcome: { optionId: "yes", outcome: "selected" },
    });
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const run = session.run("edit");
  const events: AgentEvent[] = [];
  await collect(events, run);
  await run;

  const perm = events.find((e) => e.type === "permission-request");
  expect(perm?.type).toBe("permission-request");
  if (perm?.type === "permission-request") {
    // Options are surfaced verbatim, normalized to the shared vocabulary.
    expect(perm.options).toEqual([
      { id: "no", kind: "reject-once", label: "Reject" },
      { id: "yes", kind: "allow-once", label: "Allow" },
    ]);
    expect(perm.requestId).toBe("t1");
    expect(perm.nativeName).toBe("write_file");
  }
  await transport.done;
});

test("a cancelled turn aborts via session/cancel and throws Aborted", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));

    const prompt = await api.next();
    api.emit(
      update("s1", {
        content: { text: "starting", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    const cancel = await api.next();
    expect(cancel.method).toBe("session/cancel");
    expect(cancel.params).toEqual({ sessionId: "s1" });
    api.emit(response(prompt.id, { stopReason: "cancelled" }));
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const run = session.run("long task");
  // Abort once the turn is live; the iterator surfaces the same failure.
  try {
    for await (const event of run) {
      if (event.type === "text-delta") {
        run.abort();
      }
    }
  } catch (error) {
    expect(error).toMatchObject({ code: "Aborted" });
  }
  await expect(run).rejects.toMatchObject({ code: "Aborted" });
  await transport.done;
});

test("a refusal stop reason throws Invocation carrying the raw response", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));
    const prompt = await api.next();
    api.emit(response(prompt.id, { stopReason: "refusal" }));
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  await expect(session.run("bad")).rejects.toMatchObject({
    code: "Invocation",
    raw: { stopReason: "refusal" },
  });
  await transport.done;
});

test("resume reattaches with session/load when loadSession is advertised", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, { loadSession: true });
    const load = await api.next();
    expect(load.method).toBe("session/load");
    expect(load.params).toMatchObject({ cwd: "/repo", sessionId: "s-old" });
    api.emit(response(load.id, {}));

    const prompt = await api.next();
    api.emit(
      update("s-old", {
        content: { text: "resumed", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    { resume: "s-old" },
    () => transport
  );
  expect(session.id).toBe("s-old");
  const result = await session.run("continue", { cwd: "/repo" });
  expect(result.text).toBe("resumed");
  expect(result.sessionId).toBe("s-old");
  await transport.done;
});

test("resume without loadSession falls back to the emulated print-mode cursor", async () => {
  const fixture =
    '{"t":"session","v":"s2"}\n{"t":"text","v":"emulated ok"}\n{"t":"end"}';
  // The agent only completes the handshake; no session/load is ever sent.
  const transport = scriptedTransport((api) => handshake(api, {}));

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(fixture),
    { resume: "s-old" },
    () => transport
  );
  const result = await session.run("continue");
  expect(result.text).toBe("emulated ok");
  expect(result.sessionId).toBe("s2");
  await transport.done;
});

test("fork on a live session throws InvalidOptions at construction", () => {
  const agent = nativeAgent();
  expect(() => agent.session({ fork: true, resume: "s-old" })).toThrow(
    expect.objectContaining({ code: "InvalidOptions" })
  );
});

test("a native adapter with an acp endpoint routes session() to the live tier", () => {
  const session = nativeAgent().session();
  expect(session.supports("steer")).toBe(true);
  expect(session.supports("respond")).toBe(false);
  expect(session.supports()).toBe(true);
  expect(() => session.respond("r1", "allow")).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});

test("session capability short of native tier keeps the emulated behavior", async () => {
  const withId = '{"t":"session","v":"s1"}\n{"t":"text","v":"ok"}\n{"t":"end"}';
  const agent = new AgentImpl(fakeStreaming, runnerFromFixture(withId));
  const session = agent.session();
  expect(session.supports("steer")).toBe(false);
  expect(() => session.steer("go")).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
  const result = await session.run("hi");
  expect(result.text).toBe("ok");
  expect(session.id).toBe("s1");

  // A native declaration without an acp endpoint also stays emulated.
  const noEndpoint: Adapter = {
    ...fakeStreaming,
    capabilities: { ...fakeStreaming.capabilities, session: "native" },
  };
  const stillEmulated = new AgentImpl(
    noEndpoint,
    runnerFromFixture(withId)
  ).session();
  expect(stillEmulated.supports("steer")).toBe(false);
});

// Replay gate (sessions.md §6 M-2): each recorded real ACP transcript is fed
// back through the scripted-transport seam to prove `AcpSessionImpl` drives a
// live handshake to a completed turn with text. Only the agent's inbound lines
// are replayed — recorded ids are rewritten onto the client's own request ids,
// and the assertions check shape (a session id, some text, a terminal event),
// never the exact reply, since the recorder's framing is not ours byte-for-byte.

// One recorded transcript reduced to the pieces a replay needs: the three
// keyed responses and the session/update notifications between them.
interface FixtureBody {
  id?: number;
  method?: string;
  params?: { sessionId: string; update: unknown };
  result?: Record<string, unknown>;
}

interface FixtureEntry {
  body?: FixtureBody;
  dir: "in" | "out";
  text?: string;
}

interface ReplayFixture {
  initResult: Record<string, unknown>;
  newResult: Record<string, unknown>;
  promptResult: Record<string, unknown>;
  sessionId: string;
  updates: Array<{ sessionId: string; update: unknown }>;
}

const loadReplayFixture = (id: string): ReplayFixture => {
  const path = `${import.meta.dir}/fixtures/acp/${id}.jsonl`;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  let initResult: Record<string, unknown> | undefined;
  let newResult: Record<string, unknown> | undefined;
  let promptResult: Record<string, unknown> | undefined;
  const updates: Array<{ sessionId: string; update: unknown }> = [];
  for (const line of lines) {
    const { body, dir } = JSON.parse(line) as FixtureEntry;
    if (dir !== "in" || !body) {
      continue;
    }
    if (body.id === 1 && body.result) {
      initResult = body.result;
    } else if (body.id === 2 && body.result) {
      newResult = body.result;
    } else if (body.id === 3 && body.result) {
      promptResult = body.result;
    } else if (body.method === "session/update" && body.params) {
      updates.push(body.params);
    }
  }
  if (!(initResult && newResult && promptResult)) {
    throw new Error(`replay fixture ${id} is missing a keyed response`);
  }
  return {
    initResult,
    newResult,
    promptResult,
    sessionId: newResult.sessionId as string,
    updates,
  };
};

for (const id of ["cursor", "goose", "gemini-cli", "opencode"]) {
  test(`replays the recorded ${id} ACP transcript to a completed turn`, async () => {
    const fx = loadReplayFixture(id);
    const transport = scriptedTransport(async (api) => {
      const init = await api.next();
      expect(init.method).toBe("initialize");
      api.emit(response(init.id, fx.initResult));

      const created = await api.next();
      expect(created.method).toBe("session/new");
      api.emit(response(created.id, fx.newResult));

      const prompt = await api.next();
      expect(prompt.method).toBe("session/prompt");
      // The recorded stream, verbatim: notifications carry the fixture's own
      // session id, which the session/new result above handed the client.
      for (const params of fx.updates) {
        api.emit(update(params.sessionId, params.update));
      }
      api.emit(response(prompt.id, fx.promptResult));
    });

    const session = new AcpSessionImpl(
      nativeAgent(),
      runnerFromFixture(""),
      {},
      () => transport
    );
    const events: AgentEvent[] = [];
    const run = session.run("Reply with exactly the word: pong", {
      cwd: "/repo",
    });
    await collect(events, run);
    const result = await run;

    expect(result.sessionId).toBe(fx.sessionId);
    expect(session.id).toBe(fx.sessionId);
    expect(result.text.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    await transport.done;
  });
}
