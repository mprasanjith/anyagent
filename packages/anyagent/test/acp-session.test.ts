import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cursor } from "../src/cursor.js";
import { AnyAgentError } from "../src/errors.js";
import { geminiCli } from "../src/gemini-cli.js";
import { goose } from "../src/goose.js";
import type { AcpTransport } from "../src/internal/acp.js";
import type { AcpTransportFactory } from "../src/internal/acp-session.js";
import { AcpSessionImpl } from "../src/internal/acp-session.js";
import { AgentImpl } from "../src/internal/agent.js";
import { opencode } from "../src/opencode.js";
import type {
  Adapter,
  AgentEvent,
  Invocation,
  SessionOptions,
} from "../src/types.js";
import {
  errorResponse,
  request,
  response,
  type ScriptApi,
  type ScriptedTransport,
  scriptedTransport,
  update,
} from "./acp-transport.js";
import {
  fakeStreaming,
  runnerFromFixture,
  sourceFromBody,
} from "./fake-adapter.js";

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
    { cwd: "/repo" },
    () => transport
  );
  const run = session.run("hi");
  const events: AgentEvent[] = [];
  await collect(events, run);
  const result = await run;

  expect(result.text).toBe("Hello");
  expect(result.sessionId).toBe("s1");
  expect(session.id).toBe("s1");
  expect(events.map((e) => e.type)).toEqual([
    "session",
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

// No transport factory: these drive the default one, spawning `command`.
const spawningSession = (command: string[]): AcpSessionImpl => {
  const adapter: Adapter = { ...nativeAdapter, acp: { command } };
  return new AcpSessionImpl(
    new AgentImpl(adapter, runnerFromFixture("")),
    runnerFromFixture("")
  );
};

test("a missing ACP binary fails the turn with Invocation and its argv", async () => {
  const session = spawningSession(["definitely-not-a-real-binary-xyz"]);
  await expect(session.run("hi")).rejects.toMatchObject({
    argv: ["definitely-not-a-real-binary-xyz"],
    code: "Invocation",
  });
});

test("stderr past the pipe buffer is drained and lands on the failure", async () => {
  const bytes = 100_000;
  const script = `yes 0123456789 | head -c ${bytes} 1>&2; exit 3`;
  const failure: AnyAgentError = await spawningSession(["sh", "-c", script])
    .run("hi")
    .then(
      () => {
        throw new Error("the turn resolved");
      },
      (error: unknown) => error as AnyAgentError
    );
  expect(failure).toMatchObject({
    argv: ["sh", "-c", script],
    code: "Invocation",
  });
  expect(failure.stderr?.length).toBeGreaterThanOrEqual(bytes);
});

test("a non-JSON stdout line rejects the turn with Parse", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));
    await api.next();
    api.line("Welcome to fake-acp 1.0");
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  await expect(session.run("hi")).rejects.toMatchObject({ code: "Parse" });
  await transport.done;
});

