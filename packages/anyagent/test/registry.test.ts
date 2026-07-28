import { expect, test } from "bun:test";

import { detect } from "../src/index.js";
import { BUILTINS } from "../src/internal/builtins.js";
import type { Capabilities, VersionProbe } from "../src/types.js";
import { fakeStreaming, fakeText } from "./fake-adapter.js";

const probe: VersionProbe = {
  exec: () => Promise.resolve({ code: 0, stderr: "", stdout: "1.0.0" }),
  which: (b) =>
    Promise.resolve(b === "fake-stream" ? "/usr/bin/fake-stream" : undefined),
};

test("detect returns only the installed adapters with resolved paths", async () => {
  const res = await detect({ adapters: [fakeStreaming, fakeText], probe });
  expect(res.map((r) => r.id)).toEqual(["fake-stream"]);
  expect(res[0]?.path).toBe("/usr/bin/fake-stream");
  expect(res[0]?.adapter).toBe(fakeStreaming);
});

test("detect returns empty when none installed", async () => {
  const none: VersionProbe = {
    exec: () => Promise.resolve({ code: 0, stderr: "", stdout: "" }),
    which: () => Promise.resolve(undefined),
  };
  expect(await detect({ adapters: [fakeStreaming], probe: none })).toEqual([]);
});

const ALL = [
  "claude-code",
  "codex",
  "opencode",
  "kilo-code",
  "pi",
  "goose",
  "cline",
  "gemini-cli",
  "antigravity",
  "cursor",
] as const;

const byId = new Map(BUILTINS.map((a) => [a.meta.id, a]));
const capsOf = (id: string): Capabilities | undefined =>
  byId.get(id)?.capabilities;

test("the registry ships all ten builtin adapters", () => {
  expect([...byId.keys()].sort()).toEqual([...ALL].sort());
});

test("every builtin declares one mode, with an ACP endpoint exactly where it says", () => {
  for (const adapter of BUILTINS) {
    expect(["acp", "stdout"]).toContain(adapter.mode);
    expect("acp" in adapter).toBe(adapter.mode === "acp");
    if (adapter.mode === "acp") {
      expect("parse" in adapter).toBe(false);
      expect("buildInvocation" in adapter).toBe(false);
    }
  }
});

const DISCOVERY: readonly unknown[] = ["native", "probed", false];
const SUPPORT: readonly unknown[] = ["native", "emulated", false];

for (const id of ALL) {
  test(`${id} declares every v2 capability field with a legal value`, () => {
    const caps = capsOf(id);
    expect(DISCOVERY).toContain(caps?.authStatus);
    expect(DISCOVERY).toContain(caps?.modelListing);
    expect(SUPPORT).toContain(caps?.effort);
    expect(SUPPORT).toContain(caps?.readOnly);
  });
}

test("authStatus is declared available on every builtin", () => {
  for (const id of ALL) {
    expect(Boolean(capsOf(id)?.authStatus)).toBe(true);
  }
});

test("readOnly is truthy exactly where a no-writes run is guaranteed", () => {
  for (const id of [
    "claude-code",
    "codex",
    "opencode",
    "kilo-code",
    "pi",
    "gemini-cli",
    "cursor",
    "cline",
    "goose",
  ]) {
    expect(Boolean(capsOf(id)?.readOnly)).toBe(true);
  }
  // antigravity's plan mode leaks writes into its always-allowed scratch dirs
  // (live-verified).
  expect(capsOf("antigravity")?.readOnly).toBe(false);
});

test("modelListing is native exactly where a real list command exists", () => {
  const native = new Set([
    "codex",
    "opencode",
    "kilo-code",
    "pi",
    "antigravity",
    "cursor",
  ]);
  for (const id of ALL) {
    expect(capsOf(id)?.modelListing === "native").toBe(native.has(id));
  }
});
