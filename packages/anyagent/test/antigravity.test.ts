import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { antigravity } from "../src/antigravity.js";
import { runConformance } from "../src/conformance.js";
import { create } from "../src/index.js";
import type { AgentEvent, OutputSource, RunResult } from "../src/types.js";
import { fakeSystemProbe, sourceFromBody } from "./fake-adapter.js";

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const fixture = (name: string): string =>
  readFileSync(
    path.join(import.meta.dir, "fixtures/antigravity", name),
    "utf-8"
  );

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(fixture(name));

const collectSource = async (
  src: OutputSource,
  strict = false
): Promise<{ events: AgentEvent[]; result?: RunResult }> => {
  const events: AgentEvent[] = [];
  for await (const ev of antigravity().parse(src, { strict })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === "done");
  return { events, result: done?.type === "done" ? done.result : undefined };
};

const collect = async (
  name: string
): Promise<{ events: AgentEvent[]; result: RunResult }> => {
  const { events, result } = await collectSource(fixtureSource(name));
  return { events, result: result ?? { events: [], raw: undefined, text: "" } };
};

const argAfter = (args: string[], flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];

// The result line from a real recorded failure, reshaped to the CANCELED
// status the CLI emits when a headless run self-cancels — with exit 0.
const canceledResult = {
  event: "result",
  result: {
    conversation_id: "c2215dc0-ddd3-42b4-95ea-b9d9dfae8633",
    duration_seconds: 1.2,
    num_turns: 1,
    response: "",
    status: "CANCELED",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      total_tokens: 0,
    },
  },
};

test("buildInvocation defaults: stdout mode, stream-json, permissions skipped", () => {
  const inv = antigravity().buildInvocation("hi", {});
  expect(inv.command).toBe("agy");
  // The prompt is -p's value on argv; agy ignores piped stdin in stdout mode.
  expect(inv.args.slice(0, 2)).toEqual(["-p", "hi"]);
  expect(inv.input).toBeUndefined();
  expect(argAfter(inv.args, "--output-format")).toBe("stream-json");
  expect(inv.args).toContain("--dangerously-skip-permissions");
});

test("model, effort, and resume map to their native flags with cwd/env", () => {
  const inv = antigravity().buildInvocation("hi", {
    cwd: "/work",
    effort: "high",
    env: { FOO: "bar" },
    model: "gemini-3.5-flash-low",
    resume: "conv-1",
  });
  expect(argAfter(inv.args, "--model")).toBe("gemini-3.5-flash-low");
  expect(argAfter(inv.args, "--effort")).toBe("high");
  expect(argAfter(inv.args, "--conversation")).toBe("conv-1");
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
});

test("omitted options emit no model, effort, or conversation flags", () => {
  const inv = antigravity().buildInvocation("hi", {});
  for (const flag of ["--model", "--effort", "--conversation", "--mode"]) {
    expect(inv.args).not.toContain(flag);
  }
});

test("an effort outside the closed vocabulary throws before spawn", async () => {
  const agent = create(antigravity());
  await expect(agent.run("x", { effort: "ultra" })).rejects.toMatchObject({
    code: "UnsupportedCapability",
  });
});

test("readOnly: true throws UnsupportedCapability (plan mode leaks writes)", async () => {
  const agent = create(antigravity());
  await expect(
    // @ts-expect-error readOnly is a compile error on antigravity's literal table; this asserts the runtime gate behind it.
    agent.run("x", { readOnly: true })
  ).rejects.toMatchObject({ code: "UnsupportedCapability" });
});

test("parses a simple text answer with usage including thinking tokens", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result.text).toBe("pong\n");
  // Values are volatile per run; assert the fields are populated, not magnitudes.
  expect(typeof result.usage?.inputTokens).toBe("number");
  expect(typeof result.usage?.outputTokens).toBe("number");
  expect(typeof result.usage?.reasoningTokens).toBe("number");
  expect(events.at(-1)?.type).toBe("done");
});

