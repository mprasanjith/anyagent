import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { AgentImpl } from "../src/internal/agent.js";
import { kiloCode } from "../src/kilo-code.js";
import type { SessionOptions } from "../src/types.js";
import {
  response,
  type ScriptMessage,
  scriptedTransport,
} from "./acp-transport.js";
import { fakeSystemProbe } from "./fake-adapter.js";

// Kilo shares the opencode-family implementation, which opencode.test.ts
// exercises in depth. These tests pin kilo's own identity and the one thing
// the siblings do differently — reasoning effort — against kilo's own
// recorded endpoint.

const SESSION_ID = "ses_kilo";

interface Wire {
  configured: unknown[];
  newSession: ScriptMessage;
}

const turnOverAcp = async (settings: SessionOptions): Promise<Wire> => {
  const wire: Wire = { configured: [], newSession: {} };
  const transport = scriptedTransport(async (api) => {
    const init = await api.next();
    api.emit(response(init.id, { agentCapabilities: {}, protocolVersion: 1 }));

    wire.newSession = await api.next();
    api.emit(response(wire.newSession.id, { sessionId: SESSION_ID }));

    let message = await api.next();
    while (message.method === "session/set_config_option") {
      wire.configured.push(message.params);
      api.emit(response(message.id, {}));
      // biome-ignore lint/performance/noAwaitInLoops: each option is acknowledged before the next.
      message = await api.next();
    }
    api.emit(response(message.id, { stopReason: "end_turn" }));
  });
  const agent = new AgentImpl(kiloCode(), { transport: () => transport });
  const session = agent.session(settings);
  await session.run("hi");
  await session.close();
  await transport.done;
  return wire;
};

test("meta names the kilo binaries and identity", () => {
  const { meta } = kiloCode();
  expect(meta.id).toBe("kilo-code");
  expect(meta.bin).toEqual(["kilo", "kilocode"]);
});

test("kilo declares its own acp endpoint on the family's spec", () => {
  const agent = kiloCode();
  expect(agent.mode).toBe("acp");
  expect(agent.acp.command).toEqual(["kilo", "acp"]);
  expect(agent.acp.readOnly).toEqual({ configId: "mode", value: "plan" });
  expect(agent.capabilities.mcp).toBe("native");
  expect(agent.capabilities.sessionFork).toBe("native");
});

// The sibling difference: kilo's session advertises an `effort` option
// (`test/fixtures/acp/kilo.jsonl`), opencode's does not.
test("kilo carries effort, ordered after the model it is scoped to", async () => {
  expect(kiloCode().capabilities.effort).toBe("native");
  const wire = await turnOverAcp({ effort: "high", model: "openai/gpt-5.4" });
  expect(wire.configured).toEqual([
    { configId: "model", sessionId: SESSION_ID, value: "openai/gpt-5.4" },
    { configId: "effort", sessionId: SESSION_ID, value: "high" },
  ]);
});

test("mcp servers ride kilo's session/new under the caller's own name", async () => {
  const wire = await turnOverAcp({ mcp: { mydb: { command: "npx" } } });
  expect(
    (wire.newSession.params as { mcpServers: unknown }).mcpServers
  ).toEqual([{ args: [], command: "npx", env: [], name: "mydb" }]);
});

test("authStatus reads kilo's own auth store path", async () => {
  const probe = fakeSystemProbe({
    readFile: (p) =>
      Promise.resolve(
        p === "/home/fake/.local/share/kilo/auth.json"
          ? '{"kilocode":{"type":"api","key":"k"}}'
          : undefined
      ),
  });
  const status = await kiloCode().authStatus?.(probe);
  expect(status?.state).toBe("authenticated");
  expect(status?.providers).toEqual(["kilocode"]);
});

test("authStatus falls back to provider env keys, else unauthenticated", async () => {
  const withKey = await kiloCode().authStatus?.(
    fakeSystemProbe({ env: { ANTHROPIC_API_KEY: "sk-ant-x" } })
  );
  expect(withKey?.state).toBe("authenticated");
  expect(withKey?.providers).toEqual(["anthropic"]);

  const bare = await kiloCode().authStatus?.(fakeSystemProbe());
  expect(bare?.state).toBe("unauthenticated");
});

test("listModels execs `kilo models` and parses provider/model lines", async () => {
  // Kilo is the same fork, so the shared parser is fed the opencode-shaped
  // recorded snapshot.
  const calls: [string, string[]][] = [];
  const probe = fakeSystemProbe({
    exec: (bin, args) => {
      calls.push([bin, args]);
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: readFileSync(
          path.join(import.meta.dir, "fixtures/opencode/models.txt"),
          "utf-8"
        ),
      });
    },
  });
  const models = await kiloCode().listModels?.(probe);
  expect(calls).toEqual([["kilo", ["models"]]]);
  expect(models?.length).toBe(6);
  // `opencode/` gateway ids carry no assertable vendor, so `provider` is
  // absent on every one — never the gateway's own name.
  expect(models?.every((m) => m.provider === undefined)).toBe(true);
});
