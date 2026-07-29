import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { runConformance } from "../src/conformance.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import { pi } from "../src/pi.js";
import type { AgentEvent, OutputSource, RunResult } from "../src/types.js";
import { fakeSystemProbe, sourceFromBody } from "./fake-adapter.js";

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dir, "fixtures/pi", name), "utf-8");

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(fixture(name));

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

const argAfter = (inv: { args: string[] }, flag: string): string | undefined =>
  inv.args[inv.args.indexOf(flag) + 1];

test("buildInvocation pipes the prompt via stdin, never as a positional", () => {
  const inv = pi().buildInvocation("hi there", {});
  expect(inv.command).toBe("pi");
  expect(inv.args.slice(0, 3)).toEqual(["--mode", "json", "-p"]);
  expect(inv.input).toBe("hi there");
  expect(inv.args).not.toContain("hi there");
});

test("readOnly restricts the toolset; the default leaves it alone", () => {
  const ro = pi().buildInvocation("x", { readOnly: true });
  expect(argAfter(ro, "--tools")).toBe("read");
  expect(pi().buildInvocation("x", {}).args).not.toContain("--tools");
  expect(pi().buildInvocation("x", { readOnly: false }).args).not.toContain(
    "--tools"
  );
});

test("effort maps to --thinking, spelling our none as pi's off", () => {
  expect(
    argAfter(pi().buildInvocation("x", { effort: "none" }), "--thinking")
  ).toBe("off");
  expect(
    argAfter(pi().buildInvocation("x", { effort: "high" }), "--thinking")
  ).toBe("high");
  expect(pi().buildInvocation("x", {}).args).not.toContain("--thinking");
});

test("buildInvocation emits every optional flag and passes cwd/env", () => {
  const inv = pi().buildInvocation("hi", {
    cwd: "/work",
    env: { FOO: "bar" },
    model: "openrouter/openai/gpt-4o-mini",
    resume: "11111111-2222-4333-8444-555555555555",
    systemPrompt: "be brief",
  });
  expect(argAfter(inv, "--model")).toBe("openrouter/openai/gpt-4o-mini");
  expect(argAfter(inv, "--append-system-prompt")).toBe("be brief");
  expect(argAfter(inv, "--session-id")).toBe(
    "11111111-2222-4333-8444-555555555555"
  );
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
});

test("forkSession maps resume to --fork, replacing --session-id", () => {
  const inv = pi().buildInvocation("x", {
    forkSession: true,
    resume: "11111111-2222-4333-8444-555555555555",
  });
  expect(argAfter(inv, "--fork")).toBe("11111111-2222-4333-8444-555555555555");
  expect(inv.args).not.toContain("--session-id");
});

test("attachments append @file positionals; the prompt stays on stdin", () => {
  const inv = pi().buildInvocation("hi", { attachments: ["a.png", "b.md"] });
  expect(inv.args).toContain("@a.png");
  expect(inv.args).toContain("@b.md");
  expect(inv.input).toBe("hi");
});

test("parses a simple answer from token-level deltas with usage", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result?.text).toBe("pong");
  expect(typeof result?.usage?.inputTokens).toBe("number");
  expect(typeof result?.usage?.outputTokens).toBe("number");
  expect(typeof result?.usage?.costUsd).toBe("number");
  expect(events.at(-1)?.type).toBe("done");
});

test("the session event carries the id that lands on result.sessionId", async () => {
  const { events, result } = await collect("simple.jsonl");
  const sessions = events.filter((e) => e.type === "session");
  expect(sessions).toHaveLength(1);
  const [session] = sessions;
  expect(session?.type === "session" && session.sessionId).toBe(
    "019f2f92-2f46-71e3-8cd6-084d1c6d7c06"
  );
  expect(result?.sessionId).toBe("019f2f92-2f46-71e3-8cd6-084d1c6d7c06");
});