test("init yields one session event and result.sessionId matches it", async () => {
  const { events, result } = await collect("simple.jsonl");
  const sessions = events.filter((e) => e.type === "session");
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.type === "session" && sessions[0].sessionId).toBe(
    "79f6bdaf-4dce-4bdc-97cb-d0d4e8b61642"
  );
  expect(result.sessionId).toBe("79f6bdaf-4dce-4bdc-97cb-d0d4e8b61642");
  // The session event arrives before any answer text.
  expect(events.findIndex((e) => e.type === "session")).toBeLessThan(
    events.findIndex((e) => e.type === "text-delta")
  );
});

test("tool steps pair ACTIVE/DONE into call/result via step_index", async () => {
  const { events } = await collect("tools.jsonl");
  const calls = events.filter((e) => e.type === "tool-call");
  const results = events.filter((e) => e.type === "tool-result");
  expect(calls.length).toBeGreaterThan(0);
  const [call] = calls;
  expect(call?.type === "tool-call" && call.nativeName).toBe(
    "list_permissions"
  );
  // list_permissions is outside the shared vocabulary; the native name holds.
  expect(call?.type === "tool-call" && call.name).toBe("list_permissions");
  const callId = call?.type === "tool-call" ? call.callId : undefined;
  expect(typeof callId).toBe("string");
  const paired = results.find(
    (e) => e.type === "tool-result" && e.callId === callId
  );
  expect(paired?.type === "tool-result" && String(paired.output)).toContain(
    "permission"
  );
});

test("a denied tool surfaces as an ERROR-state tool-result, not a failure", async () => {
  const { events, result } = await collect("tools.jsonl");
  const denied = events.find(
    (e) => e.type === "tool-result" && e.nativeName === "run_command"
  );
  // run_command normalizes to the shared bash name.
  expect(denied?.type === "tool-result" && denied.name).toBe("bash");
  expect(
    denied?.type === "tool-result" &&
      (denied.output as { message?: string })?.message
  ).toContain("denied");
  // The run still completed: the SUCCESS result is the authority.
  expect(result.text.length).toBeGreaterThan(0);
});

test("a non-SUCCESS result status throws Invocation (real recorded ERROR)", async () => {
  await expect(
    collectSource(fixtureSource("error.jsonl"))
  ).rejects.toMatchObject({
    code: "Invocation",
    message: expect.stringContaining("timeout waiting for response"),
  });
});

test("CANCELED with a clean exit still throws Invocation", async () => {
  // agy exits 0 on a self-canceled run; sourceFromBody replays exit 0, so
  // this asserts the status — not the exit code — decides the outcome.
  await expect(
    collectSource(bodySource([canceledResult]))
  ).rejects.toMatchObject({
    code: "Invocation",
    message: expect.stringContaining("CANCELED"),
  });
});

test("strict mode tolerates every recorded real-output shape", async () => {
  await expect(
    Promise.all(
      ["simple.jsonl", "tools.jsonl"].map((f) =>
        collectSource(fixtureSource(f), true)
      )
    )
  ).resolves.toHaveLength(2);
});

test("strict mode throws on an unknown top-level event", async () => {
  await expect(
    collectSource(bodySource([{ event: "mystery" }]), true)
  ).rejects.toMatchObject({
    code: "Parse",
    message: expect.stringContaining("mystery"),
  });
});

test("strict mode throws on an unknown step type", async () => {
  await expect(
    collectSource(
      bodySource([
        {
          event: "step_update",
          step_update: { state: "DONE", step_index: 1, step_type: "mystery" },
        },
      ]),
      true
    )
  ).rejects.toMatchObject({
    code: "Parse",
    message: expect.stringContaining("mystery"),
  });
});

test("strict mode throws on an unknown tool step state", async () => {
  await expect(
    collectSource(
      bodySource([
        {
          event: "step_update",
          step_update: {
            state: "PAUSED",
            step_index: 1,
            step_type: "tool",
            tool_name: "view_file",
          },
        },
      ]),
      true
    )
  ).rejects.toMatchObject({
    code: "Parse",
    message: expect.stringContaining("PAUSED"),
  });
});

