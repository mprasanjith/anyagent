import { expect, test } from "bun:test";

import type { AnyAgentError } from "../src/errors.js";
import { AgentImpl } from "../src/internal/agent.js";
import type {
  Adapter,
  AgentEvent,
  Invocation,
  OutputSource,
} from "../src/types.js";
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
  const agent = new AgentImpl(emulated, {
    runner: scriptedRunner([streamOf('{"n":1}')], prompts),
  });
  const res = await agent.run("q", { schema: objectSchema });
  expect(res.json).toEqual({ n: 1 });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("<json-schema>");
});

test("run() with schema retries once, quoting the error and previous reply", async () => {
  const prompts: string[] = [];
  const agent = new AgentImpl(emulated, {
    runner: scriptedRunner(
      [streamOf('{"n":"bad"}'), streamOf('{"n":2}')],
      prompts
    ),
  });
  const res = await agent.run("q", { schema: objectSchema });
  expect(res.json).toEqual({ n: 2 });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("$.n: expected number, got string");
  expect(prompts[1]).toContain('{"n":"bad"}');
});

test("run() with schema throws Parse when the retry also fails", async () => {
  const prompts: string[] = [];
  const agent = new AgentImpl(emulated, {
    runner: scriptedRunner(
      [streamOf('{"n":"bad"}'), streamOf('{"n":"still bad"}')],
      prompts
    ),
  });
  const failure = await agent
    .run("q", { schema: objectSchema })
    .catch((e: unknown) => e as AnyAgentError);
  expect(failure).toMatchObject({ code: "Parse", raw: '{"n":"still bad"}' });
  expect((failure as AnyAgentError).issues?.length).toBeGreaterThan(0);
  expect(prompts).toHaveLength(2);
});

test("schemaRetries: 0 fails on the first bad reply without a second attempt", async () => {
  const prompts: string[] = [];
  const agent = new AgentImpl(emulated, {
    runner: scriptedRunner(
      [streamOf('{"n":"bad"}'), streamOf('{"n":2}')],
      prompts
    ),
  });
  const failure = await agent
    .run("q", { schema: objectSchema, schemaRetries: 0 })
    .catch((e: unknown) => e as AnyAgentError);
  expect(failure).toMatchObject({ code: "Parse", raw: '{"n":"bad"}' });
  const { issues } = failure as AnyAgentError;
  expect(Array.isArray(issues)).toBe(true);
  expect(issues?.length).toBeGreaterThan(0);
  expect(issues?.every((i) => typeof i === "string")).toBe(true);
  expect(prompts).toHaveLength(1);
});

test("a schema retry is announced between the two attempts' events", async () => {
  const agent = new AgentImpl(emulated, {
    runner: scriptedRunner([streamOf('{"n":"bad"}'), streamOf('{"n":2}')], []),
  });
  const run = agent.run("q", { schema: objectSchema });
  const events: AgentEvent[] = [];
  for await (const ev of run) {
    events.push(ev);
  }
  const boundary = events.findIndex((e) => e.type === "schema-retry");
  const retries = events.filter((e) => e.type === "schema-retry");
  expect(retries).toHaveLength(1);
  expect(retries[0]?.type === "schema-retry" && retries[0].issues).toEqual([
    "$.n: expected number, got string",
  ]);
  const deltas = events.flatMap((e, i) =>
    e.type === "text-delta" ? [{ i, text: e.text }] : []
  );
  const textBefore = deltas.filter((d) => d.i < boundary).map((d) => d.text);
  const textAfter = deltas.filter((d) => d.i > boundary).map((d) => d.text);
  expect(textBefore.join("")).toBe('{"n":"bad"}');
  expect(textAfter.join("")).toBe('{"n":2}');
  expect((await run).json).toEqual({ n: 2 });
});

test("schemaRetries without schema throws InvalidOptions before spawning", async () => {
  const prompts: string[] = [];
  const agent = new AgentImpl(emulated, {
    runner: scriptedRunner([], prompts),
  });
  await expect(agent.run("q", { schemaRetries: 0 })).rejects.toMatchObject({
    code: "InvalidOptions",
  });
  expect(prompts).toHaveLength(0);
});

// A native-structured adapter: the payload arrives on its own channel while
// the text may be prose, as claude-code behaves under --json-schema.
const native: Adapter = {
  ...fakeStreaming,
  buildInvocation: (prompt) => ({ args: [], command: "fake", input: prompt }),
};

const structuredStream = (prose: string, payload: unknown): string =>
  [
    JSON.stringify({ t: "text", v: prose }),
    JSON.stringify({ t: "structured", v: payload }),
    JSON.stringify({ t: "end" }),
  ].join("\n");

test("a native payload wins over streamed prose; the prompt stays bare", async () => {
  const prompts: string[] = [];
  const agent = new AgentImpl(native, {
    runner: scriptedRunner(
      [structuredStream("Sure, on it.", { n: 1 })],
      prompts
    ),
  });
  const res = await agent.run("q", { schema: objectSchema });
  expect(res.json).toEqual({ n: 1 });
  expect(res.text).toBe("Sure, on it.");
  expect(res.structuredOutput).toEqual({ n: 1 });
  expect(prompts[0]).not.toContain("<json-schema>");
});

test("an invalid native payload retries, quoting the payload not the prose", async () => {
  const prompts: string[] = [];
  const agent = new AgentImpl(native, {
    runner: scriptedRunner(
      [
        structuredStream("Working on it.", { n: "bad" }),
        structuredStream("Fixed.", { n: 2 }),
      ],
      prompts
    ),
  });
  const res = await agent.run("q", { schema: objectSchema });
  expect(res.json).toEqual({ n: 2 });
  expect(prompts[1]).toContain("$.n: expected number, got string");
  expect(prompts[1]).toContain('{"n":"bad"}');
  expect(prompts[1]).not.toContain("Working on it.");
});

test("schemaRetries: 0 with an invalid native payload throws it as the reply", async () => {
  const agent = new AgentImpl(native, {
    runner: scriptedRunner([structuredStream("Hmm.", { n: "bad" })], []),
  });
  const failure = await agent
    .run("q", { schema: objectSchema, schemaRetries: 0 })
    .catch((e: unknown) => e as AnyAgentError);
  expect(failure).toMatchObject({ code: "Parse", raw: '{"n":"bad"}' });
  expect((failure as AnyAgentError).issues?.length).toBeGreaterThan(0);
});

test("iterating a schema run yields text events and a done carrying the parsed json", async () => {
  const agent = new AgentImpl(emulated, {
    runner: scriptedRunner([streamOf('{"n":1}')], []),
  });
  const types: string[] = [];
  let json: unknown;
  for await (const ev of agent.run("q", { schema: objectSchema })) {
    types.push(ev.type);
    if (ev.type === "done") {
      ({ json } = ev.result);
    }
  }
  expect(types).toContain("text-delta");
  expect(types.filter((t) => t === "done")).toHaveLength(1);
  expect(json).toEqual({ n: 1 });
});