test("an agent dying mid-turn rejects the turn with the transport's diagnostics", async () => {
  let kill = (): void => undefined;
  const killed = new Promise<void>((resolve) => {
    kill = resolve;
  });
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));
    await api.next();
    api.emit(
      update("s1", {
        content: { text: "half", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    await killed;
    api.die(
      new AnyAgentError("Invocation", "fake-acp exited 1", {
        argv: ["fake-acp"],
        stderr: "boom",
      })
    );
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const run = session.run("hi");
  const events: AgentEvent[] = [];
  let thrown: unknown;
  try {
    for await (const event of run) {
      events.push(event);
      if (event.type === "text-delta") {
        kill();
      }
    }
  } catch (error) {
    thrown = error;
  }

  expect(events.map((e) => e.type)).toEqual(["session", "text-delta"]);
  const failure = await run.catch((error: unknown) => error);
  expect(thrown).toBe(failure);
  expect(failure).toMatchObject({
    argv: ["fake-acp"],
    code: "Invocation",
    stderr: "boom",
  });
  await transport.done;
});

test("aborting a queued turn leaves the in-flight turn untouched", async () => {
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
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const first = session.run("first");
  const second = session.run("second");
  second.abort();

  await expect(second).rejects.toMatchObject({ code: "Aborted" });
  expect((await first).text).toBe("one");
  await transport.done;
});

test("aborting before the connection opens still settles the run Aborted", async () => {
  const transport = scriptedTransport(async (api) => {
    // The handshake is never answered, so the turn is still connecting.
    await api.next();
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const run = session.run("hi");
  run.abort();
  await expect(run).rejects.toMatchObject({ code: "Aborted" });
  await transport.done;
});

test("an already-aborted signal settles the run without opening a transport", async () => {
  let opened = 0;
  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => {
      opened += 1;
      return {
        close: () => undefined,
        onDeath: () => undefined,
        onLine: () => undefined,
        send: () => undefined,
      };
    }
  );
  const controller = new AbortController();
  controller.abort();

  await expect(
    session.run("hi", { signal: controller.signal })
  ).rejects.toMatchObject({ code: "Aborted" });
  expect(opened).toBe(0);
});

test("opts.signal firing mid-turn cancels the live turn", async () => {
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
    api.emit(response(prompt.id, { stopReason: "cancelled" }));
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const controller = new AbortController();
  const run = session.run("long task", { signal: controller.signal });
  try {
    for await (const event of run) {
      if (event.type === "text-delta") {
        controller.abort();
      }
    }
  } catch (error) {
    expect(error).toMatchObject({ code: "Aborted" });
  }
  await expect(run).rejects.toMatchObject({ code: "Aborted" });
  await transport.done;
});

test("a failed turn rejects the turns queued behind it", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));
    const first = await api.next();
    api.emit(response(first.id, { stopReason: "refusal" }));
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const first = session.run("first");
  const second = session.run("second");

  const failure = await first.catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: "Invocation",
    raw: { stopReason: "refusal" },
  });
  expect(await second.catch((error: unknown) => error)).toBe(failure);
  await transport.done;
});

test("a failed steer leaves the turn in exactly one terminal state", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));
    const prompt = await api.next();
    api.emit(
      update("s1", {
        content: { text: "working", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    const steer = await api.next();
    expect(steer.method).toBe("session/prompt");
    api.emit(errorResponse(steer.id, "this agent refuses mid-turn prompts"));
    const cancel = await api.next();
    expect(cancel.method).toBe("session/cancel");
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const run = session.run("go");
  const events: AgentEvent[] = [];
  let thrown: unknown;
  try {
    for await (const event of run) {
      events.push(event);
      if (event.type === "text-delta") {
        session.steer("faster");
      }
    }
  } catch (error) {
    thrown = error;
  }

  const failure = await run.catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "Invocation" });
  expect(thrown).toBe(failure);
  expect(events.some((e) => e.type === "done")).toBe(false);
  await transport.done;
});

