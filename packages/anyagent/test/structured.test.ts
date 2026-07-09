import { expect, test } from "bun:test";

import {
  extractJson,
  validateAgainstSchema,
} from "../src/internal/structured.js";

test("extractJson parses bare JSON", () => {
  expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  expect(extractJson("  [1, 2, 3] ")).toEqual([1, 2, 3]);
});

test("extractJson parses a fenced code block", () => {
  const text = 'Here you go:\n```json\n{"ok": true}\n```';
  expect(extractJson(text)).toEqual({ ok: true });
});

test("extractJson parses JSON embedded in surrounding prose", () => {
  const text = 'The answer is {"n": 42} as requested.';
  expect(extractJson(text)).toEqual({ n: 42 });
});

test("extractJson throws on garbage", () => {
  expect(() => extractJson("no json here at all")).toThrow();
});

test("validateAgainstSchema accepts a valid type", () => {
  expect(validateAgainstSchema("hi", { type: "string" })).toEqual([]);
});

test("validateAgainstSchema reports a type mismatch with a path", () => {
  const errors = validateAgainstSchema(5, { type: "string" });
  expect(errors).toEqual(["$: expected string, got number"]);
});

test("validateAgainstSchema reports a missing required property", () => {
  const schema = {
    properties: { name: { type: "string" } },
    required: ["name"],
    type: "object",
  };
  expect(validateAgainstSchema({}, schema)).toEqual(["$.name: required"]);
});

test("validateAgainstSchema validates nested properties with a path", () => {
  const schema = {
    properties: {
      user: {
        properties: { name: { type: "string" } },
        type: "object",
      },
    },
    type: "object",
  };
  const errors = validateAgainstSchema({ user: { name: 7 } }, schema);
  expect(errors).toEqual(["$.user.name: expected string, got number"]);
});

test("validateAgainstSchema validates array items with an index path", () => {
  const schema = { items: { type: "number" }, type: "array" };
  const errors = validateAgainstSchema([1, "two", 3], schema);
  expect(errors).toEqual(["$[1]: expected number, got string"]);
});

test("validateAgainstSchema enforces enum", () => {
  const schema = { enum: ["a", "b"] };
  expect(validateAgainstSchema("a", schema)).toEqual([]);
  expect(validateAgainstSchema("c", schema)).toEqual(["$: value not in enum"]);
});

test("validateAgainstSchema distinguishes integer from number", () => {
  expect(validateAgainstSchema(3, { type: "integer" })).toEqual([]);
  expect(validateAgainstSchema(3.5, { type: "integer" })).toEqual([
    "$: expected integer, got number",
  ]);
  expect(validateAgainstSchema(3.5, { type: "number" })).toEqual([]);
});
