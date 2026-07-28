import { ndjsonParser } from "../src/ndjson.js";
import type {
  Capabilities,
  Invocation,
  OutputSource,
  StdoutAdapter,
  SystemProbe,
} from "../src/types.js";

const allCaps: Capabilities = {
  attachments: false,
  authStatus: "native",
  cwd: "native",
  effort: "native",
  mcp: "native",
  modelListing: "native",
  modelSelection: "native",
  readOnly: "native",
  resume: "native",
  sessionFork: false,
  streaming: "native",
  structuredOutput: "native",
  systemPrompt: "native",
};

// A canned OutputSource so parser and agent tests never spawn a process.
export const sourceFromBody = (body: string): OutputSource => ({
  exitCode: Promise.resolve(0),
  // biome-ignore lint/suspicious/useAwait: replays in-memory data through the async OutputSource interface.
  async *lines() {
    for (const l of body.split("\n")) {
      yield l;
    }
  },
  stderr: () => Promise.resolve(""),
  text: () => Promise.resolve(body),
});

export const runnerFromFixture =
  (body: string) =>
  (_inv: Invocation): OutputSource =>
    sourceFromBody(body);

// A canned machine for discovery tests: no binaries, no files, one env var.
export const fakeSystemProbe = (
  overrides: Partial<SystemProbe> = {}
): SystemProbe => ({
  env: {},
  exec: () => Promise.resolve({ code: 0, stderr: "", stdout: "" }),
  homedir: () => "/home/fake",
  readFile: () => Promise.resolve(undefined),
  which: () => Promise.resolve(undefined),
  ...overrides,
});

// biome-ignore lint/suspicious/noExplicitAny: toy fixture schema.
type Toy = any;

const streamParse = ndjsonParser<{ sessionId?: string; text: string[] }>({
  finalize: (ctx) => ({
    events: [],
    raw: undefined,
    sessionId: ctx.sessionId,
    text: ctx.text.join(""),
  }),
  init: () => ({ text: [] }),
  map: (raw: unknown, ctx, strict) => {
    const o = raw as Toy;
    if (o.t === "text") {
      ctx.text.push(o.v);
      return { text: o.v, type: "text-delta" };
    }
    if (o.t === "session") {
      ctx.sessionId = o.v;
      return { sessionId: o.v, type: "session" };
    }
    if (o.t === "tool") {
      return {
        input: o.input,
        name: o.name,
        nativeName: o.name,
        type: "tool-call",
      };
    }
    if (o.t === "end") {
      return;
    }
    if (strict) {
      throw new Error(`unknown ${o.t}`);
    }
  },
});

export const fakeStreaming: StdoutAdapter = {
  authStatus: () => Promise.resolve({ state: "authenticated" }),
  buildInvocation: (prompt) => ({
    args: ["-p", prompt],
    command: "fake-stream",
  }),
  capabilities: allCaps,
  detection: {},
  listModels: () => Promise.resolve([{ id: "fake-model" }]),
  meta: { bin: ["fake-stream"], id: "fake-stream", name: "Fake Stream" },
  mode: "stdout",
  parse: streamParse,
};

export const fakeText: StdoutAdapter = {
  buildInvocation: (prompt) => ({ args: [prompt], command: "fake-text" }),
  capabilities: {
    ...allCaps,
    authStatus: false,
    effort: false,
    modelListing: false,
    readOnly: false,
    resume: false,
    streaming: false,
    structuredOutput: false,
    systemPrompt: false,
  },
  detection: {},
  meta: { bin: ["fake-text"], id: "fake-text", name: "Fake Text" },
  mode: "stdout",
  // Models the plain-text harnesses (Copilot/Kiro-style) from the audit:
  // no native event stream, so parse synthesizes the whole run from stdout.
  async *parse(source) {
    const buffered = await source.text();
    const text = buffered.trim();
    await source.exitCode;
    const delta = { text, type: "text-delta" } as const;
    const result = { events: [delta], raw: text, text };
    yield delta;
    yield { result, type: "done" };
    return result;
  },
};

// An agent whose effort vocabulary is closed, for value-level gating tests.
export const fakeClosedEffort: StdoutAdapter = {
  ...fakeStreaming,
  capabilities: {
    ...allCaps,
    readOnly: false,
    reasoningEfforts: ["low", "high"],
  },
  meta: { bin: ["fake-closed"], id: "fake-closed", name: "Fake Closed" },
  mode: "stdout",
};