test("session lands once, first, and session_info_update does not repeat it", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));
    const prompt = await api.next();
    api.emit(
      update("s1", { sessionUpdate: "session_info_update", title: "Pong" })
    );
    api.emit(
      update("s1", {
        content: { text: "pong", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const run = session.run("hi");
  const events: AgentEvent[] = [];
  await collect(events, run);
  await run;

  expect(events[0]).toMatchObject({ sessionId: "s1", type: "session" });
  expect(events.filter((e) => e.type === "session")).toHaveLength(1);
  await transport.done;
});

test("usage reaches the events and the result", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));
    const prompt = await api.next();
    api.emit(
      update("s1", {
        cost: { amount: 0.25, currency: "USD" },
        sessionUpdate: "usage_update",
        size: 200_000,
        used: 8641,
      })
    );
    api.emit(
      update("s1", {
        content: { text: "ok", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    api.emit(
      response(prompt.id, {
        stopReason: "end_turn",
        usage: {
          cachedReadTokens: 1792,
          inputTokens: 6849,
          outputTokens: 4,
          thoughtTokens: 13,
          totalTokens: 8658,
        },
      })
    );
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const run = session.run("hi");
  const events: AgentEvent[] = [];
  await collect(events, run);
  const result = await run;

  const usages = events.filter((e) => e.type === "usage");
  expect(usages).toHaveLength(2);
  expect(usages[0]).toMatchObject({
    raw: { used: 8641 },
    usage: { costUsd: 0.25 },
  });
  expect(result.usage).toMatchObject({
    cacheReadTokens: 1792,
    inputTokens: 6849,
    outputTokens: 4,
    reasoningTokens: 13,
  });
  expect(result.usage?.cacheWriteTokens).toBeUndefined();
  expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  expect(events.at(-1)?.type).toBe("done");
  await transport.done;
});

test("a failed tool call reports a tool-result named from its call", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));
    const prompt = await api.next();
    api.emit(
      update("s1", {
        name: "Read",
        rawInput: { path: "gone.txt" },
        sessionUpdate: "tool_call",
        status: "in_progress",
        title: "Reading",
        toolCallId: "t1",
      })
    );
    api.emit(
      update("s1", {
        content: [
          { content: { text: "ENOENT", type: "text" }, type: "content" },
        ],
        sessionUpdate: "tool_call_update",
        status: "failed",
        toolCallId: "t1",
      })
    );
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => transport
  );
  const run = session.run("read it");
  const events: AgentEvent[] = [];
  await collect(events, run);
  await run;

  const toolResult = events.find((e) => e.type === "tool-result");
  expect(toolResult).toMatchObject({
    callId: "t1",
    name: "read",
    nativeName: "Read",
    raw: { status: "failed" },
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
    { cwd: "/repo", resume: "s-old" },
    () => transport
  );
  expect(session.id).toBe("s-old");
  const result = await session.run("continue");
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

// The JSON Schema the schema-turn tests validate against, and a transport
// wrapper that counts how many `session/prompt` requests actually went out.
const okSchema = {
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  type: "object",
};

const countingPrompts = (
  transport: ScriptedTransport
): { counted: ScriptedTransport; prompts: () => number } => {
  let prompts = 0;
  return {
    counted: {
      ...transport,
      send: (line: string) => {
        if (
          (JSON.parse(line) as { method?: string }).method === "session/prompt"
        ) {
          prompts += 1;
        }
        transport.send(line);
      },
    },
    prompts: () => prompts,
  };
};

test("an unsupported option rejects before the transport is ever opened", async () => {
  let opened = 0;
  const sent: string[] = [];
  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => {
      opened += 1;
      return {
        close: () => undefined,
        onDeath: () => undefined,
        onLine: () => undefined,
        send: (line) => {
          sent.push(line);
        },
      };
    }
  );

  // `attachments` is false on the fake adapter.
  await expect(
    session.run("hi", { attachments: ["a.png"] })
  ).rejects.toMatchObject({ code: "UnsupportedCapability" });
  expect(opened).toBe(0);
  expect(sent).toEqual([]);
});

test("a schema turn re-asks once, emits schema-retry, and resolves with json", async () => {
  const scripted = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));

    const first = await api.next();
    expect(first.method).toBe("session/prompt");
    api.emit(
      update("s1", {
        content: { text: "sorry, no JSON here", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    api.emit(response(first.id, { stopReason: "end_turn" }));

    const second = await api.next();
    expect(second.method).toBe("session/prompt");
    api.emit(
      update("s1", {
        content: { text: '{"ok":true}', type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    api.emit(response(second.id, { stopReason: "end_turn" }));
  });
  const { counted, prompts } = countingPrompts(scripted);

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => counted
  );
  const run = session.run("give me json", { schema: okSchema });
  const events: AgentEvent[] = [];
  await collect(events, run);
  const result = await run;

  const retries = events.filter((e) => e.type === "schema-retry");
  expect(retries).toHaveLength(1);
  expect(
    retries[0]?.type === "schema-retry" && retries[0].issues.length
  ).toBeGreaterThan(0);
  expect(result.json).toEqual({ ok: true });
  expect(result.text).toBe('{"ok":true}');
  expect(events.filter((e) => e.type === "done").length).toBe(1);
  expect(events.at(-1)?.type).toBe("done");
  expect(prompts()).toBe(2);
  await scripted.done;
});

test("schemaRetries 0 rejects Parse on the first bad reply without re-asking", async () => {
  const scripted = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));

    const only = await api.next();
    expect(only.method).toBe("session/prompt");
    api.emit(
      update("s1", {
        content: { text: "still not JSON", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    api.emit(response(only.id, { stopReason: "end_turn" }));
  });
  const { counted, prompts } = countingPrompts(scripted);

  const session = new AcpSessionImpl(
    nativeAgent(),
    runnerFromFixture(""),
    {},
    () => counted
  );
  const failure = await session
    .run("give me json", { schema: okSchema, schemaRetries: 0 })
    .catch((error: unknown) => error as AnyAgentError);

  expect(failure).toMatchObject({ code: "Parse", raw: "still not JSON" });
  expect((failure as AnyAgentError).issues?.length).toBeGreaterThan(0);
  expect(prompts()).toBe(1);
  await scripted.done;
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

// A live session on one shipped adapter, its ACP endpoint replaced by a
// scripted transport so no process is launched.
const liveSession = (
  adapter: Adapter,
  opts: SessionOptions,
  factory: AcpTransportFactory
): AcpSessionImpl =>
  new AcpSessionImpl(
    new AgentImpl(adapter, runnerFromFixture("")),
    runnerFromFixture(""),
    opts,
    factory
  );

// A transport that answers nothing, for the paths that must not reach the wire.
const inertTransport = (): AcpTransport => ({
  close: () => undefined,
  onDeath: () => undefined,
  onLine: () => undefined,
  send: () => undefined,
});

const sentMethods = (
  transport: ScriptedTransport
): { seen: string[]; tapped: ScriptedTransport } => {
  const seen: string[] = [];
  return {
    seen,
    tapped: {
      ...transport,
      send: (line: string) => {
        const { method } = JSON.parse(line) as { method?: string };
        if (method !== undefined) {
          seen.push(method);
        }
        transport.send(line);
      },
    },
  };
};

test("a live cursor session sets model and effort as one config option", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));

    const config = await api.next();
    expect(config.method).toBe("session/set_config_option");
    expect(config.params).toEqual({
      configId: "model",
      sessionId: "s1",
      value: "claude-opus-4-8[effort=high]",
    });
    api.emit(response(config.id, { configOptions: [] }));

    const prompt = await api.next();
    expect(prompt.method).toBe("session/prompt");
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = liveSession(
    cursor(),
    { effort: "high", model: "claude-opus-4-8" },
    () => transport
  );
  await Promise.all([session.run("hi"), transport.done]);
});

// goose declares `effort: false`, so its live `thinking_effort` channel is only
// reachable on a shape that allows the option through.
const gooseWithEffort = (): Adapter => {
  const adapter = goose();
  return {
    ...adapter,
    capabilities: { ...adapter.capabilities, effort: "native" },
  };
};

test("a live goose session sets model and thinking_effort in order", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));

    const model = await api.next();
    expect(model.method).toBe("session/set_config_option");
    expect(model.params).toEqual({
      configId: "model",
      sessionId: "s1",
      value: "anthropic/claude-sonnet-4.5",
    });
    api.emit(response(model.id, { configOptions: [] }));

    const effort = await api.next();
    expect(effort.method).toBe("session/set_config_option");
    expect(effort.params).toEqual({
      configId: "thinking_effort",
      sessionId: "s1",
      value: "high",
    });
    api.emit(response(effort.id, { configOptions: [] }));

    const prompt = await api.next();
    expect(prompt.method).toBe("session/prompt");
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = liveSession(
    gooseWithEffort(),
    { effort: "high", model: "anthropic/claude-sonnet-4.5" },
    () => transport
  );
  await Promise.all([session.run("hi"), transport.done]);
});

