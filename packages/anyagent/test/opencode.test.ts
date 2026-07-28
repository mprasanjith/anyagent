import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { AgentImpl } from "../src/internal/agent.js";
import { opencode } from "../src/opencode.js";
import type { RunOptions, SessionOptions } from "../src/types.js";
import {
  response,
  type ScriptMessage,
  scriptedTransport,
  update,
} from "./acp-transport.js";
import { fakeSystemProbe } from "./fake-adapter.js";

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dir, "fixtures/opencode", name), "utf-8");

const SESSION_ID = "ses_1";
const NO_EFFORT = /reasoning effort/u;
const NEEDS_ENDPOINT = /needs a command or a url/u;
// The `mode` option as the recorded endpoint advertises it: readOnly puts
// `plan` in place of the current value and a later turn puts that value back.
const NEW_SESSION = {
  configOptions: [
    {
      currentValue: "build",
      id: "mode",
      options: [{ value: "build" }, { value: "plan" }],
      type: "select",
    },
  ],
  sessionId: SESSION_ID,
};

interface Wire {
  configured: unknown[];
  newSession: ScriptMessage;
  prompt: ScriptMessage;
}

// One turn against a scripted endpoint, returning what reached the wire.
const turnOverAcp = async (
  settings: SessionOptions = {},
  opts: RunOptions = {}
): Promise<Wire> => {
  const wire: Wire = { configured: [], newSession: {}, prompt: {} };
  const transport = scriptedTransport(async (api) => {
    const init = await api.next();
    expect(init.method).toBe("initialize");
    api.emit(response(init.id, { agentCapabilities: {}, protocolVersion: 1 }));

    wire.newSession = await api.next();
    api.emit(response(wire.newSession.id, NEW_SESSION));

    let message = await api.next();
    while (message.method === "session/set_config_option") {
      wire.configured.push(message.params);
      api.emit(response(message.id, {}));
      // biome-ignore lint/performance/noAwaitInLoops: each option is acknowledged before the next.
      message = await api.next();
    }
    wire.prompt = message;
    api.emit(
      update(SESSION_ID, {
        content: { text: "pong", type: "text" },
        sessionUpdate: "agent_message_chunk",
      })
    );
    api.emit(response(message.id, { stopReason: "end_turn" }));
  });
  const agent = new AgentImpl(opencode(), { transport: () => transport });
  const session = agent.session(settings);
  await session.run("hi", opts);
  await session.close();
  await transport.done;
  return wire;
};

test("declares the acp endpoint and the family's capabilities", () => {
  const agent = opencode();
  expect(agent.mode).toBe("acp");
  expect(agent.acp.command).toEqual(["opencode", "acp"]);
  expect(agent.acp.readOnly).toEqual({ configId: "mode", value: "plan" });
  expect(agent.capabilities.attachments).toBe("native");
  expect(agent.capabilities.mcp).toBe("native");
  expect(agent.capabilities.sessionFork).toBe("native");
  expect(agent.capabilities.structuredOutput).toBe("emulated");
  expect(agent.capabilities.systemPrompt).toBe("emulated");
});

test("effort has no channel here: the capability is off and the spec refuses it", () => {
  expect(opencode().capabilities.effort).toBe(false);
  expect(() => opencode().acp.settings?.({ effort: "high" })).toThrow(
    NO_EFFORT
  );
});

test("a session sets the model as the endpoint's model option", async () => {
  const wire = await turnOverAcp({
    model: "openrouter/openai/gpt-4o-mini",
  });
  expect(wire.configured).toEqual([
    {
      configId: "model",
      sessionId: SESSION_ID,
      value: "openrouter/openai/gpt-4o-mini",
    },
  ]);
});

test("readOnly puts the session in plan mode before the turn", async () => {
  const wire = await turnOverAcp({}, { readOnly: true });
  expect(wire.configured).toEqual([
    { configId: "mode", sessionId: SESSION_ID, value: "plan" },
  ]);
});

const mcpServers = (wire: Wire): unknown[] =>
  (wire.newSession.params as { mcpServers: unknown[] }).mcpServers;

