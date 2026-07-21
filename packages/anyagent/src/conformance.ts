import { AgentImpl } from "./internal/agent.js";
import type {
  Adapter,
  AgentEvent,
  CapabilitySupport,
  Invocation,
  OutputSource,
  RunOptions,
} from "./types.js";

/**
 * An {@link OutputSource} that replays a recorded stdout body with a clean
 * zero exit — the offline stand-in for a spawned CLI.
 */
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

/**
 * A drop-in for the core's runner that ignores the invocation and replays
 * `body`, so conformance drives adapters from fixtures, never subprocesses.
 */
export const fixedRunner =
  (body: string) =>
  (_inv: Invocation): OutputSource =>
    sourceFromBody(body);

const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    throw new Error(`conformance: ${msg}`);
  }
};

/** What {@link runConformance} needs from an adapter's test suite. */
export interface ConformanceOptions {
  /** Map of scenario name to the raw stdout an adapter's CLI would emit. */
  fixtures: Record<string, string>;
}

const checkStreamInvariants = async (
  adapter: Adapter,
  name: string,
  body: string
): Promise<void> => {
  const agent = new AgentImpl(adapter, fixedRunner(body));
  const events: AgentEvent[] = [];
  for await (const ev of agent.runStream("conformance prompt")) {
    events.push(ev);
  }

  const dones = events.filter(
    (e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done"
  );
  assert(
    dones.length === 1,
    `[${name}] expected exactly one done event, got ${dones.length}`
  );
  assert(
    events.at(-1)?.type === "done",
    `[${name}] done must be the final event`
  );

  const result = dones[0]?.result;
  assert(result !== undefined, `[${name}] done event must carry a result`);

  const deltas = events.filter(
    (e): e is Extract<AgentEvent, { type: "text-delta" }> =>
      e.type === "text-delta"
  );
  assert(
    result?.text === deltas.map((d) => d.text).join(""),
    `[${name}] result.text must equal concatenation of text-delta events`
  );
  assert(
    !result?.events.some((e) => e.type === "done"),
    `[${name}] result.events must not include the done event`
  );

  const sessions = events.filter((e) => e.type === "session");
  assert(
    sessions.length <= 1,
    `[${name}] at most one session event per stream`
  );
  const sessionId = sessions[0]?.type === "session" && sessions[0].sessionId;
  assert(
    sessions.length === 0 || result?.sessionId === sessionId,
    `[${name}] result.sessionId must match the session event`
  );
};

const throwsUnsupported = async (
  call: () => Promise<unknown>
): Promise<boolean> => {
  try {
    await call();
    return false;
  } catch (error) {
    return (error as { code?: string })?.code === "UnsupportedCapability";
  }
};

/**
 * The executable half of the adapter contract. Feed it your adapter and its
 * recorded stdout fixtures, and it asserts the invariants every adapter must
 * uphold: exactly one terminal `done` event per stream, `result.text` equal
 * to the concatenated text-deltas, a `sessionId` consistent with the
 * `session` event, a valid invocation for whatever the capabilities
 * declare, and an `UnsupportedCapability` throw for everything it does not.
 * Add a `runConformance` test before shipping a new adapter; it is what
 * keeps the adapters uniform.
 */
export const runConformance = async (
  adapter: Adapter,
  opts: ConformanceOptions
): Promise<void> => {
  const caps = adapter.capabilities;
  const agentOf = () => new AgentImpl(adapter, fixedRunner(""));
  const runWith = (runOpts: RunOptions) => () => agentOf().run("x", runOpts);

  await Promise.all(
    Object.entries(opts.fixtures).map(([name, body]) =>
      checkStreamInvariants(adapter, name, body)
    )
  );

  if (caps.readOnly) {
    const inv = adapter.buildInvocation("x", { readOnly: true });
    assert(
      inv.command.length > 0 && Array.isArray(inv.args),
      "readOnly must build a valid invocation"
    );
  } else {
    assert(
      await throwsUnsupported(runWith({ readOnly: true })),
      "readOnly on an adapter that declares it false must throw UnsupportedCapability"
    );
  }

  const gated: [CapabilitySupport, () => Promise<unknown>, string][] = [
    [caps.modelSelection, runWith({ model: "m" }), "model"],
    [caps.sessionResume, runWith({ resume: "s" }), "resume"],
    [caps.systemPrompt, runWith({ systemPrompt: "s" }), "systemPrompt"],
    [caps.mcp, runWith({ mcp: {} }), "mcp"],
    [caps.cwd, runWith({ cwd: "/tmp" }), "cwd"],
    [caps.structuredOutput, runWith({ schema: {} }), "schema"],
    [caps.effort, runWith({ effort: "high" }), "effort"],
  ];
  await Promise.all(
    gated.map(async ([supported, call, label]) => {
      if (supported) {
        return;
      }
      assert(
        await throwsUnsupported(call),
        `requesting undeclared "${label}" must throw UnsupportedCapability`
      );
    })
  );

  if (caps.reasoningEfforts) {
    assert(
      Boolean(caps.effort),
      "reasoningEfforts implies the effort capability"
    );
    assert(
      caps.reasoningEfforts.length > 0,
      "a closed effort vocabulary must not be empty"
    );
    assert(
      await throwsUnsupported(runWith({ effort: "not-a-real-effort-level" })),
      "an effort outside the closed vocabulary must throw UnsupportedCapability"
    );
  }

  assert(
    !caps.authStatus || typeof adapter.authStatus === "function",
    "a declared authStatus capability needs an authStatus implementation"
  );
  if (!caps.authStatus) {
    assert(
      await throwsUnsupported(() => agentOf().authStatus()),
      "authStatus() on a false capability must throw UnsupportedCapability"
    );
  }

  assert(
    !caps.modelListing || typeof adapter.listModels === "function",
    "a declared modelListing capability needs a listModels implementation"
  );
  if (!caps.modelListing) {
    assert(
      await throwsUnsupported(() => agentOf().models()),
      "models() on a false capability must throw UnsupportedCapability"
    );
  }
};