test("a live opencode session sets its model config option", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));

    const config = await api.next();
    expect(config.params).toEqual({
      configId: "model",
      sessionId: "s1",
      value: "openai/gpt-5.4",
    });
    api.emit(response(config.id, { configOptions: [] }));

    const prompt = await api.next();
    expect(prompt.method).toBe("session/prompt");
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = liveSession(
    opencode(),
    { model: "openai/gpt-5.4" },
    () => transport
  );
  await Promise.all([session.run("hi"), transport.done]);
});

test("effort on a live opencode session throws before anything opens", () => {
  let opened = 0;
  expect(
    () =>
      new AcpSessionImpl(
        new AgentImpl(opencode(), runnerFromFixture("")),
        runnerFromFixture(""),
        { effort: "high" },
        () => {
          opened += 1;
          return inertTransport();
        }
      )
  ).toThrow(expect.objectContaining({ code: "UnsupportedCapability" }));
  expect(opened).toBe(0);
  expect(() =>
    new AgentImpl(opencode(), runnerFromFixture("")).session({ effort: "high" })
  ).toThrow(expect.objectContaining({ code: "UnsupportedCapability" }));
});

test("a live gemini session spawns with its model, --skip-trust, and extraArgs", async () => {
  let invocation: Invocation | undefined;
  const session = liveSession(
    geminiCli(),
    {
      cwd: "/work",
      env: { TOKEN: "x" },
      extraArgs: ["--foo"],
      model: "gemini-3-flash",
    },
    (inv) => {
      invocation = inv;
      return inertTransport();
    }
  );
  // A cwd on the turn changes nothing: the thread's settings own it.
  const run = session.run("hi", { cwd: "/turn" });
  run.abort();

  await expect(run).rejects.toMatchObject({ code: "Aborted" });
  expect(invocation).toEqual({
    args: ["--acp", "--skip-trust", "-m", "gemini-3-flash", "--foo"],
    command: "gemini",
    cwd: "/work",
    env: { TOKEN: "x" },
  });
});

