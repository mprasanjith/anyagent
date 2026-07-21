import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { codex } from "../src/codex.js";
import { runConformance } from "../src/conformance.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import type { AgentEvent, OutputSource, RunResult } from "../src/types.js";
import { fakeSystemProbe, sourceFromBody } from "./fake-adapter.js";

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dir, "fixtures/codex", name), "utf-8");

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(fixture(name));

const collectSource = async (
  src: OutputSource,
  strict = false
): Promise<{ events: AgentEvent[]; result?: RunResult }> => {
  const events: AgentEvent[] = [];
  for await (const ev of codex().parse(src, { strict })) {
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

test("buildInvocation defaults to full-access sandbox with prompt on stdin", () => {
  const inv = codex().buildInvocation("hi", {});
  expect(inv.command).toBe("codex");
  expect(inv.args[0]).toBe("exec");
  expect(inv.args).toContain("--json");
  expect(argAfter(inv.args, "--sandbox")).toBe("danger-full-access");
  // Prompt goes to stdin via the `-` positional, never argv.
  expect(inv.input).toBe("hi");
  expect(inv.args).not.toContain("hi");
  expect(inv.args.at(-1)).toBe("-");
});

test("readOnly maps to the native read-only sandbox", () => {
  const inv = codex().buildInvocation("x", { readOnly: true });
  expect(argAfter(inv.args, "--sandbox")).toBe("read-only");
});

test("effort passes through verbatim as a config override", () => {
  const inv = codex().buildInvocation("x", { effort: "ultra" });
  const cIndex = inv.args.indexOf("-c");
  expect(inv.args[cIndex + 1]).toBe('model_reasoning_effort="ultra"');
});

test("omitting effort emits no reasoning config override", () => {
  const inv = codex().buildInvocation("x", {});
  expect(inv.args.join(" ")).not.toContain("model_reasoning_effort");
});

test("resume builds the exec resume form with sandbox as a config override", () => {
  const inv = codex().buildInvocation("go on", { resume: "thread-1" });
  expect(inv.args.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
  // `codex exec resume` has no --sandbox flag; the sandbox rides on -c.
  expect(inv.args).not.toContain("--sandbox");
  expect(argAfter(inv.args, "-c")).toBe('sandbox_mode="danger-full-access"');
  expect(inv.args.at(-1)).toBe("-");
});

test("resume with readOnly overrides the sandbox to read-only", () => {
  const inv = codex().buildInvocation("go on", {
    readOnly: true,
    resume: "thread-1",
  });
  expect(argAfter(inv.args, "-c")).toBe('sandbox_mode="read-only"');
});

test("buildInvocation emits the model flag and passes cwd/env", () => {
  const inv = codex().buildInvocation("hi", {
    cwd: "/work",
    env: { FOO: "bar" },
    model: "gpt-5.2-codex",
  });
  expect(argAfter(inv.args, "--model")).toBe("gpt-5.2-codex");
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
});

test("parses a simple text answer with usage", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result.text).toBe("pong");
  // Values are volatile per run; assert the fields are populated, not magnitudes.
  expect(typeof result.usage?.inputTokens).toBe("number");
  expect(typeof result.usage?.outputTokens).toBe("number");
  expect(typeof result.usage?.cacheReadTokens).toBe("number");
  expect(typeof result.usage?.reasoningTokens).toBe("number");
  expect(events.at(-1)?.type).toBe("done");
});

test("thread.started becomes one session event matching result.sessionId", async () => {
  const { events, result } = await collect("simple.jsonl");
  const sessions = events.filter((e) => e.type === "session");
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.type === "session" && sessions[0].sessionId).toBe(
    "019f1f78-4a2d-7bf0-bec9-d176148473dd"
  );
  expect(result.sessionId).toBe("019f1f78-4a2d-7bf0-bec9-d176148473dd");
  // The session event arrives before any answer text.
  expect(events.findIndex((e) => e.type === "session")).toBeLessThan(
    events.findIndex((e) => e.type === "text-delta")
  );
});