test("text is concatenated across agent_response deltas", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_index: 1,
          step_type: "agent_response",
          text_delta: "foo",
        },
      },
      {
        event: "step_update",
        step_update: {
          state: "DONE",
          step_index: 1,
          step_type: "agent_response",
          text_delta: "bar",
        },
      },
      {
        event: "result",
        result: { conversation_id: "c", response: "foobar", status: "SUCCESS" },
      },
    ])
  );
  expect(result?.text).toBe("foobar");
});

test("a SUCCESS result without usage leaves usage undefined", async () => {
  const { events, result } = await collectSource(
    bodySource([
      {
        event: "result",
        result: { conversation_id: "c", response: "", status: "SUCCESS" },
      },
    ])
  );
  expect(result?.usage).toBeUndefined();
  expect(events.some((e) => e.type === "usage")).toBe(false);
});

test("authStatus asks `agy models`: a model listing is authenticated", async () => {
  const calls: { args: string[]; bin: string }[] = [];
  const probe = fakeSystemProbe({
    exec: (bin, args) => {
      calls.push({ args, bin });
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: fixture("models.txt"),
      });
    },
  });
  const status = await antigravity().authStatus?.(probe);
  expect(status?.state).toBe("authenticated");
  expect(status?.method).toBe("oauth");
  expect(calls).toEqual([{ args: ["models"], bin: "agy" }]);
});

test("authStatus maps a sign-in notice (exit 0) to unauthenticated", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout:
          "Please sign in to use Antigravity: https://example.test/auth\n",
      }),
  });
  const status = await antigravity().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus maps a nonzero exit to unauthenticated", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 1,
        stderr: "Authentication required\n",
        stdout: "",
      }),
  });
  const status = await antigravity().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus reports unknown when the CLI cannot be executed", async () => {
  const probe = fakeSystemProbe({
    exec: () => Promise.reject(new Error("spawn ENOENT")),
  });
  const status = await antigravity().authStatus?.(probe);
  expect(status?.state).toBe("unknown");
});

test("listModels parses `agy models` lines into usable ids", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({ code: 0, stderr: "", stdout: fixture("models.txt") }),
  });
  const models = await antigravity().listModels?.(probe);
  expect(models?.length).toBeGreaterThan(0);
  const ids = models?.map((m) => m.id) ?? [];
  // Cross-vendor catalog: ids are valid verbatim as the --model value.
  expect(ids).toContain("gemini-3.5-flash-low");
  expect(ids).toContain("claude-sonnet-4-6");
  expect(ids.every((id) => !id.includes(" "))).toBe(true);
});

test("listModels throws Invocation when the CLI fails or is missing", async () => {
  const failing = fakeSystemProbe({
    exec: () => Promise.resolve({ code: 1, stderr: "boom", stdout: "" }),
  });
  await expect(antigravity().listModels?.(failing)).rejects.toMatchObject({
    code: "Invocation",
  });
  const missing = fakeSystemProbe({
    exec: () => Promise.reject(new Error("spawn ENOENT")),
  });
  await expect(antigravity().listModels?.(missing)).rejects.toMatchObject({
    code: "Invocation",
  });
});

test("listModels throws Invocation on a sign-in notice instead of fake ids", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout:
          "Please sign in to use Antigravity: https://example.test/auth\n",
      }),
  });
  await expect(antigravity().listModels?.(probe)).rejects.toMatchObject({
    code: "Invocation",
  });
});

test("antigravity passes the adapter conformance suite", async () => {
  await runConformance(antigravity(), {
    fixtures: {
      simple: fixture("simple.jsonl"),
      tools: fixture("tools.jsonl"),
    },
  });
});

// `agy models` prints `<id>\t<display name>`, recorded live 2026-08-25. The
// id was once the whole line, and a parser testing the whole line against the
// id shape matched nothing here — every signed-in user read as signed out.
const MODELS_STDOUT = [
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
].join("\n");

const modelsProbe = (stdout: string) =>
  fakeSystemProbe({
    exec: () => Promise.resolve({ code: 0, stderr: "", stdout }),
  });

