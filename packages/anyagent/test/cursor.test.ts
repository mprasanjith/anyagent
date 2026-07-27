import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { runConformance } from "../src/conformance.js";
import { cursor } from "../src/cursor.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import type { AgentEvent, OutputSource, RunResult } from "../src/types.js";
import { fakeSystemProbe, sourceFromBody } from "./fake-adapter.js";

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dir, "fixtures/cursor", name), "utf-8");

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(fixture(name));

const collectSource = async (
  src: OutputSource,
  strict = false
): Promise<{ events: AgentEvent[]; result?: RunResult }> => {
  const events: AgentEvent[] = [];
  for await (const ev of cursor().parse(src, { strict })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === "done");
  return { events, result: done?.type === "done" ? done.result : undefined };
};

const collect = async (
  name: string
): Promise<{ events: AgentEvent[]; result: RunResult }> => {
  const { events, result } = await collectSource(fixtureSource(name));
  return { events, result: result ?? { events: [], raw: undefined, text: "" } };
};

const argAfter = (args: string[], flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];

test("buildInvocation defaults to forced print mode with prompt on stdin", () => {
  const inv = cursor().buildInvocation("hi", {});
  expect(inv.command).toBe("agent");
  expect(inv.args).toContain("-p");
  expect(argAfter(inv.args, "--output-format")).toBe("stream-json");
  // Without --force, print mode only proposes edits — the unattended default
  // must apply them.
  expect(inv.args).toContain("--force");
  expect(inv.args).not.toContain("--mode");
  // Prompt goes to stdin, never argv.
  expect(inv.input).toBe("hi");
  expect(inv.args).not.toContain("hi");
});

test("the trust flag is always present so headless runs never stall", () => {
  expect(cursor().buildInvocation("x", {}).args).toContain("--trust");
  expect(cursor().buildInvocation("x", { readOnly: true }).args).toContain(
    "--trust"
  );
});

test("readOnly maps to enforced plan mode and drops the force flag", () => {
  const inv = cursor().buildInvocation("x", { readOnly: true });
  expect(argAfter(inv.args, "--mode")).toBe("plan");
  expect(inv.args).not.toContain("--force");
});

test("model passes through verbatim, bracket overrides included", () => {
  const bracketed = "claude-opus-4-8[context=1m,effort=high,fast=false]";
  const inv = cursor().buildInvocation("x", { model: bracketed });
  expect(argAfter(inv.args, "--model")).toBe(bracketed);
});

test("effort compiles into the model's bracket overrides", () => {
  const inv = cursor().buildInvocation("x", { effort: "high", model: "m" });
  expect(argAfter(inv.args, "--model")).toBe("m[effort=high]");
});

test("effort merges into caller-supplied brackets by appending", () => {
  const inv = cursor().buildInvocation("x", {
    effort: "high",
    model: "m[context=1m]",
  });
  expect(argAfter(inv.args, "--model")).toBe("m[context=1m,effort=high]");
});

test("effort without model throws InvalidOptions before anything spawns", () => {
  let err: unknown;
  try {
    cursor().buildInvocation("x", { effort: "high" });
  } catch (e) {
    err = e;
  }
  expect(err).toMatchObject({
    code: "InvalidOptions",
    name: "AnyAgentError",
  });
});

test("resume maps to the resume flag with the chat id", () => {
  const inv = cursor().buildInvocation("go on", { resume: "chat-1" });
  expect(argAfter(inv.args, "--resume")).toBe("chat-1");
});

test("buildInvocation passes cwd and env through", () => {
  const inv = cursor().buildInvocation("hi", {
    cwd: "/work",
    env: { FOO: "bar" },
  });
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
});

test("parses a simple text answer with camelCase usage incl. cache fields", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result.text).toBe("pong");
  expect(result.usage?.inputTokens).toBe(8881);
  expect(result.usage?.outputTokens).toBe(12);
  expect(result.usage?.cacheReadTokens).toBe(128);
  expect(result.usage?.cacheWriteTokens).toBe(0);
  expect(events.at(-1)?.type).toBe("done");
});

test("thinking deltas stream as reasoning-delta and never join the text", async () => {
  const { events, result } = await collect("simple.jsonl");
  const reasoning = events.filter((e) => e.type === "reasoning-delta");
  expect(reasoning).toHaveLength(3);
  expect(
    reasoning[0]?.type === "reasoning-delta" && reasoning[0].text
  ).toContain("The user requested");
  expect(result.text).toBe("pong");
});

