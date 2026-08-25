import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { claudeCode } from "../src/claude-code.js";
import { runConformance } from "../src/conformance.js";
import { spawnAndStream } from "../src/internal/runtime/spawn.js";
import type { AgentEvent, OutputSource, RunResult } from "../src/types.js";
import { fakeSystemProbe, sourceFromBody } from "./fake-adapter.js";

const bodySource = (lines: unknown[]): OutputSource =>
  sourceFromBody(lines.map((l) => JSON.stringify(l)).join("\n"));

const fixture = (name: string): string =>
  readFileSync(
    path.join(import.meta.dir, "fixtures/claude-code", name),
    "utf-8"
  );

const fixtureSource = (name: string): OutputSource =>
  sourceFromBody(fixture(name));

const collectSource = async (
  src: OutputSource,
  strict = false
): Promise<{ events: AgentEvent[]; result?: RunResult }> => {
  const events: AgentEvent[] = [];
  for await (const ev of claudeCode().parse(src, { strict })) {
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

test("buildInvocation defaults to full autonomy: bypassPermissions, no deny list", () => {
  const inv = claudeCode().buildInvocation("hi", {});
  expect(inv.command).toBe("claude");
  expect(inv.args).toContain("-p");
  // Prompt goes to stdin, never argv, so it can't hit the OS argv size limit.
  expect(inv.input).toBe("hi");
  expect(inv.args).not.toContain("hi");
  expect(argAfter(inv.args, "--output-format")).toBe("stream-json");
  expect(argAfter(inv.args, "--permission-mode")).toBe("bypassPermissions");
  expect(inv.args).not.toContain("--disallowedTools");
});

test("readOnly maps to manual mode plus a deny of the mutating built-ins", () => {
  const inv = claudeCode().buildInvocation("x", { readOnly: true });
  expect(argAfter(inv.args, "--permission-mode")).toBe("manual");
  const denied = argAfter(inv.args, "--disallowedTools")?.split(",") ?? [];
  for (const tool of ["Bash", "Edit", "NotebookEdit", "Write"]) {
    expect(denied).toContain(tool);
  }
});

test("effort maps to --effort", () => {
  const inv = claudeCode().buildInvocation("x", { effort: "high" });
  expect(argAfter(inv.args, "--effort")).toBe("high");
});

test("mcp maps to --mcp-config plus --strict-mcp-config", () => {
  const inv = claudeCode().buildInvocation("x", {
    mcp: { srv: { args: ["--x"], command: "run-srv" } },
  });
  expect(JSON.parse(argAfter(inv.args, "--mcp-config") ?? "{}")).toEqual({
    mcpServers: { srv: { args: ["--x"], command: "run-srv" } },
  });
  expect(inv.args).toContain("--strict-mcp-config");
});

test("schema maps to --json-schema with the schema serialized verbatim", () => {
  const schema = {
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    type: "object",
  };
  const inv = claudeCode().buildInvocation("x", { schema });
  expect(JSON.parse(argAfter(inv.args, "--json-schema") ?? "{}")).toEqual(
    schema
  );
});

test("buildInvocation emits every optional flag and passes cwd/env", () => {
  const inv = claudeCode().buildInvocation("hi", {
    cwd: "/work",
    env: { FOO: "bar" },
    model: "opus",
    resume: "sess-1",
    systemPrompt: "be brief",
  });
  expect(inv.args).toContain("--verbose");
  expect(argAfter(inv.args, "--model")).toBe("opus");
  expect(argAfter(inv.args, "--append-system-prompt")).toBe("be brief");
  expect(argAfter(inv.args, "--resume")).toBe("sess-1");
  expect(inv.cwd).toBe("/work");
  expect(inv.env).toEqual({ FOO: "bar" });
});

test("forkSession adds --fork-session alongside --resume", () => {
  const inv = claudeCode().buildInvocation("x", {
    forkSession: true,
    resume: "sess-1",
  });
  expect(argAfter(inv.args, "--resume")).toBe("sess-1");
  expect(inv.args).toContain("--fork-session");
});

test("a plain resume omits --fork-session", () => {
  const inv = claudeCode().buildInvocation("x", { resume: "sess-1" });
  expect(argAfter(inv.args, "--resume")).toBe("sess-1");
  expect(inv.args).not.toContain("--fork-session");
});

test("parses a simple text answer with usage and cache accounting", async () => {
  const { events, result } = await collect("simple.jsonl");
  expect(result.text).toBe("pong");
  // Values are volatile per run; assert the fields are populated, not magnitudes.
  expect(typeof result.usage?.inputTokens).toBe("number");
  expect(typeof result.usage?.outputTokens).toBe("number");
  expect(typeof result.usage?.cacheReadTokens).toBe("number");
  expect(typeof result.usage?.cacheWriteTokens).toBe("number");
  expect(typeof result.usage?.costUsd).toBe("number");
  expect(events.at(-1)?.type).toBe("done");
});

test("system init yields one session event and result.sessionId matches", async () => {
  const { events, result } = await collect("simple.jsonl");
  const sessions = events.filter((e) => e.type === "session");
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.type === "session" && sessions[0].sessionId).toBe(
    "11111111-1111-4111-8111-111111111111"
  );
  expect(result.sessionId).toBe("11111111-1111-4111-8111-111111111111");
});

test("result.session_id wins over the init's when both are present", async () => {
  const { result } = await collectSource(
    bodySource([
      { session_id: "init-id", subtype: "init", type: "system" },
      {
        is_error: false,
        result: "",
        session_id: "result-id",
        subtype: "success",
        type: "result",
      },
    ])
  );
  expect(result?.sessionId).toBe("result-id");
});

test("tool_use/tool_result carry normalized name, native name, and callId", async () => {
  const { events } = await collect("tools.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  const res = events.find((e) => e.type === "tool-result");
  expect(call?.type === "tool-call" && call.name).toBe("read");
  expect(call?.type === "tool-call" && call.nativeName).toBe("Read");
  expect(call?.type === "tool-call" && call.callId).toBe(
    "toolu_01KWPj98xGinBtovE1MyaTFy"
  );
  expect(res?.type === "tool-result" && res.name).toBe("read");
  expect(res?.type === "tool-result" && res.nativeName).toBe("Read");
  expect(res?.type === "tool-result" && res.callId).toBe(
    "toolu_01KWPj98xGinBtovE1MyaTFy"
  );
});

test("a tool outside the shared vocabulary keeps its native name as name", async () => {
  const { events } = await collect("structured.jsonl");
  const call = events.find((e) => e.type === "tool-call");
  expect(call?.type === "tool-call" && call.name).toBe("StructuredOutput");
  expect(call?.type === "tool-call" && call.nativeName).toBe(
    "StructuredOutput"
  );
});

test("thinking blocks surface as reasoning-delta, never in result.text", async () => {
  const { events, result } = await collect("tools.jsonl");
  const reasoning = events.find((e) => e.type === "reasoning-delta");
  expect(reasoning?.type === "reasoning-delta" && reasoning.text).toBe(
    "I should read the file."
  );
  expect(result.text).toBe("anyagent");
});

test("redacted_thinking emits no event and passes strict", async () => {
  const { events } = await collectSource(
    bodySource([
      {
        message: {
          content: [{ data: "opaque", type: "redacted_thinking" }],
          role: "assistant",
        },
        type: "assistant",
      },
      { is_error: false, result: "", subtype: "success", type: "result" },
    ]),
    true
  );
  expect(events.some((e) => e.type === "reasoning-delta")).toBe(false);
});

test("structured output synthesizes the serialized JSON as text", async () => {
  const { events, result } = await collect("structured.jsonl");
  expect(result.text).toBe('{"ok":true}');
  expect(result.structuredOutput).toEqual({ ok: true });
  const deltas = events.filter((e) => e.type === "text-delta");
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.type === "text-delta" && deltas[0].text).toBe(
    '{"ok":true}'
  );
  expect(result.sessionId).toBe("9c24f1e5-355e-4431-9851-9f75de402916");
});

test("streamed prose stays the text; the payload rides structuredOutput", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        message: {
          content: [{ text: "Sure — here it is.", type: "text" }],
          role: "assistant",
        },
        type: "assistant",
      },
      {
        is_error: false,
        result: '{"ok":true}',
        structured_output: { ok: true },
        subtype: "success",
        type: "result",
      },
    ])
  );
  expect(result?.text).toBe("Sure — here it is.");
  expect(result?.structuredOutput).toEqual({ ok: true });
});

