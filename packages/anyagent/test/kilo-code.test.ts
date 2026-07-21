import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  AgentEvent,
  OutputSource,
  RunResult,
} from "../src/types.js";
import { kiloCode } from "../src/kilo-code/index.js";
import { sourceFromBody } from "./fake-adapter.js";

// Kilo shares the opencode-family implementation; the shared mapping logic is
// exercised in depth by opencode.test.ts. These tests pin kilo's own identity
// and verify the shared parser against kilo's *own* recorded output, so a
// fork-side format drift cannot hide behind the opencode fixtures.

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(
    readFileSync(
      path.join(import.meta.dir, "fixtures/kilo-code", name),
      "utf-8"
    )
  );

const collect = async (
  name: string,
  strict = false
): Promise<{ events: AgentEvent[]; result?: RunResult }> => {
  const events: AgentEvent[] = [];
  for await (const ev of kiloCode().parse(fixtureSource(name), { strict })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === "done");
  return { events, result: done?.type === "done" ? done.result : undefined };
};

test("meta names the kilo binaries and identity", () => {
  const { meta } = kiloCode();
  expect(meta.id).toBe("kilo-code");
  expect(meta.bin).toEqual(["kilo", "kilocode"]);
});

test("buildInvocation drives the kilo binary with the shared flags", () => {
  const inv = kiloCode().buildInvocation("hi", {
    model: "openrouter/openai/gpt-4o-mini",
    permission: "auto",
    resume: "ses_abc",
  });
  expect(inv.command).toBe("kilo");
  expect(inv.args.slice(0, 3)).toEqual(["run", "--format", "json"]);
  expect(inv.args).toContain("--auto");
  expect(inv.args).toContain("ses_abc");
  expect(inv.input).toBe("hi");
});

test("parses kilo's own simple fixture", async () => {
  const { result } = await collect("simple.jsonl");
  expect(result?.text).toBe("pong");
  expect(typeof result?.usage?.inputTokens).toBe("number");
  const raw = result?.raw as { sessionId?: string };
  expect(raw.sessionId).toMatch(/^ses_/u);
});

test("parses kilo's own tools and edit fixtures", async () => {
  const tools = await collect("tools.jsonl");
  const call = tools.events.find((e) => e.type === "tool-call");
  expect(call?.type === "tool-call" && call.name).toBe("read");

  const edit = await collect("edit.jsonl");
  const write = edit.events.find(
    (e) => e.type === "tool-call" && e.name === "write"
  );
  expect(write).toBeDefined();
});

test("strict mode tolerates every recorded real kilo shape", async () => {
  await expect(
    Promise.all(
      ["simple.jsonl", "tools.jsonl", "edit.jsonl"].map((n) => collect(n, true))
    )
  ).resolves.toHaveLength(3);
});
