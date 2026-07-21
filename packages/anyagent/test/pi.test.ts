import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { pi } from "../src/pi.js";
import type { AgentEvent, OutputSource, RunResult } from "../src/types.js";
import { sourceFromBody } from "./fake-adapter.js";

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(
    readFileSync(path.join(import.meta.dir, "fixtures/pi", name), "utf-8")
  );

const collectSource = async (
  src: OutputSource,
  strict = false
): Promise<{ events: AgentEvent[]; result?: RunResult }> => {
  const events: AgentEvent[] = [];
  for await (const ev of pi().parse(src, { strict })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === "done");
  return { events, result: done?.type === "done" ? done.result : undefined };
};

const collect = (name: string) => collectSource(fixtureSource(name));

test("buildInvocation maps json mode, print mode, and the prompt positional", () => {
  const inv = pi().buildInvocation("hi there", { permission: "edit" });
  expect(inv.command).toBe("pi");
  expect(inv.args.slice(0, 3)).toEqual(["--mode", "json", "-p"]);
  // Pi has no stdin form; the prompt is the trailing positional.
  expect(inv.args.at(-1)).toBe("hi there");
  expect(inv.input).toBeUndefined();
});

const argAfter = (inv: { args: string[] }, flag: string): string | undefined =>
  inv.args[inv.args.indexOf(flag) + 1];

test("read restricts the toolset; edit and auto stay default", () => {
  const ro = pi().buildInvocation("x", { permission: "read" });
  expect(argAfter(ro, "--tools")).toBe("read");
  // Pi never prompts for approval, so edit and auto are both the
  // default toolset.
  expect(pi().buildInvocation("x", { permission: "edit" }).args).not.toContain(
    "--tools"
  );
  expect(pi().buildInvocation("x", { permission: "auto" }).args).not.toContain(
    "--tools"
  );
});

test("buildInvocation emits every optional flag and passes cwd/env", () => {
  const inv = pi().buildInvocation("hi", {
    cwd: "/work",
    env: { FOO: "bar" },
    model: "openrouter/openai/gpt-4o-mini",
    permission: "edit",
    resume: "11111111-2222-4333-8444-555555555555",
    systemPrompt: "be brief",
  });
  const at = (flag: string): string | undefined =>
    inv.args[inv.args.indexOf(flag) + 1];
  expect(at("--model")).toBe("openrouter/openai/gpt-4o-mini");
  expect(at("--append-system-prompt")).toBe("be brief");
  expect(at("--session-id")).toBe("11111111-2222-4333-8444-555555555555");
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
});

test("parses a simple answer from token-level deltas with usage", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result?.text).toBe("pong");
  expect(typeof result?.usage?.inputTokens).toBe("number");
  expect(typeof result?.usage?.outputTokens).toBe("number");
  expect(typeof result?.usage?.costUsd).toBe("number");
  expect(events.at(-1)?.type).toBe("done");
});

test("raw exposes the session id for resume", async () => {
  const { result } = await collect("simple.jsonl");
  const raw = result?.raw as { sessionId?: string; turnEnd?: unknown };
  expect(typeof raw.sessionId).toBe("string");
  expect(raw.turnEnd).toBeDefined();
});

test("parses toolCall blocks and toolResult messages", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBe("read");
  expect(res?.type === "tool-result" && res.name).toBe("read");
  expect(res?.type === "tool-result" && JSON.stringify(res.output)).toContain(
    "petrichor"
  );
});

test("the edit fixture surfaces a write or edit tool call", async () => {
  const { events } = await collect("edit.jsonl");
  const names = events
    .filter((e) => e.type === "tool-call")
    .map((e) => (e.type === "tool-call" ? e.name : ""));
  expect(names.some((n) => n === "write" || n === "edit")).toBe(true);
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

test("a turn with stopReason error throws despite pi's zero exit code", async () => {
  await expect(
    collectSource(
      bodySource([
        { id: "s1", type: "session" },
        { type: "agent_start" },
        { type: "turn_start" },
        {
          message: {
            content: [],
            errorMessage: "400: model not found",
            role: "assistant",
            stopReason: "error",
          },
          type: "turn_end",
        },
      ])
    )
  ).rejects.toMatchObject({
    code: "Invocation",
    message: expect.stringContaining("model not found"),
  });
});

const turn = (input: number, output: number, total: number) => ({
  message: {
    content: [],
    role: "assistant",
    stopReason: "stop",
    usage: { cost: { total }, input, output },
  },
  type: "turn_end",
});

test("usage sums across turns", async () => {
  const { result } = await collectSource(
    bodySource([turn(10, 1, 0.1), turn(20, 2, 0.2)])
  );
  expect(result?.usage?.inputTokens).toBe(30);
  expect(result?.usage?.outputTokens).toBe(3);
  expect(result?.usage?.costUsd).toBeCloseTo(0.3);
});

test("strict mode throws on unknown top-level, update, and block types", async () => {
  await expect(
    collectSource(bodySource([{ type: "mystery" }]), true)
  ).rejects.toMatchObject({ code: "Parse" });
  await expect(
    collectSource(
      bodySource([
        {
          assistantMessageEvent: { type: "mystery_delta" },
          type: "message_update",
        },
      ]),
      true
    )
  ).rejects.toMatchObject({ code: "Parse" });
  await expect(
    collectSource(
      bodySource([
        {
          message: { content: [{ type: "hologram" }], role: "assistant" },
          type: "message_end",
        },
      ]),
      true
    )
  ).rejects.toMatchObject({ code: "Parse" });
});

test("nonzero exit after valid output fails loud instead of returning it", async () => {
  const line = JSON.stringify({ id: "s1", type: "session" });
  const src = spawnAndStream({
    args: ["-c", `printf '%s\\n' '${line}'; exit 1`],
    command: "sh",
  });
  await expect(collectSource(src)).rejects.toMatchObject({
    code: "Invocation",
  });
});
