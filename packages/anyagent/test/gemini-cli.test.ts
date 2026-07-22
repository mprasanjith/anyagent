import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { runConformance } from "../src/conformance.js";
import { geminiCli } from "../src/gemini-cli.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import type { AgentEvent, OutputSource, RunResult } from "../src/types.js";
import { fakeSystemProbe, sourceFromBody } from "./fake-adapter.js";

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const fixture = (name: string): string =>
  readFileSync(
    path.join(import.meta.dir, "fixtures/gemini-cli", name),
    "utf-8"
  );

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(fixture(name));

const collectSource = async (
  src: OutputSource,
  strict = false
): Promise<{ events: AgentEvent[]; result?: RunResult }> => {
  const events: AgentEvent[] = [];
  for await (const ev of geminiCli().parse(src, { strict })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === "done");
  return { events, result: done?.type === "done" ? done.result : undefined };
};

const collect = (name: string) => collectSource(fixtureSource(name));

const argAfter = (args: string[], flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];

test("buildInvocation defaults to yolo with the trust bypass always present", () => {
  const inv = geminiCli().buildInvocation("hi there", {});
  expect(inv.command).toBe("gemini");
  // An untrusted cwd exits 55; every run must carry the bypass.
  expect(inv.args).toContain("--skip-trust");
  expect(argAfter(inv.args, "--output-format")).toBe("stream-json");
  expect(argAfter(inv.args, "--approval-mode")).toBe("yolo");
  // The prompt travels on stdin; -p stays empty so argv never carries it.
  expect(argAfter(inv.args, "-p")).toBe("");
  expect(inv.input).toBe("hi there");
  expect(inv.args).not.toContain("hi there");
});

test("readOnly maps to the default approval mode, whose toolset has no writers", () => {
  const ro = geminiCli().buildInvocation("x", { readOnly: true });
  expect(argAfter(ro.args, "--approval-mode")).toBe("default");
  // Plan mode is escapable headless (exit_plan_mode self-approves), so it
  // must never be what readOnly ships.
  expect(ro.args).not.toContain("plan");
  expect(
    argAfter(
      geminiCli().buildInvocation("x", { readOnly: false }).args,
      "--approval-mode"
    )
  ).toBe("yolo");
});

test("buildInvocation emits model and resume flags and passes cwd/env", () => {
  const inv = geminiCli().buildInvocation("hi", {
    cwd: "/work",
    env: { FOO: "bar" },
    model: "gemini-3.5-flash-lite",
    resume: "b8ccfef8-35fd-4460-b23a-ec9aa8622127",
  });
  expect(argAfter(inv.args, "-m")).toBe("gemini-3.5-flash-lite");
  expect(argAfter(inv.args, "--resume")).toBe(
    "b8ccfef8-35fd-4460-b23a-ec9aa8622127"
  );
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
});

test("the model is never defaulted: no -m without an explicit choice", () => {
  // Gemini's automatic routing can spend minutes on trivial prompts, so the
  // adapter must pass through exactly what the caller chose — or nothing.
  expect(geminiCli().buildInvocation("x", {}).args).not.toContain("-m");
});

test("parses a simple answer with usage including cached tokens", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result?.text).toBe("pong");
  expect(result?.usage?.inputTokens).toBe(11_584);
  expect(result?.usage?.outputTokens).toBe(1);
  // `cached` from the stats block lands on cacheReadTokens.
  expect(result?.usage?.cacheReadTokens).toBe(0);
  expect(events.at(-1)?.type).toBe("done");
});

test("init yields one session event whose id lands on result.sessionId", async () => {
  const { events, result } = await collect("simple.jsonl");
  const sessions = events.filter((e) => e.type === "session");
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.type === "session" && sessions[0].sessionId).toBe(
    "b8ccfef8-35fd-4460-b23a-ec9aa8622127"
  );
  expect(result?.sessionId).toBe("b8ccfef8-35fd-4460-b23a-ec9aa8622127");
});

test("the user-message echo of the prompt emits no event", async () => {
  const { events } = await collect("simple.jsonl");
  const deltas = events.filter((e) => e.type === "text-delta");
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.type === "text-delta" && deltas[0].text).toBe("pong");
});

test("text concatenates across assistant deltas", async () => {
  const { events, result } = await collect("tools.jsonl");
  expect(result?.text).toBe("petrichor");
  const deltas = events.filter((e) => e.type === "text-delta");
  expect(deltas.length).toBeGreaterThan(1);
});

test("tool_use/tool_result carry normalized name, native name, and callId", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find(
    (e) => e.type === "tool-call" && e.nativeName === "read_file"
  );
  const res = events.find(
    (e) => e.type === "tool-result" && e.nativeName === "read_file"
  );
  expect(call?.type === "tool-call" && call.name).toBe("read");
  expect(call?.type === "tool-call" && call.callId).toBe("read_file__WEsuhfEe");
  expect(res?.type === "tool-result" && res.name).toBe("read");
  // tool_result carries no tool_name; the id pairing recovers it.
  expect(res?.type === "tool-result" && res.callId).toBe("read_file__WEsuhfEe");
});

