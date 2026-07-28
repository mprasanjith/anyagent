import type { AcpTransport } from "./internal/acp.js";
import { AcpSessionImpl } from "./internal/acp-session.js";
import { AgentImpl } from "./internal/agent.js";
import type {
  Adapter,
  AgentEvent,
  CapabilitySupport,
  Invocation,
  OutputSource,
  Run,
  RunOptions,
  RunResult,
  SessionSupport,
  StdoutAdapter,
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

const assert: (cond: boolean, msg: string) => asserts cond = (cond, msg) => {
  if (!cond) {
    throw new Error(`conformance: ${msg}`);
  }
};

/** What {@link runConformance} needs from an adapter's test suite. */
export interface ConformanceOptions {
  /** Map of scenario name to the raw stdout an adapter's CLI would emit. */
  fixtures: Record<string, string>;
  /**
   * Map of scenario name to a recorded ACP transcript (the JSONL
   * `anyagent-record` writes). Each is replayed through an ACP-mode session,
   * so an adapter's `session: "acp"` mode answers for the same invariants as
   * its stdout mode. Requires a declared `acp` endpoint.
   */
  transcripts?: Record<string, string>;
}

const PROMPT = "conformance prompt";

const checkStream = (name: string, events: AgentEvent[]): void => {
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
    result.text === deltas.map((d) => d.text).join(""),
    `[${name}] result.text must equal concatenation of text-delta events`
  );
  assert(
    !result.events.some((e) => e.type === "done"),
    `[${name}] result.events must not include the done event`
  );

  const sessions = events.filter((e) => e.type === "session");
  assert(
    sessions.length <= 1,
    `[${name}] at most one session event per stream`
  );
  const sessionId = sessions[0]?.type === "session" && sessions[0].sessionId;
  assert(
    sessions.length === 0 || result.sessionId === sessionId,
    `[${name}] result.sessionId must match the session event`
  );
};

const checkStdoutStream = async (
  adapter: StdoutAdapter,
  name: string,
  body: string
): Promise<void> => {
  const agent = new AgentImpl(adapter, fixedRunner(body));
  const events: AgentEvent[] = [];
  for await (const ev of agent.run(PROMPT)) {
    events.push(ev);
  }
  checkStream(name, events);
};

// One recorded line of an ACP transcript: `dir` is the direction as the
// recorder saw it, so an agent's message is `"in"`.
interface TranscriptLine {
  body?: { id?: number; method?: string; result?: Record<string, unknown> };
  dir?: string;
}

// The agent's half of a transcript, in recorded order: `emit` is a message it
// sent on its own, `reply` the answer it gave the client request named by
// `method`.
type ReplayStep =
  | { kind: "emit"; message: unknown }
  | { kind: "reply"; method: string; result: Record<string, unknown> };

const parseTranscript = (name: string, text: string): ReplayStep[] => {
  const methods = new Map<number, string>();
  const steps: ReplayStep[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const { body, dir } = JSON.parse(line) as TranscriptLine;
    if (!body) {
      continue;
    }
    if (dir !== "in") {
      if (body.id !== undefined && body.method !== undefined) {
        methods.set(body.id, body.method);
      }
      continue;
    }
    if (body.method !== undefined) {
      steps.push({ kind: "emit", message: body });
      continue;
    }
    const method = body.id === undefined ? undefined : methods.get(body.id);
    if (method !== undefined && body.result) {
      steps.push({ kind: "reply", method, result: body.result });
    }
  }
  assert(steps.length > 0, `[${name}] the transcript records no agent lines`);
  return steps;
};

// A held prompt response is answered by the abort, so this bound only decides
// how long a turn that never cancels takes to fail.
const HOLD_MS = 2000;

interface ReplayOptions {
  // Holds the prompt response back until the client cancels, so the harness can
  // abort a turn that is genuinely in flight.
  onPromptStreamed?: () => void;
  stopReason?: string;
}

