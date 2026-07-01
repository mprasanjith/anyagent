import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { claudeCode } from "../src/claude-code/index.js";
import type {
  AgentEvent,
  OutputSource,
  PermissionLevel,
  RunResult,
} from "../src/internal/types.js";

const fixtureSource = (name: string): OutputSource => {
  const body = readFileSync(
    path.join(import.meta.dir, "fixtures/claude-code", name),
    "utf-8"
  );
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

const collect = async (
  name: string
): Promise<{ events: AgentEvent[]; result: RunResult }> => {
  const events: AgentEvent[] = [];
  for await (const ev of claudeCode().parse(fixtureSource(name), {
    strict: false,
  })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === "done");
  const result =
    done?.type === "done"
      ? done.result
      : { events: [], exitCode: 0, raw: null, text: "" };
  return { events, result };
};

const modeOf = (p: PermissionLevel): string | undefined => {
  const a = claudeCode().buildInvocation("x", { permission: p }).args;
  return a[a.indexOf("--permission-mode") + 1];
};

test("buildInvocation maps prompt, stream-json, and edit permission by default", () => {
  const inv = claudeCode().buildInvocation("hi", { permission: "edit" });
  expect(inv.command).toBe("claude");
  expect(inv.args).toContain("-p");
  expect(inv.args).toContain("hi");
  expect(inv.args).toContain("--output-format");
  expect(inv.args).toContain("stream-json");
  expect(inv.args).toContain("acceptEdits");
});

test("permission levels map to native modes", () => {
  expect(modeOf("read-only")).toBe("default");
  expect(modeOf("edit")).toBe("acceptEdits");
  expect(modeOf("full-auto")).toBe("bypassPermissions");
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

const drainStrict = async (name: string): Promise<void> => {
  for await (const _ of claudeCode().parse(fixtureSource(name), {
    strict: true,
  })) {
    // drain; a strict-mode Parse error would reject here
  }
};

test("strict mode tolerates real system/thinking/rate_limit shapes", async () => {
  await expect(
    Promise.all(["simple.jsonl", "tools.jsonl"].map(drainStrict))
  ).resolves.toBeDefined();
});
