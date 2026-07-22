import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { claudeCode } from "../src/claude-code.js";
import { runConformance } from "../src/conformance.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import type { AgentEvent, OutputSource, RunResult } from "../src/types.js";
import { fakeSystemProbe, sourceFromBody } from "./fake-adapter.js";

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const fixture = (name: string): string =>
  readFileSync(
    path.join(import.meta.dir, "fixtures/claude-code", name),
    "utf-8"
  );

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(fixture(name));

const collectSource = async (
  src: OutputSource,
  strict = false
): Promise<{ events: AgentEvent[]; result?: RunResult }> => {
  const events: AgentEvent[] = [];
  for await (const ev of claudeCode().parse(src, { strict })) {
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

test("buildInvocation defaults to full autonomy: bypassPermissions, no deny list", () => {
  const inv = claudeCode().buildInvocation("hi", {});
  expect(inv.command).toBe("claude");
  expect(inv.args).toContain("-p");
  // Prompt goes to stdin, never argv, so it can't hit the OS argv size limit.
  expect(inv.input).toBe("hi");
  expect(inv.args).not.toContain("hi");
  expect(argAfter(inv.args, "--output-format")).toBe("stream-json");
  expect(argAfter(inv.args, "--permission-mode")).toBe("bypassPermissions");
  expect(inv.args).not.toContain("--disallowedTools");
});

test("readOnly maps to manual mode plus a deny of the mutating built-ins", () => {
  const inv = claudeCode().buildInvocation("x", { readOnly: true });
  expect(argAfter(inv.args, "--permission-mode")).toBe("manual");
  const denied = argAfter(inv.args, "--disallowedTools")?.split(",") ?? [];
  for (const tool of ["Bash", "Edit", "NotebookEdit", "Write"]) {
    expect(denied).toContain(tool);
  }
});

test("effort maps to --effort", () => {
  const inv = claudeCode().buildInvocation("x", { effort: "high" });
  expect(argAfter(inv.args, "--effort")).toBe("high");
});

test("mcp maps to --mcp-config plus --strict-mcp-config", () => {
  const inv = claudeCode().buildInvocation("x", {
    mcp: { srv: { args: ["--x"], command: "run-srv" } },
  });
  expect(JSON.parse(argAfter(inv.args, "--mcp-config") ?? "{}")).toEqual({
    mcpServers: { srv: { args: ["--x"], command: "run-srv" } },
  });
  expect(inv.args).toContain("--strict-mcp-config");
});

test("schema maps to --json-schema with the schema serialized verbatim", () => {
  const schema = {
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    type: "object",
  };
  const inv = claudeCode().buildInvocation("x", { schema });
  expect(JSON.parse(argAfter(inv.args, "--json-schema") ?? "{}")).toEqual(
    schema
  );
});

test("buildInvocation emits every optional flag and passes cwd/env", () => {
  const inv = claudeCode().buildInvocation("hi", {
    cwd: "/work",
    env: { FOO: "bar" },
    model: "opus",
    resume: "sess-1",
    systemPrompt: "be brief",
  });
  expect(inv.args).toContain("--verbose");
  expect(argAfter(inv.args, "--model")).toBe("opus");
  expect(argAfter(inv.args, "--append-system-prompt")).toBe("be brief");
  expect(argAfter(inv.args, "--resume")).toBe("sess-1");
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
});

test("forkSession adds --fork-session alongside --resume", () => {
  const inv = claudeCode().buildInvocation("x", {
    forkSession: true,
    resume: "sess-1",
  });
  expect(argAfter(inv.args, "--resume")).toBe("sess-1");
  expect(inv.args).toContain("--fork-session");
});

test("a plain resume omits --fork-session", () => {
  const inv = claudeCode().buildInvocation("x", { resume: "sess-1" });
  expect(argAfter(inv.args, "--resume")).toBe("sess-1");
  expect(inv.args).not.toContain("--fork-session");
});

test("parses a simple text answer with usage and cache accounting", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result.text).toBe("pong");
  // Values are volatile per run; assert the fields are populated, not magnitudes.
  expect(typeof result.usage?.inputTokens).toBe("number");
  expect(typeof result.usage?.outputTokens).toBe("number");
  expect(typeof result.usage?.cacheReadTokens).toBe("number");
  expect(typeof result.usage?.cacheWriteTokens).toBe("number");
  expect(typeof result.usage?.costUsd).toBe("number");
  expect(events.at(-1)?.type).toBe("done");
});

