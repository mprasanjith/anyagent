import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { cline } from "../src/cline.js";
import { runConformance } from "../src/conformance.js";
import { AnyAgentError } from "../src/errors.js";
import { create } from "../src/index.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import type {
  AgentEvent,
  OutputSource,
  RunResult,
  SystemProbe,
} from "../src/types.js";
import { fakeSystemProbe, sourceFromBody } from "./fake-adapter.js";

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dir, "fixtures/cline", name), "utf-8");

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(fixture(name));

const collectSource = async (
  src: OutputSource,
  strict = false
): Promise<{ events: AgentEvent[]; result?: RunResult }> => {
  const events: AgentEvent[] = [];
  for await (const ev of cline().parse(src, { strict })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === "done");
  return { events, result: done?.type === "done" ? done.result : undefined };
};

const collect = (name: string) => collectSource(fixtureSource(name));

const RESULT_OK = {
  finishReason: "completed",
  text: "",
  type: "run_result",
  usage: { inputTokens: 1, outputTokens: 1, totalCost: 0.1 },
};

test("buildInvocation maps json mode, pinned auto-approve, and the prompt positional", () => {
  const inv = cline().buildInvocation("hi there", {});
  expect(inv.command).toBe("cline");
  expect(inv.args.slice(0, 3)).toEqual(["--json", "--auto-approve", "true"]);
  // cline's headless mode does not read a piped prompt reliably; positional.
  expect(inv.args.at(-1)).toBe("hi there");
  expect(inv.input).toBeUndefined();
});

test("buildInvocation emits the model flag and passes cwd/env", () => {
  const inv = cline().buildInvocation("hi there", {
    cwd: "/work",
    env: { FOO: "bar" },
    model: "openai/gpt-4o-mini",
  });
  const at = (flag: string): string | undefined =>
    inv.args[inv.args.indexOf(flag) + 1];
  expect(at("-m")).toBe("openai/gpt-4o-mini");
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
});

test("effort rides --thinking and is absent when not asked for", () => {
  const inv = cline().buildInvocation("hi there", { effort: "high" });
  expect(inv.args[inv.args.indexOf("--thinking") + 1]).toBe("high");
  expect(cline().buildInvocation("hi there", {}).args).not.toContain(
    "--thinking"
  );
});

test("an effort outside the closed vocabulary throws before spawn", async () => {
  const agent = create(cline());
  await expect(
    agent.run("two words", { effort: "ultra" })
  ).rejects.toMatchObject({ code: "UnsupportedCapability" });
});

test("readOnly: true throws UnsupportedCapability (cline cannot guarantee it)", async () => {
  const agent = create(cline());
  await expect(
    // @ts-expect-error readOnly is a compile error on cline's literal table; this asserts the runtime gate behind it.
    agent.run("two words", { readOnly: true })
  ).rejects.toMatchObject({ code: "UnsupportedCapability" });
});

test("parses a simple text answer with usage from run_result", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result?.text).toBe("pong");
  expect(typeof result?.usage?.inputTokens).toBe("number");
  expect(typeof result?.usage?.outputTokens).toBe("number");
  expect(typeof result?.usage?.costUsd).toBe("number");
  expect(events.at(-1)?.type).toBe("done");
});

test("run_result cache accounting lands on the cache token fields", async () => {
  const { result } = await collect("tools.jsonl");
  expect(result?.usage?.cacheReadTokens).toBe(3584);
  expect(result?.usage?.cacheWriteTokens).toBe(0);
});

test("no session event is emitted and sessionId stays absent", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(events.some((e) => e.type === "session")).toBe(false);
  expect(result?.sessionId).toBeUndefined();
});

test("tool content maps normalized name, native name, and callId", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  if (call?.type !== "tool-call" || res?.type !== "tool-result") {
    throw new Error("expected a tool-call and a tool-result");
  }
  expect(call.name).toBe("read");
  expect(call.nativeName).toBe("read_files");
  expect(typeof call.callId).toBe("string");
  expect(res.name).toBe("read");
  expect(res.nativeName).toBe("read_files");
  expect(res.callId).toBe(call.callId);
});

test("a tool outside the shared vocabulary keeps its native name", async () => {
  const { events } = await collectSource(
    bodySource([
      {
        event: {
          contentType: "tool",
          input: {},
          toolName: "mystery_tool",
          type: "content_start",
        },
        type: "agent_event",
      },
      {
        event: {
          contentType: "tool",
          output: {},
          toolName: "run_commands",
          type: "content_end",
        },
        type: "agent_event",
      },
      RESULT_OK,
    ])
  );
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBe("mystery_tool");
  expect(res?.type === "tool-result" && res.name).toBe("bash");
  expect(res?.type === "tool-result" && res.nativeName).toBe("run_commands");
});