test("parses toolCall blocks and toolResult messages with callId pairing", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type).toBe("tool-call");
  expect(res?.type).toBe("tool-result");
  if (call?.type !== "tool-call" || res?.type !== "tool-result") {
    return;
  }
  // Pi's built-in names are already the shared vocabulary.
  expect(call.name).toBe("read");
  expect(call.nativeName).toBe("read");
  expect(res.name).toBe("read");
  expect(res.nativeName).toBe("read");
  expect(typeof call.callId).toBe("string");
  expect(res.callId).toBe(call.callId);
  expect(JSON.stringify(res.output)).toContain("petrichor");
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

test("strict mode tolerates pi's named housekeeping event types", async () => {
  const { result } = await collectSource(
    bodySource([
      { id: "s1", type: "session" },
      { type: "compaction_start" },
      { type: "compaction_end" },
      { type: "auto_retry_start" },
      { type: "agent_settled" },
      { type: "queue_update" },
    ]),
    true
  );
  expect(result?.sessionId).toBe("s1");
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

test("cache and reasoning tokens are mapped and summed from turn_end", async () => {
  const { result } = await collect("tools.jsonl");
  // The recorded run's second turn reports cacheRead 1152.
  expect(result?.usage?.cacheReadTokens).toBe(1152);
  expect(result?.usage?.cacheWriteTokens).toBe(0);
  expect(result?.usage?.reasoningTokens).toBe(0);
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

test("authStatus reads providers from auth.json", async () => {
  const probe = fakeSystemProbe({
    readFile: (p) =>
      Promise.resolve(
        p === "/home/fake/.pi/agent/auth.json"
          ? JSON.stringify({
              anthropic: { type: "oauth" },
              zai: { key: "k", type: "api_key" },
            })
          : undefined
      ),
  });
  const status = await pi().authStatus?.(probe);
  // Exact shape: the store holds live keys, so nothing extra may come back.
  // An oauth entry beside an api key is a mixed store: billing asserts
  // neither mode.
  expect(status).toEqual({
    billing: "unknown",
    providers: ["anthropic", "zai"],
    state: "authenticated",
  });
});

test("authStatus counts provider env vars as credentials", async () => {
  const probe = fakeSystemProbe({ env: { OPENROUTER_API_KEY: "sk-x" } });
  const status = await pi().authStatus?.(probe);
  expect(status?.state).toBe("authenticated");
  expect(status?.providers).toEqual(["openrouter"]);
});

test("authStatus reports unauthenticated on a bare machine", async () => {
  const status = await pi().authStatus?.(fakeSystemProbe());
  expect(status?.state).toBe("unauthenticated");
  expect(status?.providers).toEqual([]);
});

test("authStatus survives a corrupt auth.json and still reads env vars", async () => {
  const probe = fakeSystemProbe({
    env: { ANTHROPIC_API_KEY: "sk-x" },
    readFile: () => Promise.resolve("not json"),
  });
  const status = await pi().authStatus?.(probe);
  expect(status?.state).toBe("authenticated");
  expect(status?.providers).toEqual(["anthropic"]);
});

test("listModels parses the recorded pi --list-models table", async () => {
  const probe = fakeSystemProbe({
    exec: (bin, args) => {
      expect(bin).toBe("pi");
      expect(args).toEqual(["--list-models"]);
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: fixture("list-models.txt"),
      });
    },
  });
  const models = await pi().listModels?.(probe);
  expect(models?.length).toBeGreaterThan(20);
  const first = models?.[0];
  // The id is provider/model verbatim, the pattern pi's --model accepts.
  expect(first?.id).toBe("anthropic/claude-fable-5");
  expect(first?.provider).toBe("anthropic");
  // The header row must not parse as a model.
  expect(models?.some((m) => m.provider === "provider")).toBe(false);
  expect(models?.some((m) => m.id === "zai/glm-5.2")).toBe(true);
});

test("listModels throws Invocation when the CLI fails", async () => {
  const probe = fakeSystemProbe({
    exec: () => Promise.resolve({ code: 1, stderr: "boom", stdout: "" }),
  });
  await expect(pi().listModels?.(probe)).rejects.toMatchObject({
    code: "Invocation",
  });
});

test("pi passes conformance", async () => {
  await runConformance(pi(), {
    fixtures: {
      edit: fixture("edit.jsonl"),
      simple: fixture("simple.jsonl"),
      tools: fixture("tools.jsonl"),
    },
  });
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
