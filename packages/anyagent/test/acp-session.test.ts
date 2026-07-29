import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cline } from "../src/cline.js";
import { cursor } from "../src/cursor.js";
import { AnyAgentError } from "../src/errors.js";
import { geminiCli } from "../src/gemini-cli.js";
import { goose } from "../src/goose.js";
import type { AcpTransport } from "../src/internal/acp.js";
import type { AcpTransportFactory } from "../src/internal/acp-session.js";
import { AcpSessionImpl } from "../src/internal/acp-session.js";
import { AgentImpl } from "../src/internal/agent.js";
import { kiloCode } from "../src/kilo-code.js";
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
import { fakeStreaming, runnerFromFixture } from "./fake-adapter.js";

// An ACP-mode adapter: an ACP endpoint and nothing the core spawns.
const acpAdapter: Adapter = {
  acp: { command: ["fake-acp"] },
  capabilities: fakeStreaming.capabilities,
  detection: {},
  meta: { bin: ["fake-acp"], id: "fake-acp", name: "Fake ACP" },
  mode: "acp",
};

const acpAgent = (runner = runnerFromFixture("")): AgentImpl =>
  new AgentImpl(acpAdapter, { runner });

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
    acpAgent(),
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
  const [a, b] = await Promise.all([
    session.run("first"),
    session.run("second"),
  ]);
  expect(a.text).toBe("one");
  expect(b.text).toBe("two");
  await transport.done;
});

test("steer sends an additional prompt on the open connection mid-turn", async () => {
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
  await expect(session.run("bad")).rejects.toMatchObject({
    code: "Invocation",
    raw: { stopReason: "refusal" },
  });
  await transport.done;
});

// No transport factory: these drive the default one, spawning `command`.
const spawningSession = (command: string[]): AcpSessionImpl => {
  const adapter: Adapter = { ...acpAdapter, acp: { command } };
  return new AcpSessionImpl(
    new AgentImpl(adapter, { runner: runnerFromFixture("") })
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
  const run = session.run("hi");
  run.abort();
  await expect(run).rejects.toMatchObject({ code: "Aborted" });
  await transport.done;
});

test("an already-aborted signal settles the run without opening a transport", async () => {
  let opened = 0;
  const session = new AcpSessionImpl(acpAgent(), {}, () => {
    opened += 1;
    return {
      close: () => undefined,
      onDeath: () => undefined,
      onLine: () => undefined,
      send: () => undefined,
    };
  });
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => transport);
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
    acpAgent(),
    { cwd: "/repo", resume: "s-old" },
    () => transport
  );
  expect(session.id).toBe("s-old");
  const result = await session.run("continue");
  expect(result.text).toBe("resumed");
  expect(result.sessionId).toBe("s-old");
  await transport.done;
});

test("resume without loadSession fails the turn rather than reattaching", async () => {
  // The agent only completes the handshake; no session/load is ever sent.
  const transport = scriptedTransport((api) => handshake(api, {}));

  const session = new AcpSessionImpl(
    acpAgent(),
    { resume: "s-old" },
    () => transport
  );
  await expect(session.run("continue")).rejects.toMatchObject({
    code: "UnsupportedCapability",
  });
  await transport.done;
});

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
  // A throwing factory keeps a regression that validates too late a clean
  // failure: an inert transport would leave the turn waiting forever.
  const session = new AcpSessionImpl(acpAgent(), {}, () => {
    opened += 1;
    throw new Error("the transport was opened for a rejected turn");
  });

  // `attachments` is false on the fake adapter.
  await expect(
    session.run("hi", { attachments: ["a.png"] })
  ).rejects.toMatchObject({ code: "UnsupportedCapability" });
  expect(opened).toBe(0);
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => counted);
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

  const session = new AcpSessionImpl(acpAgent(), {}, () => counted);
  const failure = await session
    .run("give me json", { schema: okSchema, schemaRetries: 0 })
    .catch((error: unknown) => error as AnyAgentError);

  expect(failure).toMatchObject({ code: "Parse", raw: "still not JSON" });
  expect((failure as AnyAgentError).issues?.length).toBeGreaterThan(0);
  expect(prompts()).toBe(1);
  await scripted.done;
});

