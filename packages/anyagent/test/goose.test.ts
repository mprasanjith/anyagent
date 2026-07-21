import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { runConformance } from "../src/conformance.js";
import { goose } from "../src/goose.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import type { AgentEvent, OutputSource, RunResult } from "../src/types.js";
import { fakeSystemProbe, sourceFromBody } from "./fake-adapter.js";

const FIXTURES = [
  "simple.jsonl",
  "tools.jsonl",
  "edit.jsonl",
  "reasoning.jsonl",
] as const;

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const readFixture = (name: string): string =>
  readFileSync(path.join(import.meta.dir, "fixtures/goose", name), "utf-8");

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(readFixture(name));

const collectSource = async (
  src: OutputSource,
  strict = false
): Promise<{ events: AgentEvent[]; result?: RunResult }> => {
  const events: AgentEvent[] = [];
  for await (const ev of goose().parse(src, { strict })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === "done");
  return { events, result: done?.type === "done" ? done.result : undefined };
};

const collect = (name: string) => collectSource(fixtureSource(name));

const assistantMessage = (content: unknown[]): unknown => ({
  message: { content, role: "assistant" },
  type: "message",
});

const toolRequest = (name: string, args: unknown): unknown =>
  assistantMessage([
    {
      id: `call_${name}`,
      toolCall: { status: "success", value: { arguments: args, name } },
      type: "toolRequest",
    },
  ]);

test("buildInvocation maps stream-json, quiet mode, stdin input, and the auto default", () => {
  const inv = goose().buildInvocation("hi", {});
  expect(inv.command).toBe("goose");
  // --quiet keeps stdout pure NDJSON; -i - pipes the prompt over stdin.
  expect(inv.args).toEqual([
    "run",
    "--output-format",
    "stream-json",
    "--quiet",
    "-i",
    "-",
  ]);
  expect(inv.input).toBe("hi");
  // The unattended baseline pins GOOSE_MODE=auto by default.
  expect(inv.env).toEqual({ GOOSE_MODE: "auto" });
});

test("a caller's env merges over the GOOSE_MODE default and can override it", () => {
  const merged = goose().buildInvocation("x", { env: { FOO: "bar" } });
  expect(merged.env).toEqual({ FOO: "bar", GOOSE_MODE: "auto" });
  const pinned = goose().buildInvocation("x", {
    env: { GOOSE_MODE: "approve" },
  });
  expect(pinned.env).toEqual({ GOOSE_MODE: "approve" });
});

test("model splits at the first slash into --provider and --model", () => {
  const inv = goose().buildInvocation("hi", {
    model: "openrouter/openai/gpt-4o-mini",
  });
  const at = (flag: string): string | undefined =>
    inv.args[inv.args.indexOf(flag) + 1];
  expect(at("--provider")).toBe("openrouter");
  // The rest may itself contain slashes (openrouter model paths).
  expect(at("--model")).toBe("openai/gpt-4o-mini");
});

test("a slash-free model rides --model alone, provider left to goose config", () => {
  const inv = goose().buildInvocation("hi", { model: "gpt-4o-mini" });
  expect(inv.args).not.toContain("--provider");
  expect(inv.args[inv.args.indexOf("--model") + 1]).toBe("gpt-4o-mini");
});

test("buildInvocation emits system and resume flags and cwd", () => {
  const inv = goose().buildInvocation("hi", {
    cwd: "/work",
    resume: "my-session",
    systemPrompt: "be brief",
  });
  const at = (flag: string): string | undefined =>
    inv.args[inv.args.indexOf(flag) + 1];
  expect(at("--system")).toBe("be brief");
  // Resume is by session name: --name <name> --resume.
  expect(at("--name")).toBe("my-session");
  expect(inv.args).toContain("--resume");
  expect(inv.cwd).toBe("/work");
});

test("parses a simple text answer with usage from complete", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result?.text).toBe("pong");
  expect(typeof result?.usage?.inputTokens).toBe("number");
  expect(typeof result?.usage?.outputTokens).toBe("number");
  expect(events.at(-1)?.type).toBe("done");
});

test("goose never reveals a session id headless: no session event, no sessionId", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(events.some((e) => e.type === "session")).toBe(false);
  expect(result?.sessionId).toBeUndefined();
});

test("shell tool normalizes to bash, keeping the native name and callId", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBe("bash");
  expect(call?.type === "tool-call" && call.nativeName).toBe("shell");
  expect(call?.type === "tool-call" && typeof call.callId).toBe("string");
  // The response pairs with its request: same callId, same names.
  expect(res?.type === "tool-result" && res.callId).toBe(
    call?.type === "tool-call" ? call.callId : ""
  );
  expect(res?.type === "tool-result" && res.name).toBe("bash");
  expect(res?.type === "tool-result" && res.nativeName).toBe("shell");
  expect(res?.type === "tool-result" && JSON.stringify(res.output)).toContain(
    "petrichor"
  );
});