test("a tool outside the shared vocabulary keeps its native name as name", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find(
    (e) => e.type === "tool-call" && e.nativeName === "update_topic"
  );
  expect(call?.type === "tool-call" && call.name).toBe("update_topic");
});

test("readonly mode's unregistered-tool refusals still parse as a clean run", async () => {
  const { events, result } = await collect("readonly.jsonl");
  // write_file and run_shell_command fail with tool_not_registered; the run
  // itself completes and the refusals surface as tool-result events.
  const results = events.filter((e) => e.type === "tool-result");
  expect(results.length).toBeGreaterThanOrEqual(2);
  expect(result?.text).toContain("unable to create the file");
});

test("a result with status error throws Invocation with the agent's message", async () => {
  await expect(collect("error.jsonl")).rejects.toMatchObject({
    code: "Invocation",
    message: expect.stringContaining("API Error"),
  });
});

test("strict mode tolerates every recorded real-output shape", async () => {
  await expect(
    Promise.all(
      ["simple.jsonl", "tools.jsonl", "readonly.jsonl"].map((f) =>
        collectSource(fixtureSource(f), true)
      )
    )
  ).resolves.toHaveLength(3);
});

test("strict mode throws on an unknown top-level event type", async () => {
  await expect(
    collectSource(bodySource([{ type: "mystery" }]), true)
  ).rejects.toMatchObject({
    code: "Parse",
    message: expect.stringContaining("mystery"),
  });
});

test("strict mode throws on an unknown message role", async () => {
  await expect(
    collectSource(
      bodySource([{ content: "x", role: "narrator", type: "message" }]),
      true
    )
  ).rejects.toMatchObject({ code: "Parse" });
});

test("a tool_result with an unseen tool_id falls back to name 'unknown'", async () => {
  const { events } = await collectSource(
    bodySource([
      {
        output: "x",
        status: "success",
        tool_id: "never-seen",
        type: "tool_result",
      },
      {
        stats: { cached: 0, input_tokens: 1, output_tokens: 1 },
        status: "success",
        type: "result",
      },
    ])
  );
  const res = events.find((e) => e.type === "tool-result");
  expect(res?.type === "tool-result" && res.name).toBe("unknown");
  expect(res?.type === "tool-result" && res.nativeName).toBe("unknown");
});

test("a result without stats yields no usage event and leaves usage undefined", async () => {
  const { events, result } = await collectSource(
    bodySource([{ status: "success", type: "result" }])
  );
  expect(result?.usage).toBeUndefined();
  expect(events.some((e) => e.type === "usage")).toBe(false);
});

test("authStatus: oauth_creds.json means authenticated via oauth", async () => {
  const probe = fakeSystemProbe({
    readFile: (p) =>
      Promise.resolve(
        p === "/home/fake/.gemini/oauth_creds.json" ? "{}" : undefined
      ),
  });
  const status = await geminiCli().authStatus?.(probe);
  expect(status?.state).toBe("authenticated");
  expect(status?.method).toBe("oauth");
});

test("authStatus: GEMINI_API_KEY or GOOGLE_API_KEY means authenticated", async () => {
  const gemini = await geminiCli().authStatus?.(
    fakeSystemProbe({ env: { GEMINI_API_KEY: "k" } })
  );
  const google = await geminiCli().authStatus?.(
    fakeSystemProbe({ env: { GOOGLE_API_KEY: "k" } })
  );
  expect(gemini?.state).toBe("authenticated");
  expect(gemini?.method).toBe("api-key");
  expect(google?.state).toBe("authenticated");
});

test("authStatus: a selected auth type without visible creds is unknown", async () => {
  // Keys can live in the OS keychain or a CLI-discovered .env file the
  // probe cannot see; a configured auth type must not read as a denial.
  const probe = fakeSystemProbe({
    readFile: (p) =>
      Promise.resolve(
        p === "/home/fake/.gemini/settings.json"
          ? JSON.stringify({
              security: { auth: { selectedType: "gemini-api-key" } },
            })
          : undefined
      ),
  });
  const status = await geminiCli().authStatus?.(probe);
  expect(status?.state).toBe("unknown");
  expect(status?.method).toBe("gemini-api-key");
});

test("authStatus: a bare machine is unauthenticated", async () => {
  const status = await geminiCli().authStatus?.(fakeSystemProbe());
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus: a corrupt settings.json still reads as unauthenticated", async () => {
  const probe = fakeSystemProbe({
    readFile: (p) =>
      Promise.resolve(
        p === "/home/fake/.gemini/settings.json" ? "not json" : undefined
      ),
  });
  const status = await geminiCli().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("conformance passes over all recorded fixtures", async () => {
  await runConformance(geminiCli(), {
    fixtures: {
      readonly: fixture("readonly.jsonl"),
      simple: fixture("simple.jsonl"),
      tools: fixture("tools.jsonl"),
    },
  });
});

test("nonzero exit after valid output fails loud instead of returning it", async () => {
  const line = JSON.stringify({
    session_id: "s1",
    type: "init",
  });
  const src = spawnAndStream({
    args: ["-c", `printf '%s\\n' '${line}'; exit 1`],
    command: "sh",
  });
  await expect(collectSource(src)).rejects.toMatchObject({
    code: "Invocation",
  });
});
