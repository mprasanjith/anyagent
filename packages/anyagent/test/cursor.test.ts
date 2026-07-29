import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { runConformance } from "../src/conformance.js";
import { cursor } from "../src/cursor.js";
import type { SessionOptions } from "../src/types.js";
import { fakeSystemProbe } from "./fake-adapter.js";

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dir, "fixtures/cursor", name), "utf-8");

const transcript = readFileSync(
  path.join(import.meta.dir, "fixtures/acp/cursor.jsonl"),
  "utf-8"
);

const settingsOf = (opts: SessionOptions) => cursor().acp.settings?.(opts);

test("cursor drives its CLI over the acp endpoint", () => {
  const adapter = cursor();
  expect(adapter.mode).toBe("acp");
  expect(adapter.acp.command).toEqual(["agent", "acp"]);
  expect("parse" in adapter).toBe(false);
  expect("buildInvocation" in adapter).toBe(false);
});

test("readOnly is the enforced plan mode config option", () => {
  const adapter = cursor();
  expect(adapter.capabilities.readOnly).toBe("native");
  expect(adapter.acp.readOnly).toEqual({ configId: "mode", value: "plan" });
});

test("model becomes the model config option, bracket overrides included", () => {
  const bracketed = "claude-opus-4-8[context=1m,effort=high,fast=false]";
  expect(settingsOf({ model: bracketed })).toEqual({
    configOptions: [{ configId: "model", value: bracketed }],
  });
});

test("a session without model or effort sets no config option", () => {
  expect(settingsOf({})).toEqual({ configOptions: [] });
});

test("effort compiles into the model's bracket overrides", () => {
  expect(settingsOf({ effort: "high", model: "m" })).toEqual({
    configOptions: [{ configId: "model", value: "m[effort=high]" }],
  });
});

test("effort merges into caller-supplied brackets by appending", () => {
  expect(settingsOf({ effort: "high", model: "m[context=1m]" })).toEqual({
    configOptions: [{ configId: "model", value: "m[context=1m,effort=high]" }],
  });
});

test("effort without model throws InvalidOptions before anything spawns", () => {
  expect(() => settingsOf({ effort: "high" })).toThrow(
    expect.objectContaining({ code: "InvalidOptions" })
  );
});

test("authStatus reads `agent status --format json`: isAuthenticated wins", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          isAuthenticated: true,
          status: "authenticated",
          userInfo: { email: "user@example.com" },
        }),
      }),
  });
  const status = await cursor().authStatus?.(probe);
  expect(status).toEqual({ billing: "subscription", state: "authenticated" });
});

test("authStatus maps isAuthenticated false to unauthenticated", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ isAuthenticated: false }),
      }),
  });
  const status = await cursor().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus maps a nonzero non-JSON exit to unauthenticated", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({ code: 1, stderr: "not logged in", stdout: "" }),
  });
  const status = await cursor().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus reports unknown on a clean exit without JSON", async () => {
  const probe = fakeSystemProbe({
    exec: () => Promise.resolve({ code: 0, stderr: "", stdout: "plain text" }),
  });
  const status = await cursor().authStatus?.(probe);
  expect(status?.state).toBe("unknown");
});

test("authStatus reports unknown when the CLI cannot be executed", async () => {
  const probe = fakeSystemProbe({
    exec: () => Promise.reject(new Error("spawn ENOENT")),
  });
  const status = await cursor().authStatus?.(probe);
  expect(status?.state).toBe("unknown");
});

test("listModels parses `agent --list-models` into verbatim ids", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: fixture("list-models.txt"),
      }),
  });
  const models = await cursor().listModels?.(probe);
  expect(models?.length).toBeGreaterThan(0);
  const ids = models?.map((m) => m.id) ?? [];
  expect(ids).toContain("auto");
  expect(ids).toContain("gpt-5.3-codex-low");
  // The header and the trailing tip line are not models.
  expect(ids).not.toContain("Available");
  expect(ids).not.toContain("Tip:");
});

test("listModels throws Invocation when the CLI fails", async () => {
  const failing = fakeSystemProbe({
    exec: () => Promise.resolve({ code: 1, stderr: "boom", stdout: "" }),
  });
  await expect(cursor().listModels?.(failing)).rejects.toMatchObject({
    code: "Invocation",
  });
  const missing = fakeSystemProbe({
    exec: () => Promise.reject(new Error("spawn ENOENT")),
  });
  await expect(cursor().listModels?.(missing)).rejects.toMatchObject({
    code: "Invocation",
  });
});

test("listModels throws Parse when no model lines are found", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({ code: 0, stderr: "", stdout: "nothing useful here" }),
  });
  await expect(cursor().listModels?.(probe)).rejects.toMatchObject({
    code: "Parse",
  });
});

test("cursor passes the adapter conformance suite", async () => {
  await runConformance(cursor(), {
    transcripts: { recorded: transcript },
  });
});