// 2.1.220 drifted from the 2.1.218 recording behind structured.jsonl: prose
// text blocks now stream before the StructuredOutput call, and the result
// event's `result` string is the serialized payload, not the prose.
test("recorded 2.1.220 run: prose precedes the payload and both survive", async () => {
  const { events, result } = await collect("structured-prose.jsonl");
  const deltas = events.filter((e) => e.type === "text-delta");
  expect(deltas.length).toBeGreaterThan(0);
  expect(result.text.startsWith('"Wet" means covered')).toBe(true);
  expect(result.structuredOutput).toMatchObject({ ok: true });
  expect(result.sessionId).toBe("5c3a0d12-91d8-472d-b35b-63738da4463c");
});

test("agent-level error (is_error) throws instead of returning success", async () => {
  await expect(
    collectSource(
      bodySource([
        {
          message: {
            content: [{ text: "partial", type: "text" }],
            role: "assistant",
          },
          type: "assistant",
        },
        {
          is_error: true,
          result: "Reached max turns.",
          subtype: "error_max_turns",
          type: "result",
        },
      ])
    )
  ).rejects.toMatchObject({
    code: "Invocation",
    message: expect.stringContaining("Reached max turns"),
  });
});

test("strict mode tolerates every recorded real-output shape", async () => {
  await expect(
    Promise.all(
      [
        "simple.jsonl",
        "tools.jsonl",
        "structured.jsonl",
        "structured-prose.jsonl",
      ].map((f) => collectSource(fixtureSource(f), true))
    )
  ).resolves.toHaveLength(4);
});

