import { AgentImpl } from "./internal/agent.js";
import type {
  Adapter,
  AgentEvent,
  CapabilitySupport,
  Invocation,
  OutputSource,
  PermissionLevel,
  RunOptions,
} from "./types.js";

/**
 * An {@link OutputSource} that replays a recorded stdout body with a clean
 * zero exit — the offline stand-in for a spawned CLI.
 */
export const sourceFromBody = (body: string): OutputSource => ({
  exitCode: Promise.resolve(0),
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

const ALL_LEVELS: PermissionLevel[] = ["read", "edit", "auto"];

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
 * to the concatenated text-deltas, a valid invocation for every declared
 * permission level, and an `UnsupportedCapability` throw for every capability
 * left undeclared. Add a `runConformance` test before shipping a new adapter;
 * it is what keeps the adapters uniform.
 */
export const runConformance = async (
  adapter: Adapter,
  opts: ConformanceOptions
): Promise<void> => {
  const caps = adapter.capabilities;
  const runWith = (runOpts: RunOptions) => () =>
    new AgentImpl(adapter, fixedRunner("")).run("x", runOpts);

  await Promise.all(
    Object.entries(opts.fixtures).map(([name, body]) =>
      checkStreamInvariants(adapter, name, body)
    )
  );

  for (const level of caps.permissionLevels) {
    const inv = adapter.buildInvocation("x", { permission: level });
    assert(
      inv.command.length > 0 && Array.isArray(inv.args),
      `permission "${level}" must build a valid invocation`
    );
  }

  const undeclared = ALL_LEVELS.filter(
    (l) => !caps.permissionLevels.includes(l)
  );
  await Promise.all(
    undeclared.map(async (level) => {
      assert(
        await throwsUnsupported(runWith({ permission: level })),
        `undeclared permission "${level}" must throw UnsupportedCapability`
      );
    })
  );

  const probes: [CapabilitySupport, () => Promise<unknown>][] = [
    [caps.modelSelection, runWith({ model: "m" })],
    [caps.sessionResume, runWith({ resume: "s" })],
    [caps.systemPrompt, runWith({ systemPrompt: "s" })],
    [caps.mcp, runWith({ mcp: {} })],
    [caps.cwd, runWith({ cwd: "/tmp" })],
  ];
  await Promise.all(
    probes.map(async ([supported, call]) => {
      if (supported) {
        return;
      }
      assert(
        await throwsUnsupported(call),
        "requesting an undeclared capability must throw UnsupportedCapability"
      );
    })
  );
};
