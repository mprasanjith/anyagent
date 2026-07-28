import { expect, test } from "bun:test";
import type {
  PermissionOption,
  RequestPermissionRequest,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import { AnyAgentError } from "../src/errors.js";
import { type AcpClient, connect } from "../src/internal/acp.js";
import {
  request,
  response,
  type ScriptApi,
  scriptedTransport,
  update,
} from "./acp-transport.js";

// Drives the `initialize` handshake from the agent side, answering with the
// given agent capabilities. Returns nothing; the client stores them.
const handshake = async (
  api: ScriptApi,
  agentCapabilities: Record<string, unknown>
): Promise<void> => {
  const init = await api.next();
  expect(init.method).toBe("initialize");
  expect((init.params as { protocolVersion: number }).protocolVersion).toBe(1);
  api.emit(response(init.id, { agentCapabilities, protocolVersion: 1 }));
};

test("initialize negotiates the protocol version and exposes capabilities", async () => {
  const caps = { loadSession: true, promptCapabilities: { image: true } };
  const transport = scriptedTransport((api) => handshake(api, caps));
  const client = connect(transport);

  const result = await client.initialize();

  expect(result.protocolVersion).toBe(1);
  expect(result.agentCapabilities).toEqual(caps);
  expect(client.capabilities).toEqual(caps);
  await transport.done;
});

test("initialize closes and throws on a protocol version mismatch", async () => {
  const transport = scriptedTransport(async (api) => {
    const init = await api.next();
    // The agent only speaks a newer, incompatible version.
    api.emit(response(init.id, { protocolVersion: 2 }));
  });
  const client = connect(transport);

  await expect(client.initialize()).rejects.toMatchObject({
    code: "Invocation",
  });
  await transport.done;
});

test("newSession opens a session and a prompt turn streams updates to a stop", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    expect(created.method).toBe("session/new");
    api.emit(response(created.id, { sessionId: "s1" }));

    const prompt = await api.next();
    expect(prompt.method).toBe("session/prompt");
    expect(prompt.params).toEqual({
      prompt: [{ text: "hi", type: "text" }],
      sessionId: "s1",
    });
    api.emit(
      update("s1", {
        content: { text: "Hello", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    api.emit(
      update("s1", {
        sessionUpdate: "tool_call",
        status: "in_progress",
        title: "Reading file",
        toolCallId: "t1",
      })
    );
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const client = connect(transport);
  await client.initialize();
  const session = await client.newSession({ cwd: "/repo" });
  expect(session.sessionId).toBe("s1");

  const updates: SessionUpdate[] = [];
  const turn = session.prompt("hi", (u) => updates.push(u));
  const result = await turn.result;

  expect(result.stopReason).toBe("end_turn");
  expect(updates.map((u) => u.sessionUpdate)).toEqual([
    "agent_message_chunk",
    "tool_call",
  ]);
  const [first] = updates;
  if (first?.sessionUpdate === "agent_message_chunk") {
    expect(first.content).toEqual({ text: "Hello", type: "text" });
  }
  await transport.done;
});

test("a mid-turn permission request is answered via the handler with a selected optionId", async () => {
  const options: PermissionOption[] = [
    { kind: "allow_once", name: "Allow", optionId: "allow" },
    { kind: "reject_once", name: "Reject", optionId: "reject" },
  ];
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));

    const prompt = await api.next();
    api.emit(
      update("s1", {
        content: { text: "Working", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    // The agent calls back the client (reverse request) before continuing.
    api.emit(
      request(100, "session/request_permission", {
        options,
        sessionId: "s1",
        toolCall: { status: "pending", title: "Write file", toolCallId: "t1" },
      })
    );
    const answer = await api.next();
    expect(answer.id).toBe(100);
    expect(answer.result).toEqual({
      outcome: { optionId: "allow", outcome: "selected" },
    });
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const client = connect(transport);
  await client.initialize();
  const session = await client.newSession({ cwd: "/repo" });

  let seen: RequestPermissionRequest | undefined;
  client.onPermissionRequest((req) => {
    seen = req;
    return { optionId: "allow", outcome: "selected" };
  });

  const result = await session.prompt("edit").result;

  expect(result.stopReason).toBe("end_turn");
  // Options are surfaced verbatim: id, kind, and label each preserved.
  expect(seen?.options).toEqual(options);
});

test("cancel notifies the agent and the turn ends with the cancelled stop reason", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, {});
    const created = await api.next();
    api.emit(response(created.id, { sessionId: "s1" }));

    const prompt = await api.next();
    expect(prompt.method).toBe("session/prompt");
    const cancel = await api.next();
    expect(cancel.method).toBe("session/cancel");
    expect(cancel.params).toEqual({ sessionId: "s1" });
    api.emit(response(prompt.id, { stopReason: "cancelled" }));
  });

  const client = connect(transport);
  await client.initialize();
  const session = await client.newSession({ cwd: "/repo" });

  const turn = session.prompt("long task");
  await session.cancel();
  const result = await turn.result;

  expect(result.stopReason).toBe("cancelled");
  await transport.done;
});

test("loadSession reattaches when the capability is advertised", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, { loadSession: true });
    const load = await api.next();
    expect(load.method).toBe("session/load");
    expect(load.params).toEqual({
      cwd: "/repo",
      mcpServers: [],
      sessionId: "s-old",
    });
    api.emit(response(load.id, {}));
  });

  const client = connect(transport);
  await client.initialize();
  const session = await client.loadSession({
    cwd: "/repo",
    sessionId: "s-old",
  });

  expect(session.sessionId).toBe("s-old");
  await transport.done;
});

test("forkSession branches when the capability is advertised", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api, { sessionCapabilities: { fork: {} } });
    const fork = await api.next();
    expect(fork.method).toBe("session/fork");
    expect(fork.params).toEqual({
      cwd: "/repo",
      mcpServers: [],
      sessionId: "s-old",
    });
    api.emit(
      response(fork.id, {
        configOptions: [
          {
            currentValue: "build",
            id: "mode",
            name: "Session Mode",
            options: [{ name: "plan", value: "plan" }],
            type: "select",
          },
        ],
        sessionId: "s-forked",
      })
    );
  });

  const client = connect(transport);
  await client.initialize();
  const session = await client.forkSession({
    cwd: "/repo",
    sessionId: "s-old",
  });

  expect(session.sessionId).toBe("s-forked");
  expect(session.config.get("mode")).toBe("build");
  await transport.done;
});

test("forkSession throws UnsupportedCapability when the agent did not advertise it", async () => {
  const transport = scriptedTransport((api) => handshake(api, {}));
  const client: AcpClient = connect(transport);
  await client.initialize();

  await expect(
    client.forkSession({ cwd: "/repo", sessionId: "s-old" })
  ).rejects.toMatchObject({ code: "UnsupportedCapability" });
  await transport.done;
});

test("loadSession throws UnsupportedCapability when the agent did not advertise it", async () => {
  const transport = scriptedTransport((api) => handshake(api, {}));
  const client: AcpClient = connect(transport);
  await client.initialize();

  await expect(
    client.loadSession({ cwd: "/repo", sessionId: "s-old" })
  ).rejects.toBeInstanceOf(AnyAgentError);
  await expect(
    client.loadSession({ cwd: "/repo", sessionId: "s-old" })
  ).rejects.toMatchObject({ code: "UnsupportedCapability" });
  await transport.done;
});