test("usage keeps codex's native accounting: cache reads stay folded into input", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        type: "turn.completed",
        usage: {
          cached_input_tokens: 70,
          input_tokens: 100,
          output_tokens: 5,
          reasoning_output_tokens: 2,
        },
      },
    ])
  );
  expect(result?.usage?.inputTokens).toBe(100);
  expect(result?.usage?.cacheReadTokens).toBe(70);
  expect(result?.usage?.outputTokens).toBe(5);
  expect(result?.usage?.reasoningTokens).toBe(2);
});

test("raw exposes the thread id for resume alongside turn.completed", async () => {
  const { result } = await collect("simple.jsonl");
  const raw = result.raw as { threadId?: string; turnCompleted?: unknown };
  expect(raw.threadId).toBe("019f1f78-4a2d-7bf0-bec9-d176148473dd");
  expect(raw.turnCompleted).toMatchObject({ type: "turn.completed" });
});

test("parses command_execution into a correlated bash tool-call/result pair", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBe("bash");
  expect(call?.type === "tool-call" && call.nativeName).toBe(
    "command_execution"
  );
  expect(call?.type === "tool-call" && String(call.input)).toContain(
    "README.md"
  );
  expect(res?.type === "tool-result" && res.name).toBe("bash");
  expect(res?.type === "tool-result" && res.nativeName).toBe(
    "command_execution"
  );
  expect(res?.type === "tool-result" && String(res.output)).toContain(
    "anyagent"
  );
  // The item id pairs the result with its call.
  const callId = call?.type === "tool-call" ? call.callId : undefined;
  expect(callId).toBe("item_1");
  expect(res?.type === "tool-result" && res.callId).toBe(callId);
});

test("parses file_change into tool-call then tool-result under its native name", async () => {
  const { events, result } = await collect("edit.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBe("file_change");
  expect(call?.type === "tool-call" && call.nativeName).toBe("file_change");
  expect(res?.type === "tool-result" && res.name).toBe("file_change");
  expect(
    res?.type === "tool-result" && (res.output as { path: string }[])[0]?.path
  ).toContain("hello.txt");
  expect(result.text.endsWith("done")).toBe(true);
});

test("strict mode tolerates every recorded real shape", async () => {
  await expect(
    Promise.all(
      ["simple.jsonl", "tools.jsonl", "edit.jsonl"].map((f) =>
        collectSource(fixtureSource(f), true)
      )
    )
  ).resolves.toHaveLength(3);
});

test("turn.failed throws Invocation with the native message", async () => {
  await expect(
    collectSource(
      bodySource([
        { thread_id: "t", type: "thread.started" },
        { type: "turn.started" },
        { error: { message: "model not supported" }, type: "turn.failed" },
      ])
    )
  ).rejects.toMatchObject({
    code: "Invocation",
    message: expect.stringContaining("model not supported"),
  });
});

test("a top-level error event throws Invocation", async () => {
  await expect(
    collectSource(
      bodySource([
        { thread_id: "t", type: "thread.started" },
        { message: "stream disconnected", type: "error" },
      ])
    )
  ).rejects.toMatchObject({
    code: "Invocation",
    message: expect.stringContaining("stream disconnected"),
  });
});

test("an error item is advisory and does not end the run", async () => {
  const { result } = await collectSource(
    bodySource([
      { thread_id: "t", type: "thread.started" },
      {
        item: { id: "item_0", message: "metadata fallback", type: "error" },
        type: "item.completed",
      },
      { type: "turn.started" },
      {
        item: { id: "item_1", text: "pong", type: "agent_message" },
        type: "item.completed",
      },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ])
  );
  expect(result?.text).toBe("pong");
});

test("strict mode throws on an unknown item type", async () => {
  await expect(
    collectSource(
      bodySource([
        {
          item: { id: "item_0", type: "mystery_item" },
          type: "item.completed",
        },
      ]),
      true
    )
  ).rejects.toMatchObject({
    code: "Parse",
    message: expect.stringContaining("mystery_item"),
  });
});

test("strict mode throws on an unknown top-level event type", async () => {
  await expect(
    collectSource(bodySource([{ type: "mystery" }]), true)
  ).rejects.toMatchObject({
    code: "Parse",
    message: expect.stringContaining("mystery"),
  });
});

test("text is concatenated across multiple agent messages", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        item: { id: "item_0", text: "foo", type: "agent_message" },
        type: "item.completed",
      },
      {
        item: { id: "item_1", text: "bar", type: "agent_message" },
        type: "item.completed",
      },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ])
  );
  expect(result?.text).toBe("foobar");
});

