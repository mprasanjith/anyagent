import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { runConformance } from "../src/conformance.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { opencode } from "../src/opencode.js";
import type { AgentEvent, OutputSource, RunResult } from "../src/types.js";
import { fakeSystemProbe, sourceFromBody } from "./fake-adapter.js";

const SESSION_ID = /^ses_/u;
const CALL_ID = /^call_/u;

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dir, "fixtures/opencode", name), "utf-8");

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

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

const collect = (name: string) => collectSource(sourceFromBody(fixture(name)));

test("buildInvocation defaults to full autonomy: --auto, no permission env", () => {
  const inv = opencode().buildInvocation("hi", {});
  expect(inv.command).toBe("opencode");
  expect(inv.args.slice(0, 4)).toEqual(["run", "--format", "json", "--auto"]);
  // Prompt goes to stdin, never argv, so it can't hit the OS argv size limit.
  expect(inv.input).toBe("hi");
  expect(inv.args).not.toContain("hi");
  expect(inv.env?.OPENCODE_PERMISSION).toBeUndefined();
});

test("readOnly keeps --auto and sets the category deny matrix in the adapter-owned env var", () => {
  const inv = opencode().buildInvocation("x", { readOnly: true });
  expect(inv.args).toContain("--auto");
  expect(JSON.parse(inv.env?.OPENCODE_PERMISSION ?? "")).toEqual({
    bash: "deny",
    edit: "deny",
  });
});

test("under readOnly the adapter's permission key wins; other caller env survives", () => {
  const inv = opencode().buildInvocation("x", {
    env: { FOO: "bar", OPENCODE_PERMISSION: '{"edit":"allow"}' },
    readOnly: true,
  });
  expect(inv.env?.FOO).toBe("bar");
  expect(JSON.parse(inv.env?.OPENCODE_PERMISSION ?? "")).toEqual({
    bash: "deny",
    edit: "deny",
  });
});

test("buildInvocation emits model/session/variant flags and passes cwd/env", () => {
  const inv = opencode().buildInvocation("hi", {
    cwd: "/work",
    effort: "high",
    env: { FOO: "bar" },
    model: "openrouter/openai/gpt-4o-mini",
    resume: "ses_123",
  });
  const at = (flag: string): string | undefined =>
    inv.args[inv.args.indexOf(flag) + 1];
  expect(at("--model")).toBe("openrouter/openai/gpt-4o-mini");
  expect(at("--session")).toBe("ses_123");
  expect(at("--variant")).toBe("high");
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
});

test("effort passes a provider-defined variant name through verbatim", () => {
  const inv = opencode().buildInvocation("x", { effort: "brainstorm-v2" });
  expect(inv.args[inv.args.indexOf("--variant") + 1]).toBe("brainstorm-v2");
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

test("emits session once on first sight and formalizes it on RunResult.sessionId", async () => {
  const { events, result } = await collect("simple.jsonl");
  const sessions = events.filter(
    (e): e is Extract<AgentEvent, { type: "session" }> => e.type === "session"
  );
  expect(sessions).toHaveLength(1);
  expect(events[0]?.type).toBe("session");
  expect(sessions[0]?.sessionId).toMatch(SESSION_ID);
  expect(result?.sessionId).toBe(sessions[0]?.sessionId ?? "");
  // The composed raw payload keeps carrying it too.
  const raw = result?.raw as { sessionId?: string; stepFinish?: unknown };
  expect(raw.sessionId).toBe(sessions[0]?.sessionId ?? "");
  expect(raw.stepFinish).toBeDefined();
});

test("maps cache tokens from step_finish onto usage events and the summed result", async () => {
  const { events, result } = await collect("tools.jsonl");
  const usages = events.filter(
    (e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage"
  );
  // The recorded second step was served from the prompt cache.
  expect(usages.at(-1)?.usage.cacheReadTokens).toBe(6656);
  expect(result?.usage?.cacheReadTokens).toBe(6656);
  expect(result?.usage?.cacheWriteTokens).toBe(0);
  expect(result?.usage?.reasoningTokens).toBe(0);
});

test("usage sums tokens, cache, reasoning, and cost across steps", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        part: {
          cost: 0.1,
          tokens: {
            cache: { read: 5, write: 1 },
            input: 10,
            output: 1,
            reasoning: 7,
          },
        },
        type: "step_finish",
      },
      {
        part: {
          cost: 0.2,
          tokens: {
            cache: { read: 5, write: 2 },
            input: 20,
            output: 2,
            reasoning: 3,
          },
        },
        type: "step_finish",
      },
    ])
  );
  expect(result?.usage?.inputTokens).toBe(30);
  expect(result?.usage?.outputTokens).toBe(3);
  expect(result?.usage?.cacheReadTokens).toBe(10);
  expect(result?.usage?.cacheWriteTokens).toBe(3);
  expect(result?.usage?.reasoningTokens).toBe(10);
  expect(result?.usage?.costUsd).toBeCloseTo(0.3);
});

test("a completed tool_use maps to tool-call then tool-result with names and call id", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find(
    (e): e is Extract<AgentEvent, { type: "tool-call" }> =>
      e.type === "tool-call"
  );
  const res = events.find(
    (e): e is Extract<AgentEvent, { type: "tool-result" }> =>
      e.type === "tool-result"
  );
  expect(call?.name).toBe("read");
  expect(call?.nativeName).toBe("read");
  // The CLI's own call correlation id pairs the result with its call.
  expect(call?.callId).toMatch(CALL_ID);
  expect(res?.callId).toBe(call?.callId ?? "");
  expect(String(res?.output)).toContain("petrichor");
});

test("a tool outside the shared vocabulary keeps its native name — webfetch is not webSearch", async () => {
  const { events } = await collectSource(
    bodySource([
      {
        part: {
          callID: "call_1",
          state: {
            input: { url: "https://example.com" },
            output: "ok",
            status: "completed",
          },
          tool: "webfetch",
        },
        type: "tool_use",
      },
    ])
  );
  const call = events.find(
    (e): e is Extract<AgentEvent, { type: "tool-call" }> =>
      e.type === "tool-call"
  );
  expect(call?.name).toBe("webfetch");
  expect(call?.nativeName).toBe("webfetch");
});

test("a named reasoning event maps to reasoning-delta and stays out of result.text", async () => {
  // strict: the named type must be tolerated, never treated as drift.
  const { events, result } = await collectSource(
    bodySource([
      { part: { text: "let me think" }, type: "reasoning" },
      { part: { text: "pong" }, type: "text" },
    ]),
    true
  );
  const reasoning = events.find(
    (e): e is Extract<AgentEvent, { type: "reasoning-delta" }> =>
      e.type === "reasoning-delta"
  );
  expect(reasoning?.text).toBe("let me think");
  expect(result?.text).toBe("pong");
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
        collectSource(sourceFromBody(fixture(f)), true)
      )
    )
  ).resolves.toHaveLength(3);
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
  expect(status?.state).toBe("authenticated");
  expect(status?.providers?.toSorted()).toEqual(["anthropic", "openrouter"]);
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

test("opencode passes conformance", async () => {
  await runConformance(opencode(), {
    fixtures: {
      edit: fixture("edit.jsonl"),
      simple: fixture("simple.jsonl"),
      tools: fixture("tools.jsonl"),
    },
  });
});