test("listModels reads the id out of each tab-separated row", async () => {
  const models = await antigravity().listModels?.(modelsProbe(MODELS_STDOUT));
  expect(models?.map((m) => m.id)).toEqual([
    "gemini-3.1-pro-high",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
  ]);
});

// The older bare-id listing still has to work.
test("listModels still reads a listing with no labels", async () => {
  const models = await antigravity().listModels?.(
    modelsProbe("gemini-3.1-pro-high\nclaude-opus-4-6-thinking")
  );
  expect(models?.map((m) => m.id)).toEqual([
    "gemini-3.1-pro-high",
    "claude-opus-4-6-thinking",
  ]);
});

test("authStatus reads a labelled listing as signed in", async () => {
  const status = await antigravity().authStatus?.(modelsProbe(MODELS_STDOUT));
  expect(status?.state).toBe("authenticated");
});

// A sign-in notice exits 0 and must not read as a listing.
test("authStatus reads a sign-in notice as signed out", async () => {
  const status = await antigravity().authStatus?.(
    modelsProbe("Please sign in at https://antigravity.google to continue")
  );
  expect(status?.state).toBe("unauthenticated");
});

// --- quota from the local language server ---------------------------------

// `RetrieveUserQuotaSummary` as returned live (2026-08-25) by a signed-in
// `agy` on a Pro account: weekly buckets only, and no 5-hour bucket at all.
const QUOTA = {
  response: {
    groups: [
      {
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly Limit Remaining",
            remainingFraction: 1,
            resetTime: "2026-09-01T10:15:40Z",
            window: "weekly",
          },
        ],
        displayName: "Gemini Models",
      },
      {
        buckets: [
          {
            bucketId: "3p-weekly",
            displayName: "Weekly Limit Remaining",
            remainingFraction: 0.25,
            resetTime: "2026-09-01T10:15:40Z",
            window: "weekly",
          },
        ],
        displayName: "Claude and GPT models",
      },
    ],
  },
};

const RPC_PATH =
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";

