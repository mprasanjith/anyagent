import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { cline } from "../src/cline/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import type {
  AgentEvent,
  OutputSource,
  RunResult,
} from "../src/internal/types.js";

const bodySource = (lines: unknown[]): OutputSource => {
  const body = lines
    .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
    .join("\n");
  return {
    exitCode: Promise.resolve(0),
    async *lines() {
      for (const l of body.split("\n")) {
        yield l;
      }
    },
    stderr: () => Promise.resolve(""),
    text: () => Promise.resolve(body),
  };
};

const collectSource = async (
  src: OutputSource,
  strict = false
): Promise<{ events: AgentEvent[]; result?: RunResult }> => {
  const events: AgentEvent[] = [];
  for await (const ev of cline().parse(src, { strict })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === "done");
  return { events, result: done?.type === "done" ? done.result : undefined };
};

const fixtureSource = (name: string): OutputSource =>
  bodySource(
    readFileSync(
      path.join(import.meta.dir, "fixtures/cline", name),
      "utf-8"
    ).split("\n")
  );

const collect = (name: string) => collectSource(fixtureSource(name));

const RESULT_OK = {
  finishReason: "completed",
  text: "",
  type: "run_result",
  usage: { inputTokens: 1, outputTokens: 1, totalCost: 0.1 },
};

test("buildInvocation maps json mode, pinned auto-approve, and the prompt positional", () => {
  const inv = cline().buildInvocation("hi there", { permission: "edit" });
  expect(inv.command).toBe("cline");
  expect(inv.args.slice(0, 3)).toEqual(["--json", "--auto-approve", "true"]);
  // cline's headless mode does not read a piped prompt reliably; positional.
  expect(inv.args.at(-1)).toBe("hi there");
  expect(inv.input).toBeUndefined();
});

test("edit and auto build the same auto-approved invocation", () => {
  const edit = cline().buildInvocation("x", { permission: "edit" });
  const auto = cline().buildInvocation("x", { permission: "auto" });
  expect(edit.args).toEqual(auto.args);
});

test("read throws UnsupportedCapability (plan mode still runs commands)", () => {
  expect(() => cline().buildInvocation("x", { permission: "read" })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});

test("buildInvocation emits the model flag and passes cwd/env", () => {
  const inv = cline().buildInvocation("hi there", {
    cwd: "/work",
    env: { FOO: "bar" },
    model: "openai/gpt-4o-mini",
    permission: "edit",
  });
  const at = (flag: string): string | undefined =>
    inv.args[inv.args.indexOf(flag) + 1];
  expect(at("-m")).toBe("openai/gpt-4o-mini");
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
});

test("parses a simple text answer with usage from run_result", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result?.text).toBe("pong");
  expect(typeof result?.usage?.inputTokens).toBe("number");
  expect(typeof result?.usage?.outputTokens).toBe("number");
  expect(typeof result?.usage?.costUsd).toBe("number");
  expect(events.at(-1)?.type).toBe("done");
});

test("parses tool content into tool-call and tool-result", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBe("read_files");
  expect(res?.type === "tool-result" && res.name).toBe("read_files");
});

test("the tools fixture's stray plain-text notice is filtered, not fatal", async () => {
  // The recorded stream really contains a non-JSON "AI SDK Warning" line on
  // stdout; parsing it proves the filter works on real output.
  const body = readFileSync(
    path.join(import.meta.dir, "fixtures/cline", "tools.jsonl"),
    "utf-8"
  );
  expect(body.split("\n").some((l) => l.startsWith("AI SDK Warning"))).toBe(
    true
  );
  const { result } = await collect("tools.jsonl");
  expect(result?.text.toLowerCase()).toContain("petrichor");
});

test("the edit fixture surfaces a file-writing tool", async () => {
  const { events } = await collect("edit.jsonl");
  const names = events
    .filter((e) => e.type === "tool-call")
    .map((e) => (e.type === "tool-call" ? e.name : ""));
  expect(names.length).toBeGreaterThan(0);
});

const drainStrict = async (name: string): Promise<void> => {
  for await (const _ of cline().parse(fixtureSource(name), { strict: true })) {
    // drain; a strict-mode Parse error would reject here
  }
};

test("strict mode tolerates every recorded real shape", async () => {
  await expect(
    Promise.all(["simple.jsonl", "tools.jsonl", "edit.jsonl"].map(drainStrict))
  ).resolves.toHaveLength(3);
});

test("a run_result with finishReason error throws with cline's message", async () => {
  const consume = async () => {
    await collectSource(
      bodySource([
        {
          finishReason: "error",
          text: "not a valid model ID",
          type: "run_result",
        },
      ])
    );
  };
  await expect(consume()).rejects.toMatchObject({
    code: "Invocation",
    message: expect.stringContaining("not a valid model ID"),
  });
});

test("text deltas come from content_end alone, never double-counted", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        event: { contentType: "text", text: "po", type: "content_delta" },
        type: "agent_event",
      },
      {
        event: { contentType: "text", text: "pong", type: "content_end" },
        type: "agent_event",
      },
      RESULT_OK,
    ])
  );
  expect(result?.text).toBe("pong");
});

test("a run_result without usage leaves usage undefined", async () => {
  const { events, result } = await collectSource(
    bodySource([{ finishReason: "completed", type: "run_result" }])
  );
  expect(result?.usage).toBeUndefined();
  expect(events.some((e) => e.type === "usage")).toBe(false);
});

test("strict mode throws on unknown event and content types", async () => {
  await expect(
    collectSource(bodySource([{ type: "mystery" }]), true)
  ).rejects.toMatchObject({ code: "Parse" });
  await expect(
    collectSource(
      bodySource([{ event: { type: "mystery_event" }, type: "agent_event" }]),
      true
    )
  ).rejects.toMatchObject({ code: "Parse" });
  await expect(
    collectSource(
      bodySource([
        {
          event: { contentType: "hologram", type: "content_end" },
          type: "agent_event",
        },
      ]),
      true
    )
  ).rejects.toMatchObject({ code: "Parse" });
});

test("nonzero exit after valid output fails loud instead of returning it", async () => {
  const line = JSON.stringify(RESULT_OK);
  const src = spawnAndStream({
    args: ["-c", `printf '%s\\n' '${line}'; exit 1`],
    command: "sh",
  });
  const consume = async (): Promise<void> => {
    for await (const _ of cline().parse(src, { strict: false })) {
      // drain until the nonzero exit rejects
    }
  };
  await expect(consume()).rejects.toMatchObject({ code: "Invocation" });
});