test("the init event becomes one session event matching result.sessionId", async () => {
  const { events, result } = await collect("simple.jsonl");
  const sessions = events.filter((e) => e.type === "session");
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.type === "session" && sessions[0].sessionId).toBe(
    "ac598f1d-3fc1-4da8-ade1-9486e7e152e8"
  );
  expect(result.sessionId).toBe("ac598f1d-3fc1-4da8-ade1-9486e7e152e8");
  // The session event arrives before any answer text.
  expect(events.findIndex((e) => e.type === "session")).toBeLessThan(
    events.findIndex((e) => e.type === "text-delta")
  );
});

test("usage maps the camelCase fields onto the normalized names", async () => {
  const { events, result } = await collectSource(
    bodySource([
      {
        is_error: false,
        result: "",
        subtype: "success",
        type: "result",
        usage: {
          cacheReadTokens: 70,
          cacheWriteTokens: 3,
          inputTokens: 100,
          outputTokens: 5,
        },
      },
    ])
  );
  expect(result?.usage).toEqual({
    cacheReadTokens: 70,
    cacheWriteTokens: 3,
    inputTokens: 100,
    outputTokens: 5,
  });
  expect(events.some((e) => e.type === "usage")).toBe(true);
});

test("a result without usage leaves usage undefined", async () => {
  const { events, result } = await collectSource(
    bodySource([{ is_error: false, subtype: "success", type: "result" }])
  );
  expect(result?.usage).toBeUndefined();
  expect(events.some((e) => e.type === "usage")).toBe(false);
});

test("read and edit tool calls normalize with native envelope names", async () => {
  const { events } = await collect("tools.jsonl");
  const calls = events.filter((e) => e.type === "tool-call");
  const results = events.filter((e) => e.type === "tool-result");
  expect(calls).toHaveLength(2);
  expect(results).toHaveLength(2);
  const [read, edit] = calls;
  const [readResult, editResult] = results;
  expect(read?.type === "tool-call" && read.name).toBe("read");
  expect(read?.type === "tool-call" && read.nativeName).toBe("readToolCall");
  expect(
    read?.type === "tool-call" && (read.input as { path: string }).path
  ).toContain("notes.txt");
  // call_id pairs the result with its call.
  expect(readResult?.type === "tool-result" && readResult.callId).toBe(
    read?.type === "tool-call" ? read.callId : undefined
  );
  expect(edit?.type === "tool-call" && edit.name).toBe("edit");
  expect(edit?.type === "tool-call" && edit.nativeName).toBe("editToolCall");
  expect(
    editResult?.type === "tool-result" &&
      (editResult.output as { success: { path: string } }).success.path
  ).toContain("hello.txt");
});

