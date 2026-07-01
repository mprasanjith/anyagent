import { ndjsonParser } from "../src/internal/ndjson.js";
import type {
  Adapter,
  CapabilityTable,
  Invocation,
  OutputSource,
} from "../src/internal/types.js";

const allCaps: CapabilityTable = {
  cwd: true,
  mcp: true,
  modelSelection: true,
  permissionLevels: ["read-only", "edit", "full-auto"],
  sessionResume: true,
  streaming: true,
  structuredOutput: true,
  systemPrompt: true,
};

// A canned OutputSource so agent tests never spawn a process.
export const runnerFromFixture =
  (body: string) =>
  (_inv: Invocation): OutputSource => ({
    exitCode: Promise.resolve(0),
    async *lines() {
      for (const l of body.split("\n")) {
        yield l;
      }
    },
    stderr: () => Promise.resolve(""),
    text: () => Promise.resolve(body),
  });

// oxlint-disable-next-line typescript/no-explicit-any -- toy fixture schema.
type Toy = any;

const streamParse = ndjsonParser<{ text: string[] }>({
  finalize: (ctx, exitCode) => ({
    events: [],
    exitCode,
    raw: null,
    text: ctx.text.join(""),
  }),
  init: () => ({ text: [] }),
  map: (raw: unknown, ctx, strict) => {
    const o = raw as Toy;
    if (o.t === "text") {
      ctx.text.push(o.v);
      return { text: o.v, type: "text-delta" };
    }
    if (o.t === "tool") {
      return { input: o.input, name: o.name, type: "tool-call" };
    }
    if (o.t === "end") {
      return null;
    }
    if (strict) {
      throw new Error(`unknown ${o.t}`);
    }
    return null;
  },
});

export const fakeStreaming: Adapter = {
  buildInvocation: (prompt) => ({
    args: ["-p", prompt],
    command: "fake-stream",
  }),
  capabilities: allCaps,
  detection: {},
  meta: { bin: ["fake-stream"], id: "fake-stream", name: "Fake Stream" },
  parse: streamParse,
};

export const fakeText: Adapter = {
  buildInvocation: (prompt) => ({ args: [prompt], command: "fake-text" }),
  capabilities: {
    ...allCaps,
    sessionResume: false,
    streaming: false,
    structuredOutput: false,
    systemPrompt: false,
  },
  detection: {},
  meta: { bin: ["fake-text"], id: "fake-text", name: "Fake Text" },
  // Non-streaming: synthesize one delta + done from full stdout.
  async *parse(source) {
    const buffered = await source.text();
    const text = buffered.trim();
    const exitCode = await source.exitCode;
    const delta = { text, type: "text-delta" } as const;
    const result = { events: [delta], exitCode, raw: text, text };
    yield delta;
    yield { result, type: "done" };
    return result;
  },
};

export const fakeBinaryPerms: Adapter = {
  ...fakeStreaming,
  capabilities: { ...allCaps, permissionLevels: ["edit", "full-auto"] },
  meta: { bin: ["fake-binary"], id: "fake-binary", name: "Fake Binary" },
};
