import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { runConformance } from "../src/conformance.js";
import { kiloCode } from "../src/kilo-code.js";
import type { AgentEvent, OutputSource, RunResult } from "../src/types.js";
import { fakeSystemProbe, sourceFromBody } from "./fake-adapter.js";

const SESSION_ID = /^ses_/u;
const CALL_ID = /^call_/u;

// Kilo shares the opencode-family implementation; the shared mapping logic is
// exercised in depth by opencode.test.ts. These tests pin kilo's own identity
// and verify the shared parser against kilo's *own* recorded output, so a
// fork-side format drift cannot hide behind the opencode fixtures.

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dir, "fixtures/kilo-code", name), "utf-8");

const collect = async (
  name: string,
  strict = false
): Promise<{ events: AgentEvent[]; result?: RunResult }> => {
  const events: AgentEvent[] = [];
  const src: OutputSource = sourceFromBody(fixture(name));
  for await (const ev of kiloCode().parse(src, { strict })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === "done");
  return { events, result: done?.type === "done" ? done.result : undefined };
};

test("meta names the kilo binaries and identity", () => {
  const { meta } = kiloCode();
  expect(meta.id).toBe("kilo-code");
  expect(meta.bin).toEqual(["kilo", "kilocode"]);
});

test("buildInvocation drives the kilo binary with the shared flags", () => {
  const inv = kiloCode().buildInvocation("hi", {
    effort: "brainstorm",
    model: "openrouter/openai/gpt-4o-mini",
    resume: "ses_abc",
  });
  expect(inv.command).toBe("kilo");
  expect(inv.args.slice(0, 4)).toEqual(["run", "--format", "json", "--auto"]);
  expect(inv.args).toContain("ses_abc");
  expect(inv.args[inv.args.indexOf("--variant") + 1]).toBe("brainstorm");
  expect(inv.input).toBe("hi");
  expect(inv.env?.KILO_PERMISSION).toBeUndefined();
});

test("forkSession and attachments map through the kilo binary", () => {
  const inv = kiloCode().buildInvocation("hi", {
    attachments: ["/a/one.png", "/b/two.pdf"],
    forkSession: true,
    resume: "ses_abc",
  });
  // `--fork` rides with the --session it requires.
  expect(inv.args).toContain("--fork");
  expect(inv.args[inv.args.indexOf("--session") + 1]).toBe("ses_abc");
  // `-f` repeats once per attachment path.
  const files = inv.args
    .map((a, i) => (a === "-f" ? inv.args[i + 1] : undefined))
    .filter((v): v is string => v !== undefined);
  expect(files).toEqual(["/a/one.png", "/b/two.pdf"]);
});

test("kilo declares its own acp endpoint and native fork/attachments", () => {
  const agent = kiloCode();
  expect(agent.acp?.command).toEqual(["kilo", "acp"]);
  expect(agent.capabilities.sessionFork).toBe("native");
  expect(agent.capabilities.attachments).toBe("native");
});

test("kilo takes the live session tier while keeping the family's acp spec", () => {
  const agent = kiloCode();
  expect(agent.capabilities.session).toBe("native");
  expect(agent.acp?.readOnly).toEqual({ configId: "mode", value: "plan" });
  expect(agent.acp?.settings?.({ model: "kilo/openai/gpt-5.4" })).toEqual({
    configOptions: [{ configId: "model", value: "kilo/openai/gpt-5.4" }],
  });
});

// Verified against the real binary (7.4.16): `KILO_CONFIG_CONTENT` servers
// connect under the caller's key and merge with file config.
test("mcp servers land in the adapter-owned config env var", () => {
  expect(kiloCode().capabilities.mcp).toBe("native");
  const inv = kiloCode().buildInvocation("x", {
    env: { KEEP: "yes" },
    mcp: { mydb: { command: "npx" } },
  });
  expect(inv.env?.KEEP).toBe("yes");
  const config = JSON.parse(inv.env?.KILO_CONFIG_CONTENT ?? "");
  expect(config.mcp.mydb).toEqual({
    command: ["npx"],
    enabled: true,
    type: "local",
  });
});

test("readOnly sets the deny matrix in KILO_PERMISSION, overriding the caller's", () => {
  const inv = kiloCode().buildInvocation("x", {
    env: { KEEP: "yes", KILO_PERMISSION: '{"*":"allow"}' },
    readOnly: true,
  });
  expect(inv.args).toContain("--auto");
  expect(inv.env?.KEEP).toBe("yes");
  expect(JSON.parse(inv.env?.KILO_PERMISSION ?? "")).toEqual({
    bash: "deny",
    edit: "deny",
  });
});

test("parses kilo's own simple fixture with the session formalized", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result?.text).toBe("pong");
  expect(typeof result?.usage?.inputTokens).toBe("number");
  const session = events.find(
    (e): e is Extract<AgentEvent, { type: "session" }> => e.type === "session"
  );
  expect(session?.sessionId).toMatch(SESSION_ID);
  expect(result?.sessionId).toBe(session?.sessionId ?? "");
});

test("parses kilo's own tools and edit fixtures", async () => {
  const tools = await collect("tools.jsonl");
  const call = tools.events.find(
    (e): e is Extract<AgentEvent, { type: "tool-call" }> =>
      e.type === "tool-call"
  );
  expect(call?.name).toBe("read");
  expect(call?.nativeName).toBe("read");
  expect(call?.callId).toMatch(CALL_ID);
  // Both recorded kilo steps were partially served from the prompt cache.
  expect(tools.result?.usage?.cacheReadTokens).toBe(11_008);

  const edit = await collect("edit.jsonl");
  const write = edit.events.find(
    (e) => e.type === "tool-call" && e.name === "write"
  );
  expect(write).toBeDefined();
});

test("tolerates kilo's named reasoning event and maps it to reasoning-delta", async () => {
  const events: AgentEvent[] = [];
  const src = sourceFromBody(
    JSON.stringify({ part: { text: "hmm" }, type: "reasoning" })
  );
  for await (const ev of kiloCode().parse(src, { strict: true })) {
    events.push(ev);
  }
  const reasoning = events.find(
    (e): e is Extract<AgentEvent, { type: "reasoning-delta" }> =>
      e.type === "reasoning-delta"
  );
  expect(reasoning?.text).toBe("hmm");
});

test("strict mode tolerates every recorded real kilo shape", async () => {
  await expect(
    Promise.all(
      ["simple.jsonl", "tools.jsonl", "edit.jsonl"].map((n) => collect(n, true))
    )
  ).resolves.toHaveLength(3);
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
  // No kilo binary is installed here to snapshot; kilo is the same fork, so
  // the shared parser is fed the opencode-shaped recorded snapshot.
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
  expect(models?.every((m) => m.provider === "opencode")).toBe(true);
});

test("kilo-code passes conformance", async () => {
  await runConformance(kiloCode(), {
    fixtures: {
      edit: fixture("edit.jsonl"),
      simple: fixture("simple.jsonl"),
      tools: fixture("tools.jsonl"),
    },
  });
});