const replayTransport = (
  steps: readonly ReplayStep[],
  opts: ReplayOptions = {}
): AcpTransport => {
  let listener: ((line: string) => void) | undefined;
  let cursor = 0;
  let cancelled = false;
  let markCancelled = (): void => undefined;
  const cancel = new Promise<void>((resolve) => {
    markCancelled = resolve;
  });

  const emit = (message: unknown): void => {
    listener?.(JSON.stringify(message));
  };
  const reply = (id: unknown, result: unknown): void => {
    emit({ id, jsonrpc: "2.0", result });
  };

  const nextReply = (method: string): number => {
    for (let i = cursor; i < steps.length; i += 1) {
      const step = steps[i];
      if (step?.kind === "reply" && step.method === method) {
        return i;
      }
    }
    return -1;
  };

  const answerPrompt = async (
    id: unknown,
    result: Record<string, unknown>
  ): Promise<void> => {
    opts.onPromptStreamed?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      cancel,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, HOLD_MS);
      }),
    ]);
    clearTimeout(timer);
    reply(id, cancelled ? { ...result, stopReason: "cancelled" } : result);
  };

  const answer = (id: unknown, method: string): void => {
    const at = nextReply(method);
    const step = at < 0 ? undefined : steps[at];
    if (step?.kind !== "reply") {
      // A request this adapter adds and the recording never saw — a config
      // option, a close. An empty result keeps the session moving.
      reply(id, {});
      return;
    }
    for (const streamed of steps.slice(cursor, at)) {
      if (streamed.kind === "emit") {
        emit(streamed.message);
      }
    }
    cursor = at + 1;
    const prompt = method === "session/prompt";
    const result =
      prompt && opts.stopReason !== undefined
        ? { ...step.result, stopReason: opts.stopReason }
        : step.result;
    if (prompt && opts.onPromptStreamed) {
      answerPrompt(id, result).catch(() => undefined);
      return;
    }
    reply(id, result);
  };

  return {
    close: () => {
      listener = undefined;
    },
    onDeath: () => undefined,
    onLine: (cb) => {
      listener = cb;
    },
    send: (line) => {
      const message = JSON.parse(line) as { id?: unknown; method?: string };
      if (message.method === "session/cancel") {
        cancelled = true;
        markCancelled();
        return;
      }
      if (message.method === undefined || message.id === undefined) {
        return;
      }
      answer(message.id, message.method);
    },
  };
};

interface Turn {
  events: AgentEvent[];
  failure: unknown;
  result: RunResult | undefined;
  thrown: unknown;
}

const driveTurn = async (
  adapter: Adapter,
  steps: readonly ReplayStep[],
  opts: { abortWhenStreamed?: boolean; stopReason?: string } = {}
): Promise<Turn> => {
  let run: Run | undefined;
  const transport = replayTransport(steps, {
    onPromptStreamed: opts.abortWhenStreamed
      ? () => {
          run?.abort();
        }
      : undefined,
    stopReason: opts.stopReason,
  });
  const session = new AcpSessionImpl(
    new AgentImpl(adapter, fixedRunner("")),
    {},
    () => transport
  );
  run = session.run(PROMPT);

  const events: AgentEvent[] = [];
  let thrown: unknown;
  try {
    for await (const event of run) {
      events.push(event);
    }
  } catch (error) {
    thrown = error;
  }
  let result: RunResult | undefined;
  let failure: unknown;
  try {
    result = await run;
  } catch (error) {
    failure = error;
  }
  await session.close();
  return { events, failure, result, thrown };
};

const checkTerminal = (
  name: string,
  label: string,
  turn: Turn,
  code: string
): void => {
  assert(
    turn.result === undefined,
    `[${name}] ${label} live turn must not resolve`
  );
  assert(
    (turn.failure as { code?: string })?.code === code,
    `[${name}] ${label} live turn must reject with ${code}`
  );
  assert(
    turn.thrown === turn.failure,
    `[${name}] ${label} live turn's iterator and promise must fail with the same error`
  );
  assert(
    !turn.events.some((e) => e.type === "done"),
    `[${name}] ${label} live turn must not emit done`
  );
};