test("shell tool calls normalize to the shared bash name", async () => {
  const { events } = await collect("shell.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBe("bash");
  expect(call?.type === "tool-call" && call.nativeName).toBe("shellToolCall");
  expect(
    call?.type === "tool-call" && (call.input as { command: string }).command
  ).toBe("echo hi-from-shell");
  expect(
    res?.type === "tool-result" &&
      (res.output as { success: { stdout: string } }).success.stdout
  ).toContain("hi-from-shell");
});

test("a tool outside the shared vocabulary keeps its native envelope name", async () => {
  const { events } = await collectSource(
    bodySource([
      {
        call_id: "c1",
        subtype: "started",
        tool_call: { mysteryToolCall: { args: { q: 1 } } },
        type: "tool_call",
      },
      { is_error: false, subtype: "success", type: "result" },
    ])
  );
  const call = events.find((e) => e.type === "tool-call");
  expect(call?.type === "tool-call" && call.name).toBe("mysteryToolCall");
  expect(call?.type === "tool-call" && call.nativeName).toBe("mysteryToolCall");
});

test("text concatenates across multiple assistant messages", async () => {
  const { result } = await collect("tools.jsonl");
  expect(result.text).toBe(
    "I'll read `notes.txt` first, then create `hello.txt` with the exact contents you specified.Read `notes.txt` (two lines). Created `hello.txt` with exactly `hello`."
  );
});

test("strict mode tolerates every recorded real shape", async () => {
  await expect(
    Promise.all(
      ["simple.jsonl", "tools.jsonl", "shell.jsonl"].map((f) =>
        collectSource(fixtureSource(f), true)
      )
    )
  ).resolves.toHaveLength(3);
});

test("an error result throws Invocation with the native message", async () => {
  await expect(
    collectSource(
      bodySource([
        {
          is_error: true,
          result: "quota exhausted",
          subtype: "error",
          type: "result",
        },
      ])
    )
  ).rejects.toMatchObject({
    code: "Invocation",
    message: expect.stringContaining("quota exhausted"),
  });
});

test("strict mode throws on unknown shapes at every level", async () => {
  const cases: unknown[][] = [
    [{ type: "mystery" }],
    [{ subtype: "mystery", text: "x", type: "thinking" }],
    [
      {
        call_id: "c",
        subtype: "mystery",
        tool_call: { readToolCall: {} },
        type: "tool_call",
      },
    ],
    [{ call_id: "c", subtype: "started", tool_call: {}, type: "tool_call" }],
    [
      {
        message: { content: [{ type: "mystery" }], role: "assistant" },
        type: "assistant",
      },
    ],
  ];
  await Promise.all(
    cases.map((lines) =>
      expect(collectSource(bodySource(lines), true)).rejects.toMatchObject({
        code: "Parse",
      })
    )
  );
});

test("nonzero exit after valid output fails loud instead of returning it", async () => {
  const line = JSON.stringify({
    is_error: false,
    subtype: "success",
    type: "result",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const src = spawnAndStream({
    args: ["-c", `printf '%s\\n' '${line}'; exit 1`],
    command: "sh",
  });
  await expect(collectSource(src)).rejects.toMatchObject({
    code: "Invocation",
  });
});

test("authStatus reads `agent status --format json`: isAuthenticated wins", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          isAuthenticated: true,
          status: "authenticated",
          userInfo: { email: "user@example.com" },
        }),
      }),
  });
  const status = await cursor().authStatus?.(probe);
  expect(status).toEqual({ state: "authenticated" });
});

test("authStatus maps isAuthenticated false to unauthenticated", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ isAuthenticated: false }),
      }),
  });
  const status = await cursor().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus maps a nonzero non-JSON exit to unauthenticated", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({ code: 1, stderr: "not logged in", stdout: "" }),
  });
  const status = await cursor().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus reports unknown on a clean exit without JSON", async () => {
  const probe = fakeSystemProbe({
    exec: () => Promise.resolve({ code: 0, stderr: "", stdout: "plain text" }),
  });
  const status = await cursor().authStatus?.(probe);
  expect(status?.state).toBe("unknown");
});

test("authStatus reports unknown when the CLI cannot be executed", async () => {
  const probe = fakeSystemProbe({
    exec: () => Promise.reject(new Error("spawn ENOENT")),
  });
  const status = await cursor().authStatus?.(probe);
  expect(status?.state).toBe("unknown");
});

test("listModels parses `agent --list-models` into verbatim ids", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: fixture("list-models.txt"),
      }),
  });
  const models = await cursor().listModels?.(probe);
  expect(models?.length).toBeGreaterThan(0);
  const ids = models?.map((m) => m.id) ?? [];
  expect(ids).toContain("auto");
  expect(ids).toContain("gpt-5.3-codex-low");
  // The header and the trailing tip line are not models.
  expect(ids).not.toContain("Available");
  expect(ids).not.toContain("Tip:");
});

test("listModels throws Invocation when the CLI fails", async () => {
  const failing = fakeSystemProbe({
    exec: () => Promise.resolve({ code: 1, stderr: "boom", stdout: "" }),
  });
  await expect(cursor().listModels?.(failing)).rejects.toMatchObject({
    code: "Invocation",
  });
  const missing = fakeSystemProbe({
    exec: () => Promise.reject(new Error("spawn ENOENT")),
  });
  await expect(cursor().listModels?.(missing)).rejects.toMatchObject({
    code: "Invocation",
  });
});

test("listModels throws Parse when no model lines are found", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({ code: 0, stderr: "", stdout: "nothing useful here" }),
  });
  await expect(cursor().listModels?.(probe)).rejects.toMatchObject({
    code: "Parse",
  });
});

test("cursor passes the adapter conformance suite", async () => {
  await runConformance(cursor(), {
    fixtures: {
      shell: fixture("shell.jsonl"),
      simple: fixture("simple.jsonl"),
      tools: fixture("tools.jsonl"),
    },
  });
});