test('mode: "acp" routes session() to the live connection', () => {
  const session = acpAgent().session();
  expect(session.supports("steer")).toBe(true);
  expect(session.supports("respond")).toBe(false);
  expect(session.supports()).toBe(true);
  expect(() => session.respond("r1", "allow")).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});

test('mode: "stdout" routes session() to one process per turn', async () => {
  const withId = '{"t":"session","v":"s1"}\n{"t":"text","v":"ok"}\n{"t":"end"}';
  const agent = new AgentImpl(fakeStreaming, {
    runner: runnerFromFixture(withId),
  });
  const session = agent.session();
  expect(session.supports("steer")).toBe(false);
  expect(() => session.steer("go")).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
  const result = await session.run("hi");
  expect(result.text).toBe("ok");
  expect(session.id).toBe("s1");
});

test("attachments ride the prompt as resource links beside its text", async () => {
  let sent: unknown;
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));
    const prompt = await api.next();
    sent = (prompt.params as { prompt: unknown }).prompt;
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });
  const attaching: Adapter = {
    ...acpAdapter,
    capabilities: { ...acpAdapter.capabilities, attachments: "native" },
  };
  const session = acpSession(attaching, {}, () => transport);

  await session.run("look at this", { attachments: ["/tmp/a.png"] });

  expect(sent).toEqual([
    { text: "look at this", type: "text" },
    { name: "a.png", type: "resource_link", uri: "file:///tmp/a.png" },
  ]);
  await transport.done;
});

const oneTurn = (): ScriptedTransport =>
  scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));
    const prompt = await api.next();
    api.emit(
      update("s1", {
        content: { text: "pong", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

test("agent.run over ACP hands over the whole turn, then closes the connection", async () => {
  const scripted = oneTurn();
  const agent = new AgentImpl(acpAdapter, { transport: () => scripted });

  const run = agent.run("hi");
  const events: AgentEvent[] = [];
  await collect(events, run);

  expect((await run).text).toBe("pong");
  expect(events.map((e) => e.type)).toEqual(["session", "text-delta", "done"]);
  // The teardown races the consumer, so this resolving is what proves the
  // events above survived it.
  await scripted.closed;
  await scripted.done;
});

test("each agent.run over ACP opens its own connection", async () => {
  let opened = 0;
  const agent = new AgentImpl(acpAdapter, {
    transport: () => {
      opened += 1;
      return oneTurn();
    },
  });

  await agent.run("first");
  await agent.run("second");

  expect(opened).toBe(2);
});

test("agent.run({ resume }) over ACP loads the session, then prompts once", async () => {
  const scripted = scriptedTransport(async (api) => {
    await handshake(api, { loadSession: true });
    const load = await api.next();
    expect(load.params).toMatchObject({ sessionId: "s-old" });
    api.emit(response(load.id, {}));
    const prompt = await api.next();
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });
  const { seen, tapped } = sentMethods(scripted);
  const agent = new AgentImpl(acpAdapter, { transport: () => tapped });

  await agent.run("continue", { resume: "s-old" });

  expect(seen.filter((method) => method === "session/load")).toHaveLength(1);
  expect(seen.filter((method) => method === "session/prompt")).toHaveLength(1);
  expect(seen).not.toContain("session/new");
  await scripted.done;
});

// An ACP-mode session on one shipped adapter, its ACP endpoint replaced by a
// scripted transport so no process is launched.
const acpSession = (
  adapter: Adapter,
  opts: SessionOptions,
  factory: AcpTransportFactory
): AcpSessionImpl =>
  new AcpSessionImpl(
    new AgentImpl(adapter, { runner: runnerFromFixture("") }),
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

  const session = acpSession(
    cursor(),
    { effort: "high", model: "claude-opus-4-8" },
    () => transport
  );
  await Promise.all([session.run("hi"), transport.done]);
});

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

  const session = acpSession(
    goose(),
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

  const session = acpSession(
    opencode(),
    { model: "openai/gpt-5.4" },
    () => transport
  );
  await Promise.all([session.run("hi"), transport.done]);
});

test("a live cline session sets its model config option", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "1785_x_cli" }));

    const config = await api.next();
    expect(config.method).toBe("session/set_config_option");
    expect(config.params).toEqual({
      configId: "model",
      sessionId: "1785_x_cli",
      value: "gpt-5.4-mini",
    });
    api.emit(response(config.id, { configOptions: [] }));

    const prompt = await api.next();
    expect(prompt.method).toBe("session/prompt");
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = acpSession(
    cline(),
    { model: "gpt-5.4-mini" },
    () => transport
  );
  await Promise.all([session.run("hi"), transport.done]);
});