test("system init yields one session event and result.sessionId matches", async () => {
  const { events, result } = await collect("simple.jsonl");
  const sessions = events.filter((e) => e.type === "session");
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.type === "session" && sessions[0].sessionId).toBe(
    "11111111-1111-4111-8111-111111111111"
  );
  expect(result.sessionId).toBe("11111111-1111-4111-8111-111111111111");
});

test("result.session_id wins over the init's when both are present", async () => {
  const { result } = await collectSource(
    bodySource([
      { session_id: "init-id", subtype: "init", type: "system" },
      {
        is_error: false,
        result: "",
        session_id: "result-id",
        subtype: "success",
        type: "result",
      },
    ])
  );
  expect(result?.sessionId).toBe("result-id");
});

test("tool_use/tool_result carry normalized name, native name, and callId", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBe("read");
  expect(call?.type === "tool-call" && call.nativeName).toBe("Read");
  expect(call?.type === "tool-call" && call.callId).toBe(
    "toolu_01KWPj98xGinBtovE1MyaTFy"
  );
  expect(res?.type === "tool-result" && res.name).toBe("read");
  expect(res?.type === "tool-result" && res.nativeName).toBe("Read");
  expect(res?.type === "tool-result" && res.callId).toBe(
    "toolu_01KWPj98xGinBtovE1MyaTFy"
  );
});

test("a tool outside the shared vocabulary keeps its native name as name", async () => {
  const { events } = await collect("structured.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  expect(call?.type === "tool-call" && call.name).toBe("StructuredOutput");
  expect(call?.type === "tool-call" && call.nativeName).toBe(
    "StructuredOutput"
  );
});

test("thinking blocks surface as reasoning-delta, never in result.text", async () => {
  const { events, result } = await collect("tools.jsonl");
  const reasoning = events.find((e) => e.type === "reasoning-delta");
  expect(reasoning?.type === "reasoning-delta" && reasoning.text).toBe(
    "I should read the file."
  );
  expect(result.text).toBe("anyagent");
});

test("redacted_thinking emits no event and passes strict", async () => {
  const { events } = await collectSource(
    bodySource([
      {
        message: {
          content: [{ data: "opaque", type: "redacted_thinking" }],
          role: "assistant",
        },
        type: "assistant",
      },
      { is_error: false, result: "", subtype: "success", type: "result" },
    ]),
    true
  );
  expect(events.some((e) => e.type === "reasoning-delta")).toBe(false);
});

test("structured output synthesizes the serialized JSON as text", async () => {
  const { events, result } = await collect("structured.jsonl");
  expect(result.text).toBe('{"ok":true}');
  const deltas = events.filter((e) => e.type === "text-delta");
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.type === "text-delta" && deltas[0].text).toBe(
    '{"ok":true}'
  );
  expect(result.sessionId).toBe("9c24f1e5-355e-4431-9851-9f75de402916");
});

test("structured output never overrides assistant text that was streamed", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        message: {
          content: [{ text: '{"ok":false}', type: "text" }],
          role: "assistant",
        },
        type: "assistant",
      },
      {
        is_error: false,
        result: '{"ok":false}',
        structured_output: { ok: true },
        subtype: "success",
        type: "result",
      },
    ])
  );
  expect(result?.text).toBe('{"ok":false}');
});

test("agent-level error (is_error) throws instead of returning success", async () => {
  await expect(
    collectSource(
      bodySource([
        {
          message: {
            content: [{ text: "partial", type: "text" }],
            role: "assistant",
          },
          type: "assistant",
        },
        {
          is_error: true,
          result: "Reached max turns.",
          subtype: "error_max_turns",
          type: "result",
        },
      ])
    )
  ).rejects.toMatchObject({
    code: "Invocation",
    message: expect.stringContaining("Reached max turns"),
  });
});

test("strict mode tolerates every recorded real-output shape", async () => {
  await expect(
    Promise.all(
      ["simple.jsonl", "tools.jsonl", "structured.jsonl"].map((f) =>
        collectSource(fixtureSource(f), true)
      )
    )
  ).resolves.toHaveLength(3);
});

test("strict mode tolerates the named expansion types and drops them", async () => {
  const { events } = await collectSource(
    bodySource([
      { type: "stream_event" },
      { type: "prompt_suggestion" },
      { type: "hook_started" },
      { is_error: false, result: "", subtype: "success", type: "result" },
    ]),
    true
  );
  expect(events.map((e) => e.type)).toEqual(["done"]);
});

test("strict mode throws on a genuinely unknown top-level event type", async () => {
  await expect(
    collectSource(bodySource([{ type: "mystery" }]), true)
  ).rejects.toMatchObject({
    code: "Parse",
    message: expect.stringContaining("mystery"),
  });
});