test("the tools fixture's stray plain-text notice is filtered, not fatal", async () => {
  // The recorded stream really contains a non-JSON "AI SDK Warning" line on
  // stdout; parsing it proves the filter works on real output.
  const body = fixture("tools.jsonl");
  expect(body.split("\n").some((l) => l.startsWith("AI SDK Warning"))).toBe(
    true
  );
  const { result } = await collect("tools.jsonl");
  expect(result?.text.toLowerCase()).toContain("petrichor");
});

test("the edit fixture surfaces a file-writing tool as edit", async () => {
  const { events } = await collect("edit.jsonl");
  const calls = events.filter((e) => e.type === "tool-call");
  expect(
    calls.some(
      (e) =>
        e.type === "tool-call" &&
        e.name === "edit" &&
        e.nativeName === "apply_patch"
    )
  ).toBe(true);
});

test("strict mode tolerates every recorded real shape", async () => {
  await expect(
    Promise.all(
      ["simple.jsonl", "tools.jsonl", "edit.jsonl"].map((f) =>
        collectSource(fixtureSource(f), true)
      )
    )
  ).resolves.toHaveLength(3);
});

test("a run_result with finishReason error throws with cline's message", async () => {
  await expect(
    collectSource(
      bodySource([
        {
          finishReason: "error",
          text: "not a valid model ID",
          type: "run_result",
        },
      ])
    )
  ).rejects.toMatchObject({
    code: "Invocation",
    message: expect.stringContaining("not a valid model ID"),
  });
});

test("text deltas come from content_end alone, never double-counted", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        event: { contentType: "text", text: "po", type: "content_delta" },
        type: "agent_event",
      },
      {
        event: { contentType: "text", text: "pong", type: "content_end" },
        type: "agent_event",
      },
      RESULT_OK,
    ])
  );
  expect(result?.text).toBe("pong");
});

test("a run_result without usage leaves usage undefined", async () => {
  const { events, result } = await collectSource(
    bodySource([{ finishReason: "completed", type: "run_result" }])
  );
  expect(result?.usage).toBeUndefined();
  expect(events.some((e) => e.type === "usage")).toBe(false);
});

test("strict mode throws on unknown event and content types", async () => {
  await expect(
    collectSource(bodySource([{ type: "mystery" }]), true)
  ).rejects.toMatchObject({ code: "Parse" });
  await expect(
    collectSource(
      bodySource([{ event: { type: "mystery_event" }, type: "agent_event" }]),
      true
    )
  ).rejects.toMatchObject({ code: "Parse" });
  await expect(
    collectSource(
      bodySource([
        {
          event: { contentType: "hologram", type: "content_end" },
          type: "agent_event",
        },
      ]),
      true
    )
  ).rejects.toMatchObject({ code: "Parse" });
});

test("nonzero exit after valid output fails loud instead of returning it", async () => {
  const line = JSON.stringify(RESULT_OK);
  const src = spawnAndStream({
    args: ["-c", `printf '%s\\n' '${line}'; exit 1`],
    command: "sh",
  });
  await expect(collectSource(src)).rejects.toMatchObject({
    code: "Invocation",
  });
});

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
  expect(status).toEqual({ state: "unknown" });
});

test("a stdout-mode resume throws instead of running without the conversation", () => {
  let thrown: unknown;
  try {
    cline().buildInvocation("hi", { resume: "sess-123" });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(AnyAgentError);
  expect((thrown as AnyAgentError).code).toBe("UnsupportedCapability");
});

test("cline declares ACP-mode sessions over its acp endpoint", () => {
  const adapter = cline();
  expect(adapter.capabilities.session).toBe("acp");
  expect(adapter.acp?.command).toEqual(["cline", "--acp"]);
  // Plan mode is not a read-only guarantee here, so no mode option is declared.
  expect(adapter.acp?.readOnly).toBeUndefined();
  expect(adapter.capabilities.readOnly).toBe(false);
  expect(adapter.capabilities.sessionFork).toBe(false);
});

test("acp settings carry model and refuse effort", () => {
  const settings = cline().acp?.settings;
  expect(settings?.({ model: "gpt-5.4-mini" })).toEqual({
    configOptions: [{ configId: "model", value: "gpt-5.4-mini" }],
  });
  expect(settings?.({})).toEqual({ configOptions: [] });
  expect(() => settings?.({ effort: "high" })).toThrow(
    expect.objectContaining({ code: "UnsupportedCapability" })
  );
});

test("conformance holds over the recorded fixtures", async () => {
  await runConformance(cline(), {
    fixtures: {
      edit: fixture("edit.jsonl"),
      simple: fixture("simple.jsonl"),
      tools: fixture("tools.jsonl"),
    },
  });
});
