import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { cline } from "../src/cline.js";
import { runConformance } from "../src/conformance.js";
import { create } from "../src/index.js";
import type { SystemProbe } from "../src/types.js";
import { fakeSystemProbe } from "./fake-adapter.js";

const HOME_PROVIDERS = "/home/fake/.cline/data/settings/providers.json";

const providersBody = (...names: string[]): string =>
  JSON.stringify({
    providers: Object.fromEntries(names.map((n) => [n, { settings: {} }])),
    version: 1,
  });

const authWith = (
  overrides: Partial<SystemProbe>
): ReturnType<ReturnType<typeof create>["authStatus"]> =>
  create(cline(), { probe: fakeSystemProbe(overrides) }).authStatus();

test("authStatus falls back to the providers file under the home directory", async () => {
  const status = await authWith({
    readFile: (p) =>
      Promise.resolve(
        p === HOME_PROVIDERS ? providersBody("openrouter") : undefined
      ),
  });
  expect(status.state).toBe("authenticated");
  expect(status.providers).toEqual(["openrouter"]);
});

test("authStatus honors CLINE_PROVIDER_SETTINGS_PATH as the exact file", async () => {
  const status = await authWith({
    env: { CLINE_PROVIDER_SETTINGS_PATH: "/elsewhere/prov.json" },
    readFile: (p) =>
      Promise.resolve(
        p === "/elsewhere/prov.json" ? providersBody("anthropic") : undefined
      ),
  });
  expect(status.state).toBe("authenticated");
  expect(status.providers).toEqual(["anthropic"]);
});

test("authStatus resolves CLINE_DATA_DIR without the data/ level", async () => {
  const status = await authWith({
    env: { CLINE_DATA_DIR: "/data-dir" },
    readFile: (p) =>
      Promise.resolve(
        p === "/data-dir/settings/providers.json"
          ? providersBody("openai")
          : undefined
      ),
  });
  expect(status.state).toBe("authenticated");
  expect(status.providers).toEqual(["openai"]);
});

test("authStatus resolves CLINE_DIR with the data/ level", async () => {
  const status = await authWith({
    env: { CLINE_DIR: "/cline-dir" },
    readFile: (p) =>
      Promise.resolve(
        p === "/cline-dir/data/settings/providers.json"
          ? providersBody("gemini")
          : undefined
      ),
  });
  expect(status.state).toBe("authenticated");
  expect(status.providers).toEqual(["gemini"]);
});

test("authStatus prefers the exact-file env var when every candidate exists", async () => {
  const byPath: Record<string, string> = {
    "/cline-dir/data/settings/providers.json": providersBody("gemini"),
    "/data-dir/settings/providers.json": providersBody("openai"),
    "/exact/prov.json": providersBody("anthropic"),
    [HOME_PROVIDERS]: providersBody("openrouter"),
  };
  const status = await authWith({
    env: {
      CLINE_DATA_DIR: "/data-dir",
      CLINE_DIR: "/cline-dir",
      CLINE_PROVIDER_SETTINGS_PATH: "/exact/prov.json",
    },
    readFile: (p) => Promise.resolve(byPath[p]),
  });
  expect(status.providers).toEqual(["anthropic"]);
});

test("authStatus consults every candidate in precedence order and falls through to the last", async () => {
  const asked: string[] = [];
  const status = await authWith({
    env: {
      CLINE_DATA_DIR: "/data-dir",
      CLINE_DIR: "/cline-dir",
      CLINE_PROVIDER_SETTINGS_PATH: "/exact/prov.json",
    },
    readFile: (p) => {
      asked.push(p);
      return Promise.resolve(
        p === HOME_PROVIDERS ? providersBody("cline") : undefined
      );
    },
  });
  expect(asked).toEqual([
    "/exact/prov.json",
    "/data-dir/settings/providers.json",
    "/cline-dir/data/settings/providers.json",
    HOME_PROVIDERS,
  ]);
  expect(status.state).toBe("authenticated");
  expect(status.providers).toEqual(["cline"]);
});

test("authStatus is unauthenticated on a providers file with no providers", async () => {
  const status = await authWith({
    readFile: (p) =>
      Promise.resolve(p === HOME_PROVIDERS ? providersBody() : undefined),
  });
  expect(status.state).toBe("unauthenticated");
});

test("authStatus is unauthenticated when no providers file exists", async () => {
  const status = await authWith({});
  expect(status.state).toBe("unauthenticated");
});

test("authStatus is unknown on unparseable JSON", async () => {
  const status = await authWith({
    readFile: (p) =>
      Promise.resolve(p === HOME_PROVIDERS ? "{not json" : undefined),
  });
  expect(status).toEqual({ billing: "unknown", state: "unknown" });
});

test("cline drives its CLI over the acp endpoint", () => {
  const adapter = cline();
  expect(adapter.mode).toBe("acp");
  expect(adapter.acp.command).toEqual(["cline", "--acp"]);
  expect(adapter.capabilities.sessionFork).toBe(false);
  expect(adapter.capabilities.resume).toBe("native");
});

test("readOnly rests on permission denial, not a mode option", () => {
  const adapter = cline();
  expect(adapter.capabilities.readOnly).toBe("emulated");
  // Plan mode still runs shell commands, so no config option may claim it.
  expect(adapter.acp.readOnly).toBeUndefined();
});

test("acp settings carry the session's model", () => {
  const { settings } = cline().acp;
  expect(settings?.({ model: "gpt-5.4-mini" })).toEqual({
    configOptions: [{ configId: "model", value: "gpt-5.4-mini" }],
  });
  expect(settings?.({})).toEqual({ configOptions: [] });
});

test("the endpoint has no effort channel, so a session refuses it", () => {
  expect(() => create(cline()).session({ effort: "high" })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});

test("conformance holds over the recorded transcript", async () => {
  await runConformance(cline(), {
    transcripts: {
      recorded: readFileSync(
        path.join(import.meta.dir, "fixtures/acp/cline.jsonl"),
        "utf-8"
      ),
    },
  });
});
