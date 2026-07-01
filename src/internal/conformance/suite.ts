import { AgentImpl } from "../agent.js";
import type { Adapter, AgentEvent, PermissionLevel } from "../types.js";
import { fixedRunner } from "./scenarios.js";

const ALL_LEVELS: PermissionLevel[] = ["read-only", "edit", "full-auto"];

const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    throw new Error(`conformance: ${msg}`);
  }
};

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

  const dones = events.filter((e) => e.type === "done");
  assert(
    dones.length === 1,
    `[${name}] expected exactly one done event, got ${dones.length}`
  );
  assert(
    events.at(-1)?.type === "done",
    `[${name}] done must be the final event`
  );

  const [done] = dones;
  const result = done?.type === "done" ? done.result : undefined;
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

export const runConformance = async (
  adapter: Adapter,
  opts: ConformanceOptions
): Promise<void> => {
  await Promise.all(
    Object.entries(opts.fixtures).map(([name, body]) =>
      checkStreamInvariants(adapter, name, body)
    )
  );

  for (const level of adapter.capabilities.permissionLevels) {
    const inv = adapter.buildInvocation("x", { permission: level });
    assert(
      inv.command.length > 0 && Array.isArray(inv.args),
      `permission "${level}" must build a valid invocation`
    );
  }

  const undeclared = ALL_LEVELS.filter(
    (l) => !adapter.capabilities.permissionLevels.includes(l)
  );
  await Promise.all(
    undeclared.map(async (level) => {
      const agent = new AgentImpl(adapter, fixedRunner(""));
      assert(
        await throwsUnsupported(() => agent.run("x", { permission: level })),
        `undeclared permission "${level}" must throw UnsupportedCapability`
      );
    })
  );

  const caps = adapter.capabilities;
  const probes: [boolean, () => Promise<unknown>][] = [
    [
      caps.modelSelection,
      () => new AgentImpl(adapter, fixedRunner("")).run("x", { model: "m" }),
    ],
    [
      caps.sessionResume,
      () => new AgentImpl(adapter, fixedRunner("")).run("x", { resume: "s" }),
    ],
    [
      caps.systemPrompt,
      () =>
        new AgentImpl(adapter, fixedRunner("")).run("x", { systemPrompt: "s" }),
    ],
    [
      caps.mcp,
      () => new AgentImpl(adapter, fixedRunner("")).run("x", { mcp: {} }),
    ],
    [
      caps.cwd,
      () => new AgentImpl(adapter, fixedRunner("")).run("x", { cwd: "/tmp" }),
    ],
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