const checkTranscript = async (
  adapter: Adapter,
  name: string,
  transcript: string
): Promise<void> => {
  const steps = parseTranscript(name, transcript);
  const prompt = steps.find(
    (step): step is Extract<ReplayStep, { kind: "reply" }> =>
      step.kind === "reply" && step.method === "session/prompt"
  );
  assert(
    prompt !== undefined,
    `[${name}] the transcript records no session/prompt response`
  );

  const turn = await driveTurn(adapter, steps);
  assert(
    turn.failure === undefined,
    `[${name}] the recorded turn must complete: ${String(turn.failure)}`
  );
  checkStream(name, turn.events);
  assert(
    turn.events[0]?.type === "session",
    `[${name}] a live turn must open with its session event`
  );
  assert(
    turn.events.filter((e) => e.type === "session").length === 1,
    `[${name}] a live turn must emit exactly one session event`
  );
  assert(
    prompt.result.usage === undefined || turn.result?.usage !== undefined,
    `[${name}] a prompt response carrying usage must reach RunResult.usage`
  );

  checkTerminal(
    name,
    "an aborted",
    await driveTurn(adapter, steps, { abortWhenStreamed: true }),
    "Aborted"
  );
  checkTerminal(
    name,
    "a refused",
    await driveTurn(adapter, steps, { stopReason: "refusal" }),
    "Invocation"
  );
};

const throwsUnsupported = async (
  call: () => PromiseLike<unknown>
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
 * Pass `transcripts` as well and the same invariants are checked in ACP mode,
 * plus the ones only it can break: a turn opens with its `session`
 * event, an aborted or failed turn reaches exactly one terminal state, and a
 * prompt response carrying usage reaches `RunResult.usage`.
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

  if (adapter.mode === "stdout") {
    await Promise.all(
      Object.entries(opts.fixtures).map(([name, body]) =>
        checkStdoutStream(adapter, name, body)
      )
    );
  }

  const transcripts = Object.entries(opts.transcripts ?? {});
  if (transcripts.length > 0) {
    assert(
      adapter.mode === "acp",
      "a recorded ACP transcript belongs to an adapter that drives its CLI over ACP"
    );
    await Promise.all(
      transcripts.map(([name, text]) => checkTranscript(adapter, name, text))
    );
  }

  if (caps.readOnly) {
    if (adapter.mode === "stdout") {
      const inv = adapter.buildInvocation("x", { readOnly: true });
      assert(
        inv.command.length > 0 && Array.isArray(inv.args),
        "readOnly must build a valid invocation"
      );
    }
  } else {
    assert(
      await throwsUnsupported(runWith({ readOnly: true })),
      "readOnly on an adapter that declares it false must throw UnsupportedCapability"
    );
  }

  const gated: [
    CapabilitySupport | SessionSupport,
    () => PromiseLike<unknown>,
    string,
  ][] = [
    [caps.modelSelection, runWith({ model: "m" }), "model"],
    [caps.session, runWith({ resume: "s" }), "resume"],
    [caps.systemPrompt, runWith({ systemPrompt: "s" }), "systemPrompt"],
    [caps.mcp, runWith({ mcp: {} }), "mcp"],
    [caps.cwd, runWith({ cwd: "/tmp" }), "cwd"],
    [caps.structuredOutput, runWith({ schema: {} }), "schema"],
    [caps.effort, runWith({ effort: "high" }), "effort"],
    [caps.attachments, runWith({ attachments: ["a.png"] }), "attachments"],
    [
      caps.sessionFork,
      runWith({ forkSession: true, resume: "s" }),
      "forkSession",
    ],
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
