import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { runConformance } from "../src/conformance.js";
import { goose } from "../src/goose.js";
import { AcpSessionImpl } from "../src/internal/acp-session.js";
import { AgentImpl } from "../src/internal/agent.js";
import type { SessionOptions } from "../src/types.js";
import {
  response,
  type ScriptApi,
  type ScriptedTransport,
  scriptedTransport,
} from "./acp-transport.js";
import { fakeSystemProbe } from "./fake-adapter.js";

const handshake = async (api: ScriptApi): Promise<void> => {
  const init = await api.next();
  expect(init.method).toBe("initialize");
  api.emit(response(init.id, { agentCapabilities: {}, protocolVersion: 1 }));
};

const gooseSession = (
  opts: SessionOptions,
  transport: ScriptedTransport
): AcpSessionImpl =>
  new AcpSessionImpl(new AgentImpl(goose()), opts, () => transport);

test("goose drives its CLI over ACP", () => {
  const adapter = goose();
  expect(adapter.mode).toBe("acp");
  expect(adapter.acp.command).toEqual(["goose", "acp"]);
});

test("the capabilities match what the endpoint carries", () => {
  const caps = goose().capabilities;
  expect(caps.mcp).toBe("native");
  expect(caps.effort).toBe("native");
  expect(caps.reasoningEfforts).toEqual([
    "off",
    "low",
    "medium",
    "high",
    "max",
  ]);
  // `approve` mode is unverified as a no-writes guarantee.
  expect(caps.readOnly).toBe(false);
  expect(caps.systemPrompt).toBe("emulated");
  expect(caps.structuredOutput).toBe("emulated");
});

test("a session's model and effort become config options", () => {
  const { settings } = goose().acp;
  expect(
    settings?.({ effort: "high", model: "anthropic/claude-sonnet-4.5" })
  ).toEqual({
    configOptions: [
      { configId: "model", value: "anthropic/claude-sonnet-4.5" },
      { configId: "thinking_effort", value: "high" },
    ],
  });
  expect(settings?.({})).toEqual({ configOptions: [] });
});

test("mcp servers reach session/new in both the command and the url shape", async () => {
  const transport = scriptedTransport(async (api) => {
    await handshake(api);
    const created = await api.next();
    expect(created.method).toBe("session/new");
    expect((created.params as { mcpServers?: unknown }).mcpServers).toEqual([
      {
        args: ["-y", "db-server"],
        command: "npx",
        env: [{ name: "TOKEN", value: "t" }],
        name: "db",
      },
      {
        headers: [],
        name: "docs",
        type: "http",
        url: "https://mcp.example/mcp",
      },
    ]);
    api.emit(response(created.id, { sessionId: "s1" }));

    const prompt = await api.next();
    expect(prompt.method).toBe("session/prompt");
    api.emit(response(prompt.id, { stopReason: "end_turn" }));
  });

  const session = gooseSession(
    {
      mcp: {
        db: { args: ["-y", "db-server"], command: "npx", env: { TOKEN: "t" } },
        docs: { url: "https://mcp.example/mcp" },
      },
    },
    transport
  );
  await Promise.all([session.run("hi"), transport.done]);
  await session.close();
});

const INFO_CONFIGURED = [
  "goose Version:",
  "  Version:                  1.43.0",
  "",
  "goose Configuration:",
  "  GOOSE_MODEL: openai/gpt-4o-mini",
  "  GOOSE_PROVIDER: openrouter",
  "  extensions:",
  "    todo:",
  "      enabled: true",
].join("\n");

const INFO_UNCONFIGURED = [
  "goose Version:",
  "  Version:                  1.43.0",
  "",
  "goose Configuration:",
  "  extensions:",
  "    todo:",
  "      enabled: true",
].join("\n");

test("authStatus probes goose info -v, never a paid run", async () => {
  let seen: { bin: string; args: string[] } | undefined;
  const probe = fakeSystemProbe({
    exec: (bin, args) => {
      seen = { args, bin };
      return Promise.resolve({ code: 0, stderr: "", stdout: INFO_CONFIGURED });
    },
  });
  await goose().authStatus?.(probe);
  expect(seen).toEqual({ args: ["info", "-v"], bin: "goose" });
});

test("authStatus: no configured provider is unauthenticated", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({ code: 0, stderr: "", stdout: INFO_UNCONFIGURED }),
  });
  const status = await goose().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus: provider plus its key env var is authenticated", async () => {
  const probe = fakeSystemProbe({
    env: { OPENROUTER_API_KEY: "sk-or-x" },
    exec: () =>
      Promise.resolve({ code: 0, stderr: "", stdout: INFO_CONFIGURED }),
  });
  const status = await goose().authStatus?.(probe);
  expect(status?.state).toBe("authenticated");
  expect(status?.providers).toEqual(["openrouter"]);
  expect(status?.method).toBe("api-key");
});

test("authStatus: provider without its key env var is unknown (keyring)", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({ code: 0, stderr: "", stdout: INFO_CONFIGURED }),
  });
  const status = await goose().authStatus?.(probe);
  expect(status?.state).toBe("unknown");
  expect(status?.providers).toEqual(["openrouter"]);
});

test("authStatus: exec failure or nonzero exit is unknown", async () => {
  const failing = fakeSystemProbe({
    exec: () => Promise.reject(new Error("spawn ENOENT")),
  });
  const nonzero = fakeSystemProbe({
    exec: () => Promise.resolve({ code: 1, stderr: "boom", stdout: "" }),
  });
  expect((await goose().authStatus?.(failing))?.state).toBe("unknown");
  expect((await goose().authStatus?.(nonzero))?.state).toBe("unknown");
});

test("goose passes conformance over its recorded transcript", async () => {
  await runConformance(goose(), {
    fixtures: {},
    transcripts: {
      recorded: readFileSync(
        path.join(import.meta.dir, "fixtures/acp/goose.jsonl"),
        "utf-8"
      ),
    },
  });
});
