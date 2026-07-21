import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { opencode } from "../src/opencode.js";
import type { AgentEvent, OutputSource, RunResult } from "../src/types.js";
import { sourceFromBody } from "./fake-adapter.js";

const SESSION_ID = /^ses_/u;

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(
    readFileSync(path.join(import.meta.dir, "fixtures/opencode", name), "utf-8")
  );

const collectSource = async (
  src: OutputSource,
  strict = false
): Promise<{ events: AgentEvent[]; result?: RunResult }> => {
  const events: AgentEvent[] = [];
  for await (const ev of opencode().parse(src, { strict })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === "done");
  return { events, result: done?.type === "done" ? done.result : undefined };
};

const collect = (name: string) => collectSource(fixtureSource(name));

test("buildInvocation maps prompt, json mode, and edit permission by default", () => {
  const inv = opencode().buildInvocation("hi", { permission: "edit" });
  expect(inv.command).toBe("opencode");
  expect(inv.args.slice(0, 3)).toEqual(["run", "--format", "json"]);
  // Prompt goes to stdin, never argv, so it can't hit the OS argv size limit.
  expect(inv.input).toBe("hi");
  expect(inv.args).not.toContain("hi");
  // `edit` is the CLI's own default behavior; no --auto.
  expect(inv.args).not.toContain("--auto");
});

test("auto adds --auto; read throws UnsupportedCapability", () => {
  const auto = opencode().buildInvocation("x", { permission: "auto" });
  expect(auto.args).toContain("--auto");
  expect(() => opencode().buildInvocation("x", { permission: "read" })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});

test("buildInvocation emits model and session flags and passes cwd/env", () => {
  const inv = opencode().buildInvocation("hi", {
    cwd: "/work",
    env: { FOO: "bar" },
    model: "openrouter/openai/gpt-4o-mini",
    permission: "edit",
    resume: "ses_123",
  });
  const at = (flag: string): string | undefined =>
    inv.args[inv.args.indexOf(flag) + 1];
  expect(at("--model")).toBe("openrouter/openai/gpt-4o-mini");
  expect(at("--session")).toBe("ses_123");
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
});

test("parses a simple text answer with usage summed from step_finish", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result?.text).toBe("pong");
  // Values are volatile per run; assert the fields are populated, not magnitudes.
  expect(typeof result?.usage?.inputTokens).toBe("number");
  expect(typeof result?.usage?.outputTokens).toBe("number");
  expect(typeof result?.usage?.costUsd).toBe("number");
  expect(events.at(-1)?.type).toBe("done");
});

test("raw exposes the session id for resume", async () => {
  const { result } = await collect("simple.jsonl");
  const raw = result?.raw as { sessionId?: string; stepFinish?: unknown };
  expect(raw.sessionId).toMatch(SESSION_ID);
  expect(raw.stepFinish).toBeDefined();
});

test("a completed tool_use maps to tool-call then tool-result", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBe("read");
  expect(res?.type === "tool-result" && res.name).toBe("read");
  expect(res?.type === "tool-result" && String(res.output)).toContain(
    "petrichor"
  );
});

test("the edit fixture surfaces the write tool", async () => {
  const { events } = await collect("edit.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  expect(call?.type === "tool-call" && call.name).toBe("write");
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

test("usage sums tokens and cost across multiple steps", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        part: { cost: 0.1, tokens: { input: 10, output: 1 } },
        type: "step_finish",
      },
      {
        part: { cost: 0.2, tokens: { input: 20, output: 2 } },
        type: "step_finish",
      },
    ])
  );
  expect(result?.usage?.inputTokens).toBe(30);
  expect(result?.usage?.outputTokens).toBe(3);
  expect(result?.usage?.costUsd).toBeCloseTo(0.3);
});

test("an errored tool state still yields the call and its error output", async () => {
  const { events } = await collectSource(
    bodySource([
      {
        part: {
          state: {
            error: "File not found",
            input: { filePath: "x" },
            status: "error",
          },
          tool: "read",
        },
        type: "tool_use",
      },
    ])
  );
  const res = events.find((e) => e.type === "tool-result");
  expect(res?.type === "tool-result" && res.output).toBe("File not found");
});

test("an error event throws Invocation with the native message", async () => {
  await expect(
    collectSource(
      bodySource([
        {
          error: { data: { message: "Model not found" }, name: "UnknownError" },
          type: "error",
        },
      ])
    )
  ).rejects.toMatchObject({
    code: "Invocation",
    message: expect.stringContaining("Model not found"),
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

test("a run without step_finish leaves usage undefined", async () => {
  const { result } = await collectSource(
    bodySource([{ part: { text: "hi" }, type: "text" }])
  );
  expect(result?.usage).toBeUndefined();
});

test("nonzero exit after valid output fails loud instead of returning it", async () => {
  const line = JSON.stringify({ part: { text: "hi" }, type: "text" });
  const src = spawnAndStream({
    args: ["-c", `printf '%s\\n' '${line}'; exit 1`],
    command: "sh",
  });
  await expect(collectSource(src)).rejects.toMatchObject({
    code: "Invocation",
  });
});