test("strict mode tolerates the named expansion types and drops them", async () => {
  const { events } = await collectSource(
    bodySource([
      { type: "stream_event" },
      { type: "prompt_suggestion" },
      { type: "hook_started" },
      { is_error: false, result: "", subtype: "success", type: "result" },
    ]),
    true
  );
  expect(events.map((e) => e.type)).toEqual(["done"]);
});

test("strict mode throws on a genuinely unknown top-level event type", async () => {
  await expect(
    collectSource(bodySource([{ type: "mystery" }]), true)
  ).rejects.toMatchObject({
    code: "Parse",
    message: expect.stringContaining("mystery"),
  });
});

test("strict mode throws on an unknown assistant content block", async () => {
  await expect(
    collectSource(
      bodySource([
        {
          message: {
            content: [{ source: {}, type: "image" }],
            role: "assistant",
          },
          type: "assistant",
        },
      ]),
      true
    )
  ).rejects.toMatchObject({
    code: "Parse",
    message: expect.stringContaining("image"),
  });
});

test("tool_result with an unseen tool_use_id falls back to name 'unknown'", async () => {
  const { events } = await collectSource(
    bodySource([
      {
        message: {
          content: [
            { content: "x", tool_use_id: "never-seen", type: "tool_result" },
          ],
          role: "user",
        },
        type: "user",
      },
      { is_error: false, result: "", subtype: "success", type: "result" },
    ])
  );
  const res = events.find((e) => e.type === "tool-result");
  expect(res?.type === "tool-result" && res.name).toBe("unknown");
  expect(res?.type === "tool-result" && res.nativeName).toBe("unknown");
});

test("a result without usage yields no usage event and leaves usage undefined", async () => {
  const { events, result } = await collectSource(
    bodySource([
      {
        message: { content: [{ text: "hi", type: "text" }], role: "assistant" },
        type: "assistant",
      },
      { is_error: false, result: "hi", subtype: "success", type: "result" },
    ])
  );
  expect(result?.usage).toBeUndefined();
  expect(events.some((e) => e.type === "usage")).toBe(false);
});

test("usage is populated from total_cost_usd alone (tokens undefined)", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        is_error: false,
        result: "",
        subtype: "success",
        total_cost_usd: 0.02,
        type: "result",
      },
    ])
  );
  expect(result?.usage?.costUsd).toBe(0.02);
  expect(result?.usage?.inputTokens).toBeUndefined();
  expect(result?.usage?.cacheReadTokens).toBeUndefined();
});

