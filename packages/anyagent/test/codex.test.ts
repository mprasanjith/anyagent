import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { codex } from "../src/codex/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import type {
  AgentEvent,
  OutputSource,
  PermissionLevel,
  RunResult,
} from "../src/internal/types.js";
import { sourceFromBody } from "./fake-adapter.js";

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(
    readFileSync(path.join(import.meta.dir, "fixtures/codex", name), "utf-8")
  );

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
  return { events, result: result ?? { events: [], raw: null, text: "" } };
};

const sandboxOf = (p: PermissionLevel): string | undefined => {
  const a = codex().buildInvocation("x", { permission: p }).args;
  return a[a.indexOf("--sandbox") + 1];
};

test("buildInvocation maps prompt, json mode, and edit permission by default", () => {
  const inv = codex().buildInvocation("hi", { permission: "edit" });
  expect(inv.command).toBe("codex");
  expect(inv.args[0]).toBe("exec");
  expect(inv.args).toContain("--json");
  // Prompt goes to stdin via the `-` positional, never argv.
  expect(inv.input).toBe("hi");
  expect(inv.args).not.toContain("hi");
  expect(inv.args.at(-1)).toBe("-");
  expect(inv.args).toContain("workspace-write");
});

test("permission levels map to native sandbox modes", () => {
  expect(sandboxOf("read")).toBe("read-only");
  expect(sandboxOf("edit")).toBe("workspace-write");
  expect(sandboxOf("auto")).toBe("danger-full-access");
});

test("resume builds the exec resume form with sandbox as a config override", () => {
  const inv = codex().buildInvocation("go on", {
    permission: "edit",
    resume: "thread-1",
  });
  expect(inv.args.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
  // `codex exec resume` has no --sandbox flag; the level rides on -c.
  expect(inv.args).not.toContain("--sandbox");
  const at = (flag: string): string | undefined =>
    inv.args[inv.args.indexOf(flag) + 1];
  expect(at("-c")).toBe('sandbox_mode="workspace-write"');
  expect(inv.args.at(-1)).toBe("-");
});

test("buildInvocation emits the model flag and passes cwd/env", () => {
  const inv = codex().buildInvocation("hi", {
    cwd: "/work",
    env: { FOO: "bar" },
    model: "gpt-5.2-codex",
    permission: "edit",
  });
  const at = (flag: string): string | undefined =>
    inv.args[inv.args.indexOf(flag) + 1];
  expect(at("--model")).toBe("gpt-5.2-codex");
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
});

test("parses a simple text answer with usage", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result.text).toBe("pong");
  // Values are volatile per run; assert the fields are populated, not magnitudes.
  expect(typeof result.usage?.inputTokens).toBe("number");
  expect(typeof result.usage?.outputTokens).toBe("number");
  expect(events.at(-1)?.type).toBe("done");
});

test("uncached input tokens subtract the cached share", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        type: "turn.completed",
        usage: { cached_input_tokens: 70, input_tokens: 100, output_tokens: 5 },
      },
    ])
  );
  expect(result?.usage?.inputTokens).toBe(30);
  expect(result?.usage?.outputTokens).toBe(5);
});

test("raw exposes the thread id for resume alongside turn.completed", async () => {
  const { result } = await collect("simple.jsonl");
  const raw = result.raw as { threadId?: string; turnCompleted?: unknown };
  expect(raw.threadId).toBe("019f1f78-4a2d-7bf0-bec9-d176148473dd");
  expect(raw.turnCompleted).toMatchObject({ type: "turn.completed" });
});

test("parses command_execution into tool-call then tool-result", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBe("command_execution");
  expect(call?.type === "tool-call" && String(call.input)).toContain(
    "README.md"
  );
  expect(res?.type === "tool-result" && res.name).toBe("command_execution");
  expect(res?.type === "tool-result" && String(res.output)).toContain(
    "anyagent"
  );
});

test("parses file_change into tool-call then tool-result", async () => {
  const { events, result } = await collect("edit.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBe("file_change");
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
