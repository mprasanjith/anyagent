import { expect, test } from "bun:test";

import { AnyAgentError } from "../src/internal/errors.js";
import { ndjsonParser } from "../src/internal/ndjson.js";
import type { AgentEvent, OutputSource } from "../src/internal/types.js";

const sourceFromLines = (lines: string[], exitCode = 0): OutputSource => ({
  exitCode: Promise.resolve(exitCode),
  async *lines() {
    for (const l of lines) {
      yield l;
    }
  },
  stderr: () => Promise.resolve(""),
  text: () => Promise.resolve(lines.join("\n")),
});

// oxlint-disable-next-line typescript/no-explicit-any -- toy schema.
type Toy = any;

const parse = ndjsonParser<{ text: string[] }>({
  finalize: (ctx) => ({
    events: [],
    raw: null,
    text: ctx.text.join(""),
  }),
  init: () => ({ text: [] }),
  map: (raw: unknown, ctx, strict) => {
    const obj = raw as Toy;
    if (obj.t === "text") {
      ctx.text.push(obj.v);
      return { text: obj.v, type: "text-delta" };
    }
    if (obj.t === "end") {
      return null;
    }
    if (strict) {
      throw new AnyAgentError("Parse", `unknown type ${obj.t}`);
    }
    return null;
  },
});

test("yields events, ends with one done, text == concatenation", async () => {
  const events: AgentEvent[] = [];
  for await (const ev of parse(
    sourceFromLines([
      '{"t":"text","v":"He"}',
      '{"t":"text","v":"llo"}',
      '{"t":"end"}',
    ]),
    { strict: false }
  )) {
    events.push(ev);
  }
  const done = events.filter((e) => e.type === "done");
  expect(done).toHaveLength(1);
  const result = done[0]?.type === "done" ? done[0].result : undefined;
  expect(result?.text).toBe("Hello");
  expect(events.filter((e) => e.type === "text-delta")).toHaveLength(2);
});

test("blank lines ignored; invalid JSON throws Parse", async () => {
  const gen = parse(sourceFromLines(["", "not json"]), { strict: false });
  await expect(gen.next()).rejects.toMatchObject({ code: "Parse" });
});

test("strict mode throws on unknown type", async () => {
  const gen = parse(sourceFromLines(['{"t":"weird"}']), { strict: true });
  await expect(gen.next()).rejects.toMatchObject({ code: "Parse" });
});
