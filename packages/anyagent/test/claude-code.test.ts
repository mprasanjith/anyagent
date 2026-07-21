import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { claudeCode } from "../src/claude-code/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import type {
  AgentEvent,
  OutputSource,
  PermissionLevel,
  RunResult,
} from "../src/types.js";
import { sourceFromBody } from "./fake-adapter.js";

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(
    readFileSync(
      path.join(import.meta.dir, "fixtures/claude-code", name),
      "utf-8"
    )
  );

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

const modeOf = (p: PermissionLevel): string | undefined => {
  const a = claudeCode().buildInvocation("x", { permission: p }).args;
  return a[a.indexOf("--permission-mode") + 1];
};

test("buildInvocation maps prompt, stream-json, and edit permission by default", () => {
  const inv = claudeCode().buildInvocation("hi", { permission: "edit" });
  expect(inv.command).toBe("claude");
  expect(inv.args).toContain("-p");
  // Prompt goes to stdin, never argv, so it can't hit the OS argv size limit.
  expect(inv.input).toBe("hi");
  expect(inv.args).not.toContain("hi");
  expect(inv.args).toContain("--output-format");
  expect(inv.args).toContain("stream-json");
  expect(inv.args).toContain("acceptEdits");
});

test("permission levels map to native modes", () => {
  expect(modeOf("read")).toBe("default");
  expect(modeOf("edit")).toBe("acceptEdits");
  expect(modeOf("auto")).toBe("bypassPermissions");
});

test("parses a simple text answer with usage", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result.text).toBe("pong");
  // Values are volatile per run; assert the fields are populated, not magnitudes.
  expect(typeof result.usage?.inputTokens).toBe("number");
  expect(typeof result.usage?.outputTokens).toBe("number");
  expect(typeof result.usage?.costUsd).toBe("number");
  expect(events.at(-1)?.type).toBe("done");
});

test("parses tool_use + tool_result and names the result via its tool_use id", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBe("Read");
  expect(res?.type === "tool-result" && res.name).toBe("Read");
  expect(res?.type === "tool-result" && String(res.output)).toContain(
    "anyagent"
  );
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

test("strict mode tolerates real system/thinking/rate_limit shapes", async () => {
  await expect(
    Promise.all(
      ["simple.jsonl", "tools.jsonl"].map((f) =>
        collectSource(fixtureSource(f), true)
      )
    )
  ).resolves.toHaveLength(2);
});

test("buildInvocation emits every optional flag and passes cwd/env", () => {
  const inv = claudeCode().buildInvocation("hi", {
    cwd: "/work",
    env: { FOO: "bar" },
    mcp: { srv: { args: ["--x"], command: "run-srv" } },
    model: "opus",
    permission: "edit",
    resume: "sess-1",
    systemPrompt: "be brief",
  });
  const at = (flag: string): string | undefined =>
    inv.args[inv.args.indexOf(flag) + 1];
  expect(inv.args).toContain("--verbose");
  expect(at("--model")).toBe("opus");
  expect(at("--append-system-prompt")).toBe("be brief");
  expect(at("--resume")).toBe("sess-1");
  expect(JSON.parse(at("--mcp-config") ?? "{}")).toEqual({
    mcpServers: { srv: { args: ["--x"], command: "run-srv" } },
  });
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
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
});

test("usage is populated from the usage block alone (cost undefined)", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        is_error: false,
        result: "",
        subtype: "success",
        type: "result",
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    ])
  );
  expect(result?.usage?.inputTokens).toBe(5);
  expect(result?.usage?.costUsd).toBeUndefined();
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

test("strict mode throws on an unknown top-level event type", async () => {
  await expect(
    collectSource(bodySource([{ type: "mystery" }]), true)
  ).rejects.toMatchObject({
    code: "Parse",
    message: expect.stringContaining("mystery"),
  });
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