test("a readOnly turn switches the mode and a later turn restores it", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(
      response(created.id, {
        configOptions: [
          {
            currentValue: "agent",
            id: "mode",
            name: "Mode",
            options: [
              { name: "Agent", value: "agent" },
              { name: "Plan", value: "plan" },
            ],
            type: "select",
          },
        ],
        sessionId: "s1",
      })
    );

    const toPlan = await api.next();
    expect(toPlan.method).toBe("session/set_config_option");
    expect(toPlan.params).toEqual({
      configId: "mode",
      sessionId: "s1",
      value: "plan",
    });
    api.emit(response(toPlan.id, { configOptions: [] }));

    const first = await api.next();
    expect(first.method).toBe("session/prompt");
    api.emit(response(first.id, { stopReason: "end_turn" }));

    const restored = await api.next();
    expect(restored.method).toBe("session/set_config_option");
    expect(restored.params).toEqual({
      configId: "mode",
      sessionId: "s1",
      value: "agent",
    });
    api.emit(response(restored.id, { configOptions: [] }));

    const second = await api.next();
    expect(second.method).toBe("session/prompt");
    api.emit(response(second.id, { stopReason: "end_turn" }));
  });

  const session = liveSession(cursor(), {}, () => transport);
  await session.run("look", { readOnly: true });
  await session.run("look again");
  await transport.done;
});

test("a readOnly turn denies every tool kind that could change the machine", async () => {
  const options = [
    { kind: "reject_once", name: "Reject", optionId: "no" },
    { kind: "allow_once", name: "Allow", optionId: "yes" },
  ];
  const ask = (id: number, kind?: string) =>
    request(id, "session/request_permission", {
      options,
      sessionId: "s1",
      toolCall: {
        ...(kind === undefined ? {} : { kind }),
        rawInput: {},
        status: "pending",
        title: "Do a thing",
        toolCallId: `t${id}`,
      },
    });
  const answers: Record<number, unknown> = {};
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));
    const prompt = await api.next();

    for (const [id, kind] of [
      [1, "read"],
      [2, "execute"],
      [3, undefined],
    ] as const) {
      api.emit(ask(id, kind));
      // biome-ignore lint/performance/noAwaitInLoops: one answer per request, in order.
      const answer = await api.next();
      answers[id] = answer.result;
    }
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = liveSession(cursor(), {}, () => transport);
  await session.run("inspect", { readOnly: true });
  await transport.done;

  expect(answers[1]).toEqual({
    outcome: { optionId: "yes", outcome: "selected" },
  });
  expect(answers[2]).toEqual({
    outcome: { optionId: "no", outcome: "selected" },
  });
  expect(answers[3]).toEqual({
    outcome: { optionId: "no", outcome: "selected" },
  });
});