test("usage is populated from the usage block alone (cost undefined)", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        is_error: false,
        result: "",
        subtype: "success",
        type: "result",
        usage: {
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 3,
          input_tokens: 5,
          output_tokens: 2,
        },
      },
    ])
  );
  expect(result?.usage?.inputTokens).toBe(5);
  expect(result?.usage?.cacheReadTokens).toBe(3);
  expect(result?.usage?.cacheWriteTokens).toBe(7);
  expect(result?.usage?.costUsd).toBeUndefined();
});

test("text is concatenated across multiple assistant messages", async () => {
  const { result } = await collectSource(
    bodySource([
      {
        message: {
          content: [{ text: "foo", type: "text" }],
          role: "assistant",
        },
        type: "assistant",
      },
      {
        message: {
          content: [{ text: "bar", type: "text" }],
          role: "assistant",
        },
        type: "assistant",
      },
      { is_error: false, result: "foobar", subtype: "success", type: "result" },
    ])
  );
  expect(result?.text).toBe("foobar");
});

test("authStatus: exit 0 with loggedIn is authenticated with its method", async () => {
  const calls: { args: string[]; bin: string }[] = [];
  const probe = fakeSystemProbe({
    exec: (bin, args) => {
      calls.push({ args, bin });
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          authMethod: "claude.ai",
          loggedIn: true,
          subscriptionType: "max",
        }),
      });
    },
  });
  const status = await claudeCode().authStatus?.(probe);
  expect(status?.state).toBe("authenticated");
  expect(status?.method).toBe("claude.ai");
  expect(calls).toEqual([
    { args: ["auth", "status", "--json"], bin: "claude" },
  ]);
});

test("authStatus: nonzero exit is unauthenticated", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({ code: 1, stderr: "not logged in", stdout: "" }),
  });
  const status = await claudeCode().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus: exit 0 with loggedIn false is unauthenticated", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ loggedIn: false }),
      }),
  });
  const status = await claudeCode().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus: exec failure or unparseable output is unknown", async () => {
  const failing = fakeSystemProbe({
    exec: () => Promise.reject(new Error("ENOENT")),
  });
  const garbled = fakeSystemProbe({
    exec: () => Promise.resolve({ code: 0, stderr: "", stdout: "not json" }),
  });
  expect((await claudeCode().authStatus?.(failing))?.state).toBe("unknown");
  expect((await claudeCode().authStatus?.(garbled))?.state).toBe("unknown");
});

test("conformance passes over all recorded fixtures", async () => {
  await runConformance(claudeCode(), {
    fixtures: {
      simple: fixture("simple.jsonl"),
      structured: fixture("structured.jsonl"),
      "structured-prose": fixture("structured-prose.jsonl"),
      tools: fixture("tools.jsonl"),
    },
  });
});

