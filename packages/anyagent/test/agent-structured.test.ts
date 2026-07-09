import { expect, test } from "bun:test";

import { AgentImpl } from "../src/internal/agent.js";
import type {
  Adapter,
  Invocation,
  OutputSource,
} from "../src/internal/types.js";
import { fakeStreaming, sourceFromBody } from "./fake-adapter.js";

// A streaming adapter that emulates structured output, carrying the (possibly
// emulated) prompt on the invocation's stdin so tests can inspect it.
const emulated: Adapter = {
  ...fakeStreaming,
  buildInvocation: (prompt) => ({ args: [], command: "fake", input: prompt }),
  capabilities: { ...fakeStreaming.capabilities, structuredOutput: "emulated" },
};

const streamOf = (text: string): string =>
  `${JSON.stringify({ t: "text", v: text })}\n${JSON.stringify({ t: "end" })}`;

// Returns each queued body in turn, recording the prompt of every invocation.
const scriptedRunner =
  (bodies: string[], prompts: string[]) =>
  (inv: Invocation): OutputSource => {
    prompts.push(inv.input ?? "");
    return sourceFromBody(bodies.shift() ?? "");
  };

const objectSchema = {
  properties: { n: { type: "number" } },
  required: ["n"],
  type: "object",
};

test("run() with schema parses and validates on the first try", async () => {
  const prompts: string[] = [];
  const agent = new AgentImpl(
    emulated,
    scriptedRunner([streamOf('{"n":1}')], prompts)
  );
  const res = await agent.run("q", { schema: objectSchema });
  expect(res.json).toEqual({ n: 1 });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("<json-schema>");
});

test("run() with schema retries once, quoting the error and previous reply", async () => {
  const prompts: string[] = [];
  const agent = new AgentImpl(
    emulated,
    scriptedRunner([streamOf('{"n":"bad"}'), streamOf('{"n":2}')], prompts)
  );
  const res = await agent.run("q", { schema: objectSchema });
  expect(res.json).toEqual({ n: 2 });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("$.n: expected number, got string");
  expect(prompts[1]).toContain('{"n":"bad"}');
});

test("run() with schema throws Parse when the retry also fails", async () => {
  const prompts: string[] = [];
  const agent = new AgentImpl(
    emulated,
    scriptedRunner(
      [streamOf('{"n":"bad"}'), streamOf('{"n":"still bad"}')],
      prompts
    )
  );
  await expect(agent.run("q", { schema: objectSchema })).rejects.toMatchObject({
    code: "Parse",
    raw: '{"n":"still bad"}',
  });
  expect(prompts).toHaveLength(2);
});

test("runStream with schema yields text events and never a json result", async () => {
  const agent = new AgentImpl(
    emulated,
    scriptedRunner([streamOf('{"n":1}')], [])
  );
  const types: string[] = [];
  let json: unknown;
  for await (const ev of agent.runStream("q", { schema: objectSchema })) {
    types.push(ev.type);
    if (ev.type === "done") {
      ({ json } = ev.result);
    }
  }
  expect(types).toContain("text-delta");
  expect(json).toBeUndefined();
});

test("raw.buildInvocation does not emulate an emulated capability", () => {
  const systemEmulated: Adapter = {
    ...fakeStreaming,
    buildInvocation: (prompt) => ({ args: ["-p", prompt], command: "fake" }),
    capabilities: { ...fakeStreaming.capabilities, systemPrompt: "emulated" },
  };
  const agent = new AgentImpl(systemEmulated);
  const inv = agent.raw.buildInvocation("hi", { systemPrompt: "secret" });
  expect(JSON.stringify(inv)).not.toContain("secret");
  expect(JSON.stringify(inv)).not.toContain("system-instructions");
  expect(inv.args).toEqual(["-p", "hi"]);
});