test("effort on a live cline session throws before anything opens", () => {
  let opened = 0;
  expect(
    () =>
      new AcpSessionImpl(
        new AgentImpl(cline(), { runner: runnerFromFixture("") }),
        { effort: "high" },
        () => {
          opened += 1;
          return inertTransport();
        }
      )
  ).toThrow(expect.objectContaining({ code: "UnsupportedCapability" }));
  expect(opened).toBe(0);
});

test("effort on a live opencode session throws before anything opens", () => {
  let opened = 0;
  expect(
    () =>
      new AcpSessionImpl(
        new AgentImpl(opencode(), { runner: runnerFromFixture("") }),
        { effort: "high" },
        () => {
          opened += 1;
          return inertTransport();
        }
      )
  ).toThrow(expect.objectContaining({ code: "UnsupportedCapability" }));
  expect(opened).toBe(0);
  expect(() =>
    new AgentImpl(opencode(), { runner: runnerFromFixture("") }).session({
      effort: "high",
    })
  ).toThrow(expect.objectContaining({ code: "UnsupportedCapability" }));
});

// Kilo is the family's exception: its live endpoint advertises an `effort`
// select, so the option reaches the session rather than throwing.
test("a live kilo session sets model then effort as config options", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "ses_1" }));

    const model = await api.next();
    expect(model.method).toBe("session/set_config_option");
    expect(model.params).toEqual({
      configId: "model",
      sessionId: "ses_1",
      value: "kilo/openai/gpt-5.4",
    });
    api.emit(response(model.id, { configOptions: [] }));

    const effort = await api.next();
    expect(effort.method).toBe("session/set_config_option");
    expect(effort.params).toEqual({
      configId: "effort",
      sessionId: "ses_1",
      value: "xhigh",
    });
    api.emit(response(effort.id, { configOptions: [] }));

    const prompt = await api.next();
    expect(prompt.method).toBe("session/prompt");
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = acpSession(
    kiloCode(),
    { effort: "xhigh", model: "kilo/openai/gpt-5.4" },
    () => transport
  );
  await Promise.all([session.run("hi"), transport.done]);
});