const quotaProbe = (
  opts: { csrfPorts?: number[]; ports?: number[]; quota?: unknown } = {}
) => {
  const calls: string[] = [];
  const ports = opts.ports ?? [40_001];
  const probe = fakeSystemProbe({
    fetchLocal: (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const port = Number(new URL(url).port);
      if (!url.endsWith(RPC_PATH)) {
        // The desktop app serves a CSRF token at `/`; `agy` 404s here.
        return Promise.resolve(
          opts.csrfPorts?.includes(port)
            ? new Response('<script>{"csrfToken":"tok-1"}</script>')
            : new Response("not found", { status: 404 })
        );
      }
      if (
        opts.csrfPorts?.includes(port) &&
        !init?.headers?.["x-codeium-csrf-token"]
      ) {
        return Promise.resolve(new Response("{}", { status: 403 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(opts.quota ?? QUOTA), { status: 200 })
      );
    },
    localListeners: () => Promise.resolve(ports),
  });
  return { calls, probe };
};

test("usageStatus reads the quota summary off the local server", async () => {
  const { calls, probe } = quotaProbe();
  const status = await antigravity().usageStatus?.(probe, {});
  expect(calls).toEqual([`POST http://127.0.0.1:40001${RPC_PATH}`]);
  expect(status?.state).toBe("ok");
  expect(status?.windows).toEqual([
    {
      label: "gemini-weekly",
      modelScope: "Gemini Models",
      resetsAt: new Date("2026-09-01T10:15:40Z"),
      usedPercent: 0,
      windowMinutes: 10_080,
    },
    {
      label: "3p-weekly",
      modelScope: "Claude and GPT models",
      resetsAt: new Date("2026-09-01T10:15:40Z"),
      usedPercent: 75,
      windowMinutes: 10_080,
    },
  ]);
});

// This account reports weekly buckets and no 5-hour ones. Requiring a fixed
// set would turn a perfectly good answer into no answer.
test("usageStatus does not require any particular bucket", async () => {
  const { probe } = quotaProbe({
    quota: {
      response: {
        groups: [
          {
            buckets: [
              {
                bucketId: "gemini-5h",
                remainingFraction: 0.5,
                resetTime: "2026-08-25T15:00:00Z",
                window: "5h",
              },
            ],
            displayName: "Gemini Models",
          },
        ],
      },
    },
  });
  const status = await antigravity().usageStatus?.(probe, {});
  expect(status?.windows?.map((w) => [w.label, w.windowMinutes])).toEqual([
    ["gemini-5h", 300],
  ]);
});

// Each product binds a TLS listener beside the RPC one, and which draws the
// higher port is not predictable — so every candidate is tried.
test("usageStatus probes past a port that does not answer", async () => {
  const { calls, probe } = quotaProbe({ ports: [40_001, 40_002] });
  const half = fakeSystemProbe({
    fetchLocal: (url, init) =>
      url.includes("40001")
        ? Promise.reject(new Error("TLS listener"))
        : (probe.fetchLocal as NonNullable<typeof probe.fetchLocal>)(url, init),
    localListeners: () => Promise.resolve([40_001, 40_002]),
  });
  const status = await antigravity().usageStatus?.(half, {});
  expect(status?.windows?.length).toBe(2);
  expect(calls.at(-1)).toBe(`POST http://127.0.0.1:40002${RPC_PATH}`);
});

// The desktop app gates the RPC on a token from its own HTML; `agy` does not.
test("usageStatus retries with the CSRF token when the RPC is refused", async () => {
  const { calls, probe } = quotaProbe({ csrfPorts: [40_001] });
  const status = await antigravity().usageStatus?.(probe, {});
  expect(calls).toEqual([
    `POST http://127.0.0.1:40001${RPC_PATH}`,
    "GET http://127.0.0.1:40001",
    `POST http://127.0.0.1:40001${RPC_PATH}`,
  ]);
  expect(status?.state).toBe("ok");
});

test("usageStatus scopes to the pool a model draws on", async () => {
  const { probe } = quotaProbe();
  const claude = await antigravity().usageStatus?.(probe, {
    model: "claude-opus-4-6-thinking",
  });
  expect(claude?.windows?.map((w) => w.label)).toEqual(["3p-weekly"]);
  const gemini = await antigravity().usageStatus?.(probe, {
    model: "gemini-3.1-pro-high",
  });
  expect(gemini?.windows?.map((w) => w.label)).toEqual(["gemini-weekly"]);
});

// Exclusion requires assertion: an unplaceable model keeps every window.
test("usageStatus keeps every window for an unrecognized model", async () => {
  const { probe } = quotaProbe();
  const status = await antigravity().usageStatus?.(probe, {
    model: "mystery-1",
  });
  expect(status?.windows?.length).toBe(2);
});

// A reassuring "0% used" for a window whose real standing is unknown is the
// one answer worth refusing.
test("usageStatus drops a bucket with no usable remainingFraction", async () => {
  const { probe } = quotaProbe({
    quota: {
      groups: [
        {
          buckets: [
            {
              bucketId: "gemini-weekly",
              remainingFraction: null,
              window: "weekly",
            },
            { bucketId: "3p-weekly", remainingFraction: 0, window: "weekly" },
          ],
          displayName: "Mixed",
        },
      ],
    },
  });
  const status = await antigravity().usageStatus?.(probe, {});
  expect(status?.windows?.map((w) => w.label)).toEqual(["3p-weekly"]);
  expect(status?.state).toBe("exhausted");
});

test("usageStatus is unknown when no Antigravity product is running", async () => {
  const probe = fakeSystemProbe({
    fetchLocal: () => Promise.reject(new Error("nothing here")),
    localListeners: () => Promise.resolve([]),
  });
  expect(await antigravity().usageStatus?.(probe, {})).toEqual({
    state: "unknown",
  });
});

// Loopback is not egress, so the quota answers without `network`.
test("usageStatus needs no network opt-in", async () => {
  const { probe } = quotaProbe();
  const status = await create(antigravity(), { probe }).usageStatus();
  expect(status.state).toBe("ok");
  expect(probe.fetch).toBeUndefined();
});