test("a turn.completed without usage leaves usage undefined", async () => {
  const { events, result } = await collectSource(
    bodySource([
      {
        item: { id: "item_0", text: "hi", type: "agent_message" },
        type: "item.completed",
      },
      { type: "turn.completed" },
    ])
  );
  expect(result?.usage).toBeUndefined();
  expect(events.some((e) => e.type === "usage")).toBe(false);
});

test("nonzero exit after valid output fails loud instead of returning it", async () => {
  const line = JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const src = spawnAndStream({
    args: ["-c", `printf '%s\\n' '${line}'; exit 1`],
    command: "sh",
  });
  await expect(collectSource(src)).rejects.toMatchObject({
    code: "Invocation",
  });
});

test("authStatus reads `codex login status`: exit 0 is authenticated", async () => {
  const probe = fakeSystemProbe({
    // The verdict prints on stderr on the real CLI.
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "Logged in using ChatGPT\n",
        stdout: "",
      }),
  });
  const status = await codex().authStatus?.(probe);
  expect(status?.state).toBe("authenticated");
  expect(status?.method).toBe("chatgpt");
  expect(String(status?.raw)).toContain("ChatGPT");
});

test("authStatus recognizes the API-key login method", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "Logged in using an API key\n",
        stdout: "",
      }),
  });
  const status = await codex().authStatus?.(probe);
  expect(status?.state).toBe("authenticated");
  expect(status?.method).toBe("api-key");
});

test("authStatus maps a nonzero exit to unauthenticated", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({ code: 1, stderr: "Not logged in\n", stdout: "" }),
  });
  const status = await codex().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus reports unknown when the CLI cannot be executed", async () => {
  const probe = fakeSystemProbe({
    exec: () => Promise.reject(new Error("spawn ENOENT")),
  });
  const status = await codex().authStatus?.(probe);
  expect(status?.state).toBe("unknown");
});

test("listModels parses `codex debug models` into usable ids with efforts", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: fixture("debug-models.json"),
      }),
  });
  const models = await codex().listModels?.(probe);
  expect(models?.length).toBeGreaterThan(0);
  const ids = models?.map((m) => m.id) ?? [];
  expect(ids).toContain("gpt-5.6-sol");
  // Hidden internal models are excluded, matching the CLI's own picker.
  expect(ids).not.toContain("codex-auto-review");
  const sol = models?.find((m) => m.id === "gpt-5.6-sol");
  expect(sol?.reasoningEfforts).toContain("ultra");
  expect(sol?.reasoningEfforts).toContain("low");
  expect(sol?.raw).toMatchObject({ slug: "gpt-5.6-sol" });
});

test("listModels throws Invocation when the CLI fails", async () => {
  const failing = fakeSystemProbe({
    exec: () => Promise.resolve({ code: 1, stderr: "boom", stdout: "" }),
  });
  await expect(codex().listModels?.(failing)).rejects.toMatchObject({
    code: "Invocation",
  });
  const missing = fakeSystemProbe({
    exec: () => Promise.reject(new Error("spawn ENOENT")),
  });
  await expect(codex().listModels?.(missing)).rejects.toMatchObject({
    code: "Invocation",
  });
});

test("listModels throws Parse on non-JSON output", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({ code: 0, stderr: "", stdout: "not json at all" }),
  });
  await expect(codex().listModels?.(probe)).rejects.toMatchObject({
    code: "Parse",
  });
});

test("codex passes the adapter conformance suite", async () => {
  await runConformance(codex(), {
    fixtures: {
      edit: fixture("edit.jsonl"),
      simple: fixture("simple.jsonl"),
      tools: fixture("tools.jsonl"),
    },
  });
});