test("close ends the live session, settles its turns, and kills the transport", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, { sessionCapabilities: { close: {} } });
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));
    const prompt = await api.next();
    expect(prompt.method).toBe("session/prompt");
    api.emit(response(prompt.id, { stopReason: "end_turn" }));

    const closed = await api.next();
    expect(closed.method).toBe("session/close");
    expect(closed.params).toEqual({ sessionId: "s1" });
    api.emit(response(closed.id, {}));
  });

  const session = liveSession(nativeAdapter, {}, () => transport);
  await session.run("first");
  const queued = session.run("second");
  await session.close();

  await expect(queued).rejects.toMatchObject({ code: "Aborted" });
  await session.close();
  expect(() => session.run("third")).toThrow(
    expect.objectContaining({ code: "InvalidOptions" })
  );
  await transport.closed;
  await transport.done;
});

test("close skips session/close where the agent never advertised it", async () => {
  const scripted = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));
    const prompt = await api.next();
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });
  const { seen, tapped } = sentMethods(scripted);

  const session = liveSession(nativeAdapter, {}, () => tapped);
  await session.run("hi");
  await session.close();

  expect(seen).not.toContain("session/close");
  await scripted.closed;
  await scripted.done;
});

test("closing an emulated session rejects the turns still queued", async () => {
  const fixture =
    '{"t":"session","v":"s1"}\n{"t":"text","v":"ok"}\n{"t":"end"}';
  const session = new AgentImpl(
    fakeStreaming,
    runnerFromFixture(fixture)
  ).session();
  const first = session.run("first");
  const queued = session.run("second");
  await session.close();

  expect((await first).text).toBe("ok");
  await expect(queued).rejects.toMatchObject({ code: "Aborted" });
  await session.close();
  expect(() => session.run("third")).toThrow(
    expect.objectContaining({ code: "InvalidOptions" })
  );
});

// A live-tier adapter whose print mode can fork, and whose invocation reports
// the options the delegate threaded through.
const forkAdapter: Adapter = {
  ...nativeAdapter,
  buildInvocation: (prompt, opts) => ({
    args: [
      "-p",
      prompt,
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.forkSession ? ["--fork"] : []),
      ...(opts.resume ? ["--resume", opts.resume] : []),
    ],
    command: "fake-acp",
    cwd: opts.cwd,
  }),
  capabilities: { ...nativeAdapter.capabilities, sessionFork: "native" },
};

test("fork on a live session runs through the print-mode delegate, settings intact", async () => {
  const fixture =
    '{"t":"session","v":"s2"}\n{"t":"text","v":"forked"}\n{"t":"end"}';
  const seen: Invocation[] = [];
  let opened = 0;
  const session = new AcpSessionImpl(
    new AgentImpl(forkAdapter, runnerFromFixture(fixture)),
    (invocation: Invocation) => {
      seen.push(invocation);
      return sourceFromBody(fixture);
    },
    { cwd: "/repo", fork: true, model: "opus", resume: "s-old" },
    () => {
      opened += 1;
      return inertTransport();
    }
  );

  expect(session.supports("steer")).toBe(false);
  const result = await session.run("branch");

  expect(result.text).toBe("forked");
  expect(session.id).toBe("s2");
  expect(opened).toBe(0);
  expect(seen[0]).toMatchObject({
    args: ["-p", "branch", "--model", "opus", "--fork", "--resume", "s-old"],
    cwd: "/repo",
  });
});

test("fork without resume throws InvalidOptions at session creation", () => {
  const agent = new AgentImpl(forkAdapter, runnerFromFixture(""));
  expect(() => agent.session({ fork: true })).toThrow(
    expect.objectContaining({ code: "InvalidOptions" })
  );
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
      { cwd: "/repo" },
      () => transport
    );
    const events: AgentEvent[] = [];
    const run = session.run("Reply with exactly the word: pong");
    await collect(events, run);
    const result = await run;

    expect(result.sessionId).toBe(fx.sessionId);
    expect(session.id).toBe(fx.sessionId);
    expect(result.text.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({
      sessionId: fx.sessionId,
      type: "session",
    });
    expect(events.filter((e) => e.type === "session")).toHaveLength(1);
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    if (fx.promptResult.usage) {
      expect(result.usage).toBeDefined();
    }
    await transport.done;
  });
}