test("a stdio mcp server rides session/new under the caller's own name", async () => {
  const wire = await turnOverAcp({
    mcp: { mydb: { args: ["-y", "srv"], command: "npx", env: { K: "v" } } },
  });
  expect(mcpServers(wire)).toEqual([
    {
      args: ["-y", "srv"],
      command: "npx",
      env: [{ name: "K", value: "v" }],
      name: "mydb",
    },
  ]);
});

test("a url mcp server rides session/new as an http server", async () => {
  const wire = await turnOverAcp({
    mcp: { docs: { url: "https://example.test/mcp" } },
  });
  expect(mcpServers(wire)).toEqual([
    {
      headers: [],
      name: "docs",
      type: "http",
      url: "https://example.test/mcp",
    },
  ]);
});

// The failure that keeps goose off this capability: there, both would land
// under the shared command token and one would vanish.
test("two servers sharing a command stay distinct — the key is the name", async () => {
  const wire = await turnOverAcp({
    mcp: {
      one: { args: ["-y", "a"], command: "npx" },
      two: { args: ["-y", "b"], command: "npx" },
    },
  });
  const names = mcpServers(wire).map(
    (server) => (server as { name: string }).name
  );
  expect(names).toEqual(["one", "two"]);
});

test("an mcp server with neither command nor url fails before anything spawns", () => {
  const agent = new AgentImpl(opencode(), {
    transport: () => {
      throw new Error("nothing may spawn");
    },
  });
  expect(() => agent.session({ mcp: { broken: {} } })).toThrow(NEEDS_ENDPOINT);
});

test("attachments ride the prompt as resource links beside its text", async () => {
  const wire = await turnOverAcp(
    {},
    { attachments: ["/a/one.png", "/b/two.pdf"] }
  );
  expect((wire.prompt.params as { prompt: unknown }).prompt).toEqual([
    { text: "hi", type: "text" },
    { name: "one.png", type: "resource_link", uri: "file:///a/one.png" },
    { name: "two.pdf", type: "resource_link", uri: "file:///b/two.pdf" },
  ]);
});

test("authStatus reads the opencode auth store and reports its providers", async () => {
  const probe = fakeSystemProbe({
    readFile: (p) =>
      Promise.resolve(
        p === "/home/fake/.local/share/opencode/auth.json"
          ? '{"anthropic":{"type":"oauth"},"openrouter":{"type":"api","key":"sk-or-x"}}'
          : undefined
      ),
  });
  const status = await opencode().authStatus?.(probe);
  // Exact shape: the store holds live keys, so nothing extra may come back.
  expect(status).toEqual({
    providers: ["anthropic", "openrouter"],
    state: "authenticated",
  });
});

test("authStatus counts a standard provider env key as a credential", async () => {
  const probe = fakeSystemProbe({ env: { OPENROUTER_API_KEY: "sk-or-x" } });
  const status = await opencode().authStatus?.(probe);
  expect(status?.state).toBe("authenticated");
  expect(status?.providers).toEqual(["openrouter"]);
});

test("authStatus with no store and no env keys is unauthenticated", async () => {
  const status = await opencode().authStatus?.(fakeSystemProbe());
  expect(status?.state).toBe("unauthenticated");
});

test("listModels parses the recorded `opencode models` snapshot", async () => {
  const calls: [string, string[]][] = [];
  const probe = fakeSystemProbe({
    exec: (bin, args) => {
      calls.push([bin, args]);
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: fixture("models.txt"),
      });
    },
  });
  const models = await opencode().listModels?.(probe);
  expect(calls).toEqual([["opencode", ["models"]]]);
  expect(models?.length).toBe(6);
  expect(models?.[0]).toEqual({
    id: "opencode/big-pickle",
    provider: "opencode",
  });
});

test("listModels takes the provider from the prefix before the first slash", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: "openrouter/openai/gpt-4o-mini\n",
      }),
  });
  const models = await opencode().listModels?.(probe);
  expect(models).toEqual([
    { id: "openrouter/openai/gpt-4o-mini", provider: "openrouter" },
  ]);
});

test("listModels fails loud when the CLI exits nonzero", async () => {
  const probe = fakeSystemProbe({
    exec: () => Promise.resolve({ code: 1, stderr: "boom", stdout: "" }),
  });
  await expect(opencode().listModels?.(probe)).rejects.toMatchObject({
    code: "Invocation",
  });
});