test("a live gemini session spawns with its model, --skip-trust, and extraArgs", async () => {
  let invocation: Invocation | undefined;
  const session = acpSession(
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
  const run = session.run("hi");
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

  const session = acpSession(cursor(), {}, () => transport);
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

  const session = acpSession(cursor(), {}, () => transport);
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

test("close ends the session, settles its turns, and kills the transport", async () => {
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

  const session = acpSession(acpAdapter, {}, () => transport);
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

  const session = acpSession(acpAdapter, {}, () => tapped);
  await session.run("hi");
  await session.close();

  expect(seen).not.toContain("session/close");
  await scripted.closed;
  await scripted.done;
});

test("closing an emulated session rejects the turns still queued", async () => {
  const fixture =
    '{"t":"session","v":"s1"}\n{"t":"text","v":"ok"}\n{"t":"end"}';
  const session = new AgentImpl(fakeStreaming, {
    runner: runnerFromFixture(fixture),
  }).session();
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

// An ACP-mode adapter that declares it can branch a conversation.
const forkAdapter: Adapter = {
  ...acpAdapter,
  capabilities: { ...acpAdapter.capabilities, sessionFork: "native" },
};

test("fork without an advertised session/fork fails the turn rather than branching", async () => {
  // The agent only completes the handshake; no session/fork is ever sent.
  const transport = scriptedTransport((api) => handshake(api, {}));
  const session = new AcpSessionImpl(
    new AgentImpl(forkAdapter, { runner: runnerFromFixture("") }),
    { cwd: "/repo", fork: true, model: "opus", resume: "s-old" },
    () => transport
  );

  await expect(session.run("branch")).rejects.toMatchObject({
    code: "UnsupportedCapability",
  });
  await transport.done;
});

test("fork branches over the wire when the agent advertises it, settings applied after", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, { sessionCapabilities: { fork: {} } });
    const fork = await api.next();
    expect(fork.method).toBe("session/fork");
    expect(fork.params).toMatchObject({ cwd: "/repo", sessionId: "s-old" });
    api.emit(
      response(fork.id, {
        configOptions: [
          {
            currentValue: "sonnet",
            id: "model",
            name: "Model",
            options: [{ name: "Opus", value: "opus" }],
            type: "select",
          },
        ],
        sessionId: "s-forked",
      })
    );

    const configured = await api.next();
    expect(configured.method).toBe("session/set_config_option");
    expect(configured.params).toMatchObject({
      configId: "model",
      sessionId: "s-forked",
      value: "opus",
    });
    api.emit(response(configured.id, {}));

    const prompt = await api.next();
    expect(prompt.method).toBe("session/prompt");
    expect(prompt.params).toMatchObject({ sessionId: "s-forked" });
    api.emit(
      update("s-forked", {
        content: { text: "branched", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const configuringAdapter: Adapter = {
    ...forkAdapter,
    acp: {
      command: ["fake-acp"],
      settings: ({ model }) => ({
        configOptions: model ? [{ configId: "model", value: model }] : [],
      }),
    },
  };
  const session = new AcpSessionImpl(
    new AgentImpl(configuringAdapter, { runner: runnerFromFixture("") }),
    { cwd: "/repo", fork: true, model: "opus", resume: "s-old" },
    () => transport
  );

  const result = await session.run("branch");

  expect(result.text).toBe("branched");
  expect(result.sessionId).toBe("s-forked");
  expect(session.id).toBe("s-forked");
  expect(session.supports("steer")).toBe(true);
  await transport.done;
});

test("fork without resume throws InvalidOptions at session creation", () => {
  const agent = new AgentImpl(forkAdapter, { runner: runnerFromFixture("") });
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

for (const id of ["cursor", "goose", "gemini-cli", "opencode", "cline"]) {
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
      acpAgent(),
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
    // Gemini reports tokens in `_meta.quota` instead of `usage`; the fallback
    // must surface them, not drop them.
    const quota = (
      fx.promptResult as {
        _meta?: { quota?: { token_count?: Record<string, number> } };
      }
    )._meta?.quota?.token_count;
    if (fx.promptResult.usage || quota) {
      expect(result.usage).toBeDefined();
    }
    if (quota && !fx.promptResult.usage) {
      expect(result.usage?.inputTokens).toBe(quota.input_tokens);
      expect(result.usage?.outputTokens).toBe(quota.output_tokens);
    }
    await transport.done;
  });
}

interface ForkFixtureEntry {
  body?: {
    id?: number;
    method?: string;
    params?: { cwd?: string; sessionId?: string };
    result?: Record<string, unknown>;
  };
  dir: "in" | "out";
}

interface ForkFixture {
  cwd: string;
  forkedId: string;
  forkResult: Record<string, unknown>;
  initResult: Record<string, unknown>;
  parentId: string;
}

const loadForkFixture = (): ForkFixture => {
  const path = `${import.meta.dir}/fixtures/acp/opencode-fork.jsonl`;
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ForkFixtureEntry);
  const sent = entries.find(
    (entry) => entry.dir === "out" && entry.body?.method === "session/fork"
  )?.body?.params;
  const answered = (id: number): Record<string, unknown> | undefined =>
    entries.find((entry) => entry.dir === "in" && entry.body?.id === id)?.body
      ?.result;
  const initResult = answered(1);
  const forkResult = answered(2);
  if (!(sent?.cwd && sent.sessionId && initResult && forkResult)) {
    throw new Error(
      "replay fixture opencode-fork is missing the fork exchange"
    );
  }
  return {
    cwd: sent.cwd,
    forkedId: String(forkResult.sessionId),
    forkResult,
    initResult,
    parentId: sent.sessionId,
  };
};

// The recorded transcript branches a session the connection never opened, and
// its `initialize` advertises `loadSession` too — so replaying it proves the
// fork path reaches for `session/fork` alone. The prompt turn is no part of
// this fixture (opencode.jsonl backs that), so it ends on a synthetic stop.
test("replays the recorded opencode session/fork handshake", async () => {
  const fx = loadForkFixture();
  const transport = scriptedTransport(async (api) => {
    const init = await api.next();
    expect(init.method).toBe("initialize");
    api.emit(response(init.id, fx.initResult));

    const fork = await api.next();
    expect(fork.method).toBe("session/fork");
    expect(fork.params).toMatchObject({
      cwd: fx.cwd,
      sessionId: fx.parentId,
    });
    api.emit(response(fork.id, fx.forkResult));

    const prompt = await api.next();
    expect(prompt.method).toBe("session/prompt");
    expect(prompt.params).toMatchObject({ sessionId: fx.forkedId });
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = new AcpSessionImpl(
    new AgentImpl(forkAdapter, { runner: runnerFromFixture("") }),
    { cwd: fx.cwd, fork: true, resume: fx.parentId },
    () => transport
  );
  const result = await session.run("branch");

  expect(session.id).toBe(fx.forkedId);
  expect(result.sessionId).toBe(fx.forkedId);
  expect(session.id).not.toBe(fx.parentId);
  await transport.done;
});

// kilo-handshake.jsonl is a handshake-only recording — kilo's advertised
// capabilities and the option set `session/new` answers with, which is all the
// fork path needs; the turn below ends on a synthetic stop. The full recorded
// turn is kilo.jsonl, which backs conformance.
interface HandshakeFixture {
  initResult: Record<string, unknown>;
  newResult: Record<string, unknown>;
}

const loadHandshakeFixture = (id: string): HandshakeFixture => {
  const path = `${import.meta.dir}/fixtures/acp/${id}.jsonl`;
  const answered = (wanted: number): Record<string, unknown> | undefined =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as FixtureEntry)
      .find((entry) => entry.dir === "in" && entry.body?.id === wanted)?.body
      ?.result;
  const initResult = answered(1);
  const newResult = answered(2);
  if (!(initResult && newResult)) {
    throw new Error(`handshake fixture ${id} is missing a keyed response`);
  }
  return { initResult, newResult };
};

test("kilo forks over the wire on its own recorded capabilities", async () => {
  const fx = loadHandshakeFixture("kilo-handshake");
  const forkedId = String(fx.newResult.sessionId);
  const transport = scriptedTransport(async (api) => {
    const init = await api.next();
    expect(init.method).toBe("initialize");
    api.emit(response(init.id, fx.initResult));

    const fork = await api.next();
    expect(fork.method).toBe("session/fork");
    expect(fork.params).toMatchObject({ cwd: "/repo", sessionId: "ses_old" });
    api.emit(response(fork.id, fx.newResult));

    // The family's settings mapping reaches the fork the same as a new session.
    const configured = await api.next();
    expect(configured.method).toBe("session/set_config_option");
    expect(configured.params).toEqual({
      configId: "model",
      sessionId: forkedId,
      value: "kilo/openai/gpt-5.4",
    });
    api.emit(response(configured.id, {}));

    const prompt = await api.next();
    expect(prompt.method).toBe("session/prompt");
    expect(prompt.params).toMatchObject({ sessionId: forkedId });
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = acpSession(
    kiloCode(),
    {
      cwd: "/repo",
      fork: true,
      model: "kilo/openai/gpt-5.4",
      resume: "ses_old",
    },
    () => transport
  );
  const result = await session.run("branch");

  expect(result.sessionId).toBe(forkedId);
  expect(session.id).toBe(forkedId);
  expect(session.supports("steer")).toBe(true);
  await transport.done;
});