test("nonzero exit after valid output fails loud instead of returning it", async () => {
  const line = JSON.stringify({
    is_error: false,
    result: "pong",
    subtype: "success",
    total_cost_usd: 0.01,
    type: "result",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const src = spawnAndStream({
    args: ["-c", `printf '%s\\n' '${line}'; exit 1`],
    command: "sh",
  });
  await expect(collectSource(src)).rejects.toMatchObject({
    code: "Invocation",
  });
});

// A ~/.claude.json shaped like the real one (recorded 2026-07-29): the usage
// snapshot plus the org-specific model cache the alias join reads.
const CLAUDE_JSON = JSON.stringify({
  additionalModelOptionsCache: [
    { description: "Fable 5", label: "Fable", value: "claude-fable-5[1m]" },
  ],
  cachedUsageUtilization: {
    accountUuid: "10b77b8b-0000-0000-0000-000000000000",
    fetchedAtMs: 1_785_324_930_920,
    utilization: {
      limits: [
        {
          group: "session",
          is_active: false,
          kind: "session",
          percent: 13,
          resets_at: "2026-07-29T14:39:59.825792+00:00",
          scope: null,
          severity: "normal",
        },
        {
          group: "weekly",
          is_active: false,
          kind: "weekly_all",
          percent: 20,
          resets_at: "2026-07-31T10:59:59.825810+00:00",
          scope: null,
          severity: "normal",
        },
        {
          group: "weekly",
          is_active: true,
          kind: "weekly_scoped",
          percent: 26,
          resets_at: "2026-07-31T10:59:59.826050+00:00",
          scope: { model: { display_name: "Fable", id: null }, surface: null },
          severity: "normal",
        },
      ],
    },
  },
});

const usageProbe = (body: string = CLAUDE_JSON) =>
  fakeSystemProbe({
    readFile: (p) =>
      Promise.resolve(p === "/home/fake/.claude.json" ? body : undefined),
  });

test("usageStatus maps the cached snapshot to normalized windows", async () => {
  const status = await claudeCode().usageStatus?.(usageProbe(), {});
  expect(status?.state).toBe("ok");
  expect(status?.asOf).toEqual(new Date(1_785_324_930_920));
  expect(status?.windows?.map((w) => w.label)).toEqual([
    "session",
    "weekly_all",
    "weekly_scoped",
  ]);
  const scoped = status?.windows?.at(-1);
  expect(scoped?.usedPercent).toBe(26);
  expect(scoped?.modelScope).toBe("Fable");
  // The cache join upgrades the label to the fully-qualified model string.
  expect(scoped?.model).toBe("claude-fable-5[1m]");
  expect(scoped?.resetsAt).toEqual(
    new Date("2026-07-31T10:59:59.826050+00:00")
  );
});

// --- live usage, behind the network opt-in -------------------------------

const CREDENTIALS = JSON.stringify({
  claudeAiOauth: {
    accessToken: "at-live",
    expiresAt: 4_102_444_800_000,
    refreshToken: "rt-never-used",
  },
});

// The endpoint's own shape: `limits[]` matches what the CLI caches, so one
// parser serves both. `extra_usage` is minor units scaled by decimal_places.
const LIVE_USAGE = {
  extra_usage: {
    currency: "USD",
    decimal_places: 2,
    is_enabled: true,
    monthly_limit: 5000,
    used_credits: 250,
  },
  limits: [
    {
      kind: "session",
      percent: 71,
      resets_at: "2026-08-25T18:00:00.000000+00:00",
      scope: null,
    },
  ],
};

const liveProbe = (
  opts: { body?: unknown; creds?: string; status?: number } = {}
) => {
  const calls: { headers?: Record<string, string>; url: string }[] = [];
  const probe = fakeSystemProbe({
    fetch: (url, init) => {
      calls.push({ headers: init?.headers, url: String(url) });
      return Promise.resolve(
        new Response(JSON.stringify(opts.body ?? LIVE_USAGE), {
          status: opts.status ?? 200,
        })
      );
    },
    readFile: (p) => {
      if (p === "/home/fake/.claude.json") {
        return Promise.resolve(CLAUDE_JSON);
      }
      if (p === "/home/fake/.claude/.credentials.json") {
        return Promise.resolve(opts.creds ?? CREDENTIALS);
      }
      return Promise.resolve(undefined);
    },
  });
  return { calls, probe };
};

test("usageStatus prefers the live snapshot when egress is on", async () => {
  const { calls, probe } = liveProbe();
  const status = await claudeCode().usageStatus?.(probe, {});
  expect(calls[0]?.url).toBe("https://api.anthropic.com/api/oauth/usage");
  expect(status?.windows?.map((w) => w.usedPercent)).toEqual([71]);
  // Live means now, not the cache's hours-old stamp.
  expect(status?.asOf?.getTime()).toBeGreaterThan(1_785_324_930_920);
});

test("usageStatus sends the credential and the headers the endpoint requires", async () => {
  const { calls, probe } = liveProbe();
  await claudeCode().usageStatus?.(probe, {});
  expect(calls[0]?.headers?.authorization).toBe("Bearer at-live");
  expect(calls[0]?.headers?.["anthropic-beta"]).toBe("oauth-2025-04-20");
  // Load-bearing: the endpoint rate-limits hard without a claude-code UA.
  expect(calls[0]?.headers?.["user-agent"]).toStartWith("claude-code/");
});

test("usageStatus reports the extra-usage balance as credits", async () => {
  const { probe } = liveProbe();
  const status = await claudeCode().usageStatus?.(probe, {});
  expect(status?.credits).toEqual({ balance: 47.5, currency: "USD" });
});

// The `spend` block as returned live (2026-08-25), disabled on this account.
const SPEND_DISABLED = {
  balance: null,
  cap: null,
  enabled: false,
  limit: null,
  percent: 0,
  severity: "normal",
  used: { amount_minor: 0, currency: "USD", exponent: 2 },
};

test("usageStatus prefers the spend block over the older extra_usage", async () => {
  const { probe } = liveProbe({
    body: {
      ...LIVE_USAGE,
      spend: {
        ...SPEND_DISABLED,
        balance: { amount_minor: 1234, currency: "USD", exponent: 2 },
        enabled: true,
      },
    },
  });
  const status = await claudeCode().usageStatus?.(probe, {});
  expect(status?.credits).toEqual({ balance: 12.34, currency: "USD" });
});

test("usageStatus derives the balance from a cap and a spend", async () => {
  const { probe } = liveProbe({
    body: {
      ...LIVE_USAGE,
      spend: {
        ...SPEND_DISABLED,
        enabled: true,
        limit: { amount_minor: 5000, currency: "USD", exponent: 2 },
        used: { amount_minor: 1500, currency: "USD", exponent: 2 },
      },
    },
  });
  expect((await claudeCode().usageStatus?.(probe, {}))?.credits).toEqual({
    balance: 35,
    currency: "USD",
  });
});

// A disabled pool is no pool, even though `used` is a readable amount.
test("usageStatus falls through a disabled spend block", async () => {
  const { probe } = liveProbe({
    body: { limits: LIVE_USAGE.limits, spend: SPEND_DISABLED },
  });
  expect(
    (await claudeCode().usageStatus?.(probe, {}))?.credits
  ).toBeUndefined();
});

test("usageStatus reports no credits when extra usage is switched off", async () => {
  const { probe } = liveProbe({
    body: { ...LIVE_USAGE, extra_usage: { is_enabled: false } },
  });
  const status = await claudeCode().usageStatus?.(probe, {});
  expect(status?.credits).toBeUndefined();
});

// Refreshing would rotate the token out from under the `claude` CLI and log
// the user out of their own tool, so an expired credential is simply unused.
test("usageStatus falls back to the cache rather than refresh an expired token", async () => {
  const { calls, probe } = liveProbe({
    creds: JSON.stringify({
      claudeAiOauth: { accessToken: "at-old", expiresAt: 1_000_000 },
    }),
  });
  const status = await claudeCode().usageStatus?.(probe, {});
  expect(calls).toEqual([]);
  expect(status?.asOf).toEqual(new Date(1_785_324_930_920));
  expect(status?.windows?.length).toBe(3);
});

test("usageStatus falls back to the cache when the endpoint rejects the token", async () => {
  const { probe } = liveProbe({ body: {}, status: 401 });
  const status = await claudeCode().usageStatus?.(probe, {});
  expect(status?.asOf).toEqual(new Date(1_785_324_930_920));
  expect(status?.windows?.length).toBe(3);
});

// No credentials file at all is the macOS Keychain case.
test("usageStatus stays on the cache when no credential is on disk", async () => {
  const { calls, probe } = liveProbe({ creds: undefined });
  const bare = fakeSystemProbe({
    fetch: probe.fetch,
    readFile: (p) =>
      Promise.resolve(
        p === "/home/fake/.claude.json" ? CLAUDE_JSON : undefined
      ),
  });
  const status = await claudeCode().usageStatus?.(bare, {});
  expect(calls).toEqual([]);
  expect(status?.windows?.length).toBe(3);
});

// Older payloads carry named windows instead of `limits[]`; the field name
// itself names the model family, so the scoped bucket stays assertable.
test("usageStatus understands the older named-window payload", async () => {
  const { probe } = liveProbe({
    body: {
      five_hour: { resets_at: "2026-08-25T18:00:00Z", utilization: 62 },
      seven_day: { resets_at: "2026-08-29T18:00:00Z", utilization: 27 },
      seven_day_sonnet: { resets_at: "2026-08-26T18:00:00Z", utilization: 4 },
    },
  });
  const status = await claudeCode().usageStatus?.(probe, {});
  expect(status?.windows?.map((w) => w.label)).toEqual([
    "five_hour",
    "seven_day",
    "seven_day_sonnet",
  ]);
  expect(status?.windows?.at(-1)?.modelScope).toBe("Sonnet");
});

test("usageStatus scoped to a family drops a foreign legacy bucket", async () => {
  const { probe } = liveProbe({
    body: {
      five_hour: { resets_at: "2026-08-25T18:00:00Z", utilization: 62 },
      seven_day_sonnet: { resets_at: "2026-08-26T18:00:00Z", utilization: 4 },
    },
  });
  const status = await claudeCode().usageStatus?.(probe, { model: "opus" });
  expect(status?.windows?.map((w) => w.label)).toEqual(["five_hour"]);
});

test("usageStatus reads the config dir CLAUDE_CONFIG_DIR names", async () => {
  const probe = fakeSystemProbe({
    env: { CLAUDE_CONFIG_DIR: "/opt/claude-work/" },
    readFile: (p) =>
      Promise.resolve(
        p === "/opt/claude-work/.claude.json" ? CLAUDE_JSON : undefined
      ),
  });
  const status = await claudeCode().usageStatus?.(probe, {});
  expect(status?.state).toBe("ok");
  expect(status?.windows?.length).toBe(3);
});

// An isolated login has its own state file; answering from the home copy
// would report a different account's standing as this one's.
test("usageStatus does not fall back to the home file when the config dir is set", async () => {
  const probe = fakeSystemProbe({
    env: { CLAUDE_CONFIG_DIR: "/opt/claude-work" },
    readFile: (p) =>
      Promise.resolve(
        p === "/home/fake/.claude.json" ? CLAUDE_JSON : undefined
      ),
  });
  expect(await claudeCode().usageStatus?.(probe, {})).toEqual({
    state: "unknown",
  });
});

test("usageStatus scoped to another family drops the foreign bucket", async () => {
  const status = await claudeCode().usageStatus?.(usageProbe(), {
    model: "haiku",
  });
  expect(status?.windows?.map((w) => w.label)).toEqual([
    "session",
    "weekly_all",
  ]);
});

test("usageStatus keeps a matching bucket and every account-wide window", async () => {
  const status = await claudeCode().usageStatus?.(usageProbe(), {
    model: "claude-fable-5[1m]",
  });
  expect(status?.windows).toHaveLength(3);
});

test("usageStatus keeps scoped windows for a model it cannot place", async () => {
  // Exclusion requires assertion: an unrecognized model errs conservative.
  const status = await claudeCode().usageStatus?.(usageProbe(), {
    model: "claude-newthing-6",
  });
  expect(status?.windows).toHaveLength(3);
});

test("usageStatus reports exhausted at a spent window", async () => {
  const body = JSON.parse(CLAUDE_JSON);
  body.cachedUsageUtilization.utilization.limits[0].percent = 100;
  const status = await claudeCode().usageStatus?.(
    usageProbe(JSON.stringify(body)),
    {}
  );
  expect(status?.state).toBe("exhausted");
});

test("usageStatus trusts a non-normal severity as near-limit", async () => {
  const body = JSON.parse(CLAUDE_JSON);
  body.cachedUsageUtilization.utilization.limits[1].severity = "elevated";
  const status = await claudeCode().usageStatus?.(
    usageProbe(JSON.stringify(body)),
    {}
  );
  expect(status?.state).toBe("near-limit");
});

test("usageStatus with no cache file is unknown", async () => {
  const status = await claudeCode().usageStatus?.(fakeSystemProbe(), {});
  expect(status).toEqual({ state: "unknown" });
});

test("listModels lists the documented aliases plus the cached org entries", async () => {
  const models = await claudeCode().listModels?.(usageProbe());
  const ids = models?.map((m) => m.id);
  expect(ids).toContain("fable");
  expect(ids).toContain("sonnet[1m]");
  expect(ids).not.toContain("default");
  // The cache adds the org-specific fully-qualified entry, deduplicated.
  expect(ids).toContain("claude-fable-5[1m]");
  expect(ids?.filter((id) => id === "claude-fable-5[1m]")).toHaveLength(1);
  expect(models?.every((m) => m.provider === "anthropic")).toBe(true);
});

test("authStatus asserts subscription billing from the subscription tier", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          apiProvider: "firstParty",
          authMethod: "claude.ai",
          loggedIn: true,
          subscriptionType: "max",
        }),
      }),
  });
  const status = await claudeCode().authStatus?.(probe);
  expect(status?.billing).toBe("subscription");
});

test("authStatus asserts api-key billing behind metered infrastructure", async () => {
  const probe = fakeSystemProbe({
    exec: () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ apiProvider: "bedrock", loggedIn: true }),
      }),
  });
  const status = await claudeCode().authStatus?.(probe);
  expect(status?.billing).toBe("api-key");
});