test("strict mode throws on an unknown assistant content block", async () => {
  await expect(
    collectSource(
      bodySource([
        {
          message: {
            content: [{ source: {}, type: "image" }],
            role: "assistant",
          },
          type: "assistant",
        },
      ]),
      true
    )
  ).rejects.toMatchObject({
    code: "Parse",
    message: expect.stringContaining("image"),
  });
});

test("tool_result with an unseen tool_use_id falls back to name 'unknown'", async () => {
  const { events } = await collectSource(
    bodySource([
      {
        message: {
          content: [
            { content: "x", tool_use_id: "never-seen", type: "tool_result" },
          ],
          role: "user",
        },
        type: "user",
      },
      { is_error: false, result: "", subtype: "success", type: "result" },
    ])
  );
  const res = events.find((e) => e.type === "tool-result");
  expect(res?.type === "tool-result" && res.name).toBe("unknown");
  expect(res?.type === "tool-result" && res.nativeName).toBe("unknown");
});

test("a result without usage yields no usage event and leaves usage undefined", async () => {
  const { events, result } = await collectSource(
    bodySource([
      {
        message: { content: [{ text: "hi", type: "text" }], role: "assistant" },
        type: "assistant",
      },
      { is_error: false, result: "hi", subtype: "success", type: "result" },
    ])
  );
  expect(result?.usage).toBeUndefined();
  expect(events.some((e) => e.type === "usage")).toBe(false);
});

test("usage is populated from total_cost_usd alone (tokens undefined)", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        is_error: false,
        result: "",
        subtype: "success",
        total_cost_usd: 0.02,
        type: "result",
      },
    ])
  );
  expect(result?.usage?.costUsd).toBe(0.02);
  expect(result?.usage?.inputTokens).toBeUndefined();
  expect(result?.usage?.cacheReadTokens).toBeUndefined();
});

test("usage is populated from the usage block alone (cost undefined)", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        is_error: false,
        result: "",
        subtype: "success",
        type: "result",
        usage: {
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 3,
          input_tokens: 5,
          output_tokens: 2,
        },
      },
    ])
  );
  expect(result?.usage?.inputTokens).toBe(5);
  expect(result?.usage?.cacheReadTokens).toBe(3);
  expect(result?.usage?.cacheWriteTokens).toBe(7);
  expect(result?.usage?.costUsd).toBeUndefined();
});

test("text is concatenated across multiple assistant messages", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        message: {
          content: [{ text: "foo", type: "text" }],
          role: "assistant",
        },
        type: "assistant",
      },
      {
        message: {
          content: [{ text: "bar", type: "text" }],
          role: "assistant",
        },
        type: "assistant",
      },
      { is_error: false, result: "foobar", subtype: "success", type: "result" },
    ])
  );
  expect(result?.text).toBe("foobar");
});

test("authStatus: exit 0 with loggedIn is authenticated with its method", async () => {
  const calls: { args: string[]; bin: string }[] = [];
  const probe = fakeSystemProbe({
    exec: (bin, args) => {
      calls.push({ args, bin });
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          authMethod: "claude.ai",
          loggedIn: true,
          subscriptionType: "max",
        }),
      });
    },
  });
  const status = await claudeCode().authStatus?.(probe);
  expect(status?.state).toBe("authenticated");
  expect(status?.method).toBe("claude.ai");
  expect(calls).toEqual([
    { args: ["auth", "status", "--json"], bin: "claude" },
  ]);
});

test("authStatus: nonzero exit is unauthenticated", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({ code: 1, stderr: "not logged in", stdout: "" }),
  });
  const status = await claudeCode().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus: exit 0 with loggedIn false is unauthenticated", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ loggedIn: false }),
      }),
  });
  const status = await claudeCode().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus: exec failure or unparseable output is unknown", async () => {
  const failing = fakeSystemProbe({
    exec: () => Promise.reject(new Error("ENOENT")),
  });
  const garbled = fakeSystemProbe({
    exec: () => Promise.resolve({ code: 0, stderr: "", stdout: "not json" }),
  });
  expect((await claudeCode().authStatus?.(failing))?.state).toBe("unknown");
  expect((await claudeCode().authStatus?.(garbled))?.state).toBe("unknown");
});

test("conformance passes over all recorded fixtures", async () => {
  await runConformance(claudeCode(), {
    fixtures: {
      simple: fixture("simple.jsonl"),
      structured: fixture("structured.jsonl"),
      tools: fixture("tools.jsonl"),
    },
  });
});

test("nonzero exit after valid output fails loud instead of returning it", async () => {
  const line = JSON.stringify({
    is_error: false,
    result: "pong",
    subtype: "success",
    total_cost_usd: 0.01,
    type: "result",
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
