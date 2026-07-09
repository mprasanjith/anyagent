import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { goose } from "../src/goose/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import type {
  AgentEvent,
  OutputSource,
  RunResult,
} from "../src/internal/types.js";
import { sourceFromBody } from "./fake-adapter.js";

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(
    readFileSync(path.join(import.meta.dir, "fixtures/goose", name), "utf-8")
  );

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

test("buildInvocation maps stream-json, quiet mode, and stdin input", () => {
  const inv = goose().buildInvocation("hi", { permission: "edit" });
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
});

test("auto pins GOOSE_MODE=auto; edit leaves the user's env alone", () => {
  const auto = goose().buildInvocation("x", {
    env: { FOO: "bar" },
    permission: "auto",
  });
  expect(auto.env).toEqual({ FOO: "bar", GOOSE_MODE: "auto" });
  const edit = goose().buildInvocation("x", {
    env: { FOO: "bar" },
    permission: "edit",
  });
  expect(edit.env).toEqual({ FOO: "bar" });
});

test("read throws UnsupportedCapability", () => {
  expect(() => goose().buildInvocation("x", { permission: "read" })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});

test("buildInvocation emits model, system, and resume flags", () => {
  const inv = goose().buildInvocation("hi", {
    cwd: "/work",
    model: "gpt-4o-mini",
    permission: "edit",
    resume: "my-session",
    systemPrompt: "be brief",
  });
  const at = (flag: string): string | undefined =>
    inv.args[inv.args.indexOf(flag) + 1];
  expect(at("--model")).toBe("gpt-4o-mini");
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

test("parses toolRequest/toolResponse into tool-call and tool-result", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBeTruthy();
  expect(res?.type === "tool-result" && res.name).toBe(
    call?.type === "tool-call" ? call.name : ""
  );
  expect(res?.type === "tool-result" && JSON.stringify(res.output)).toContain(
    "petrichor"
  );
});

test("the edit fixture surfaces the write tool", async () => {
  const { events } = await collect("edit.jsonl");
  const names = events
    .filter((e) => e.type === "tool-call")
    .map((e) => (e.type === "tool-call" ? e.name : ""));
  expect(names).toContain("write");
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

test("a toolResponse with an unseen id falls back to name 'unknown'", async () => {
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