test("the edit fixture surfaces write; unknown tools keep their native name", async () => {
  const { events } = await collect("edit.jsonl");
  const calls = events.filter(
    (e): e is Extract<AgentEvent, { type: "tool-call" }> =>
      e.type === "tool-call"
  );
  expect(calls.map((c) => c.name)).toContain("write");
  const todo = calls.find((c) => c.nativeName === "todo__todo_write");
  expect(todo?.name).toBe("todo__todo_write");
});

test("thinking blocks map to reasoning-delta and stay out of result.text", async () => {
  const { events, result } = await collect("reasoning.jsonl");
  const reasoning = events.filter(
    (e): e is Extract<AgentEvent, { type: "reasoning-delta" }> =>
      e.type === "reasoning-delta"
  );
  expect(reasoning).toHaveLength(1);
  expect(reasoning[0]?.text).toContain("pong");
  expect(result?.text).toBe("pong");
});

test("extension-prefixed tool names normalize on the bare tool", async () => {
  const { events } = await collectSource(
    bodySource([toolRequest("developer__shell", { command: "ls" })])
  );
  const call = events.find((e) => e.type === "tool-call");
  expect(call?.type === "tool-call" && call.name).toBe("bash");
  expect(call?.type === "tool-call" && call.nativeName).toBe(
    "developer__shell"
  );
});

test("text_editor normalizes per command: create writes, str_replace edits", async () => {
  const nameFor = async (args: unknown): Promise<string> => {
    const { events } = await collectSource(
      bodySource([toolRequest("developer__text_editor", args)])
    );
    const call = events.find((e) => e.type === "tool-call");
    return call?.type === "tool-call" ? call.name : "";
  };
  expect(await nameFor({ command: "create", path: "a.txt" })).toBe("write");
  expect(await nameFor({ command: "str_replace", path: "a.txt" })).toBe("edit");
  // A command outside the known set keeps the honest native name.
  expect(await nameFor({ command: "view", path: "a.txt" })).toBe(
    "developer__text_editor"
  );
});

test("strict mode tolerates every recorded real shape", async () => {
  await expect(
    Promise.all(FIXTURES.map((f) => collectSource(fixtureSource(f), true)))
  ).resolves.toHaveLength(FIXTURES.length);
});

test("a toolResponse with an unseen id falls back to unknown names", async () => {
  const { events } = await collectSource(
    bodySource([
      {
        message: {
          content: [
            {
              id: "never-seen",
              toolResult: { value: { content: [] } },
              type: "toolResponse",
            },
          ],
          role: "user",
        },
        type: "message",
      },
    ])
  );
  const res = events.find((e) => e.type === "tool-result");
  expect(res?.type === "tool-result" && res.name).toBe("unknown");
  expect(res?.type === "tool-result" && res.nativeName).toBe("unknown");
});

test("a failed run's complete with null tokens leaves usage undefined", async () => {
  // Goose reports provider errors as ordinary assistant text and closes with
  // a complete event whose token counts are null.
  const { events, result } = await collectSource(
    bodySource([
      {
        message: {
          content: [{ text: "Ran into this error: Bad request", type: "text" }],
          role: "assistant",
        },
        type: "message",
      },
      {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        type: "complete",
      },
    ])
  );
  expect(result?.usage).toBeUndefined();
  expect(events.some((e) => e.type === "usage")).toBe(false);
  expect(result?.text).toContain("Ran into this error");
});

test("strict mode throws on unknown event and content types", async () => {
  await expect(
    collectSource(bodySource([{ type: "mystery" }]), true)
  ).rejects.toMatchObject({ code: "Parse" });
  await expect(
    collectSource(
      bodySource([
        {
          message: { content: [{ type: "hologram" }], role: "assistant" },
          type: "message",
        },
      ]),
      true
    )
  ).rejects.toMatchObject({ code: "Parse" });
});

test("nonzero exit after valid output fails loud instead of returning it", async () => {
  const line = JSON.stringify({
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    type: "complete",
  });
  const src = spawnAndStream({
    args: ["-c", `printf '%s\\n' '${line}'; exit 1`],
    command: "sh",
  });
  await expect(collectSource(src)).rejects.toMatchObject({
    code: "Invocation",
  });
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

test("goose passes conformance over its recorded fixtures", async () => {
  await runConformance(goose(), {
    fixtures: Object.fromEntries(FIXTURES.map((f) => [f, readFixture(f)])),
  });
});
