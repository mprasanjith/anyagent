import { expect, test } from "bun:test";

import { vendorOf } from "../src/internal/vendors.js";

test("a plain vendor prefix resolves to itself", () => {
  expect(vendorOf("anthropic/claude-sonnet-4-5")).toBe("anthropic");
  expect(vendorOf("openai/gpt-4o")).toBe("openai");
});

test("a gateway prefix resolves through to the vendor inside", () => {
  // openrouter bills, openai authored: only the vendor is the join key.
  expect(vendorOf("openrouter/openai/gpt-4o")).toBe("openai");
  // kilo's gateway marks the vendor with a `~` inside its ids.
  expect(vendorOf("kilo/~anthropic/claude-fable-latest")).toBe("anthropic");
});

test("a gateway model with no vendor inside resolves to nothing", () => {
  expect(vendorOf("opencode/big-pickle")).toBeUndefined();
  expect(vendorOf("openrouter/mystery-model")).toBeUndefined();
});

test("an unknown prefix or a bare id asserts nothing", () => {
  expect(vendorOf("acme/some-model")).toBeUndefined();
  expect(vendorOf("gpt-5.6-sol")).toBeUndefined();
});
