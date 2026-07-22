import { spawn } from "node:child_process";
import type {
  PermissionOption as AcpPermissionOption,
  ContentBlock,
  PermissionOptionKind,
  PromptResponse,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";

import { AnyAgentError } from "../errors.js";
import type {
  Agent,
  AgentEvent,
  Capabilities,
  Invocation,
  OutputSource,
  PermissionOption,
  Run,
  RunOptions,
  RunResult,
  Session,
  SessionKey,
  SessionOptions,
  ToolName,
} from "../types.js";
import type { AcpSession, AcpTransport } from "./acp.js";
import { connect } from "./acp.js";
import { RunHandle } from "./run.js";
import { SessionImpl } from "./session.js";

type Runner = (invocation: Invocation, signal?: AbortSignal) => OutputSource;

/**
 * Builds the {@link AcpTransport} for a native session. The default spawns the
 * ACP endpoint and bridges its stdio; tests inject a scripted transport so no
 * process is launched.
 */
export type AcpTransportFactory = (invocation: Invocation) => AcpTransport;

// The stop reasons that resolve a turn cleanly. `cancelled` becomes `Aborted`
// and everything else (refusal, unknown) becomes an `Invocation` error.
const SUCCESS_STOPS = new Set<StopReason>([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
]);

// Common ACP tool names/kinds mapped onto the shared {@link ToolName}
// vocabulary; anything outside it keeps its native name.
const TOOL_ALIASES: Record<string, ToolName> = {
  bash: "bash",
  edit: "edit",
  glob: "glob",
  grep: "grep",
  read: "read",
  search: "grep",
  shell: "bash",
  web_search: "webSearch",
  websearch: "webSearch",
  write: "write",
};

const toToolName = (nativeName: string): ToolName =>
  TOOL_ALIASES[nativeName.toLowerCase()] ?? nativeName;

const PERMISSION_KIND: Record<PermissionOptionKind, PermissionOption["kind"]> =
  {
    allow_always: "allow-always",
    allow_once: "allow-once",
    reject_always: "reject-always",
    reject_once: "reject-once",
  };

const toPermissionOption = (option: AcpPermissionOption): PermissionOption => ({
  id: option.optionId,
  kind: PERMISSION_KIND[option.kind],
  label: option.name,
});

const textOf = (content: ContentBlock): string | undefined =>
  content.type === "text" ? content.text : undefined;

// Translate one ACP `session/update` into a normalized {@link AgentEvent}, or
// `undefined` for update kinds this build does not surface. The raw update
// rides along on every event emitted.
const translateUpdate = (update: SessionUpdate): AgentEvent | undefined => {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf(update.content);
      return text === undefined
        ? undefined
        : { raw: update, text, type: "text-delta" };
    }
    case "agent_thought_chunk": {
      const text = textOf(update.content);
      return text === undefined
        ? undefined
        : { raw: update, text, type: "reasoning-delta" };
    }
    case "tool_call": {
      const nativeName = update.name ?? update.title;
      return {
        callId: update.toolCallId,
        input: update.rawInput,
        name: toToolName(nativeName),
        nativeName,
        raw: update,
        type: "tool-call",
      };
    }
    case "tool_call_update": {
      if (update.status !== "completed") {
        return;
      }
      const nativeName = update.name ?? update.toolCallId;
      return {
        callId: update.toolCallId,
        name: toToolName(nativeName),
        nativeName,
        output: update.rawOutput ?? update.content,
        raw: update,
        type: "tool-result",
      };
    }
    default:
      return;
  }
};

// The default transport: spawn the ACP endpoint and frame its stdio one
// JSON-RPC message per line. `spawnChild` cannot be reused here because it ends
// the child's stdin, whereas an ACP duplex writes to it for the session's life.
const spawnTransport = (invocation: Invocation): AcpTransport => {
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env ? { ...process.env, ...invocation.env } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let listener: ((line: string) => void) | undefined;
  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      listener?.(line);
      newline = buffer.indexOf("\n");
    }
  });
  return {
    close: () => {
      child.kill();
    },
    onLine: (cb) => {
      listener = cb;
    },
    send: (line) => {
      child.stdin?.write(`${line}\n`);
    },
  };
};

// One in-flight native turn: its collected events and text, plus the handle to
// push them into.
interface ActiveTurn {
  events: AgentEvent[];
  run: AcpTurnRun;
  text: string[];
}

// A native session may find its ACP reattachment unsupported and fall back to
// the emulated cursor; the mode decided on the first turn covers every turn.
type Mode =
  | { kind: "native"; live: AcpSession }
  | { kind: "emulated"; delegate: SessionImpl };

// A {@link Run} fed by translated ACP notifications rather than a spawned CLI.
// `abort` sends `session/cancel`; the driver pushes events and settles it.
class AcpTurnRun extends RunHandle {
  readonly #onAbort: () => void;

  constructor(onAbort: () => void) {
    super();
    this.#onAbort = onAbort;
  }

  override abort(): void {
    this.#onAbort();
  }

  push(event: AgentEvent): void {
    this.emit(event);
  }

  settleOk(result: RunResult): void {
    this.emit({ result, type: "done" });
    this.finish();
    this.resolve(result);
  }

  settleErr(failure: unknown): void {
    this.finish(failure);
    this.reject(failure);
  }
}

// The native {@link Session}: one live ACP connection for its lifetime. It is
// lazy — the connection opens on the first `run` — and turns queue through the
// same FIFO discipline as the emulated tier, one live `session/prompt` at a
// time. `steer` injects an extra prompt; permission requests are surfaced as
// events and auto-answered so an unattended run never hangs.
export class AcpSessionImpl<C extends Capabilities = Capabilities>
  implements Session<C>
{
  readonly agent: Agent<C>;
  readonly #runner: Runner;
  readonly #transportFactory: AcpTransportFactory;
  readonly #resume: string | undefined;
  #id: string | undefined;
  #live: AcpSession | undefined;
  #modePromise: Promise<Mode> | undefined;
  #active: ActiveTurn | undefined;
  readonly #queue: Array<() => Promise<void>> = [];
  #draining = false;

  constructor(
    agent: Agent<C>,
    runner: Runner,
    opts: SessionOptions = {},
    transportFactory: AcpTransportFactory = spawnTransport
  ) {
    if (opts.fork === true) {
      throw new AnyAgentError(
        "InvalidOptions",
        `${agent.adapter.meta.id}: fork is not yet supported on live sessions`
      );
    }
    this.agent = agent;
    this.#runner = runner;
    this.#transportFactory = transportFactory;
    this.#resume = opts.resume;
    this.#id = opts.resume;
  }

  get id(): string | undefined {
    return this.#id;
  }

  supports(...keys: SessionKey[]): boolean {
    // The live tier provides `steer`; `respond` waits for the onPermission
    // design, so it stays gated off this build.
    return keys.every((key) => key === "steer");
  }

  steer(text: string): void {
    const live = this.#live;
    if (!live) {
      throw new AnyAgentError(
        "InvalidOptions",
        "no live turn to steer yet; call run() first"
      );
    }
    // Fire-and-forget: an additional prompt on the running turn. A failure
    // surfaces on the turn it was meant to guide.
    const turn = live.prompt(text);
    turn.result.catch((error) => {
      this.#active?.run.settleErr(AnyAgentError.wrap(error));
    });
  }

  respond(_requestId: string, _choice: string): void {
    throw new AnyAgentError(
      "UnsupportedCapability",
      "manual permission responses arrive with onPermission; this build auto-answers permission requests"
    );
  }

  run(prompt: string, opts: RunOptions = {}): Run {
    if (opts.resume !== undefined || opts.forkSession !== undefined) {
      throw new AnyAgentError(
        "InvalidOptions",
        "resume and forkSession are owned by the session; use agent.session({ resume, fork })"
      );
    }
    const acpRun = new AcpTurnRun(() => {
      // The turn still ends through its `cancelled` stop reason if the notify
      // never lands, so a send failure is nothing to surface.
      this.#live?.cancel().catch(() => undefined);
    });
    this.#enqueue(() => this.#turn(prompt, opts, acpRun));
    return acpRun;
  }

  #enqueue(task: () => Promise<void>): void {
    this.#queue.push(task);
    this.#drain();
  }

  #drain(): void {
    if (this.#draining) {
      return;
    }
    this.#draining = true;
    this.#processQueue().finally(() => {
      this.#draining = false;
      if (this.#queue.length > 0) {
        this.#drain();
      }
    });
  }

  async #processQueue(): Promise<void> {
    let task = this.#queue.shift();
    while (task) {
      // biome-ignore lint/performance/noAwaitInLoops: one live turn at a time by contract.
      await task();
      task = this.#queue.shift();
    }
  }

  async #turn(
    prompt: string,
    opts: RunOptions,
    acpRun: AcpTurnRun
  ): Promise<void> {
    try {
      const mode = await this.#ensureMode(opts);
      if (mode.kind === "emulated") {
        await this.#bridgeEmulated(mode.delegate, prompt, opts, acpRun);
        return;
      }
      await this.#driveNative(mode.live, prompt, acpRun);
    } catch (error) {
      acpRun.settleErr(AnyAgentError.wrap(error));
    }
  }

  #ensureMode(firstOpts: RunOptions): Promise<Mode> {
    this.#modePromise ??= this.#connect(firstOpts);
    return this.#modePromise;
  }

  async #connect(firstOpts: RunOptions): Promise<Mode> {
    const command = this.agent.adapter.acp?.command;
    const bin = command?.[0];
    if (!bin) {
      throw new AnyAgentError(
        "UnsupportedCapability",
        `${this.agent.adapter.meta.id} declares no ACP endpoint`
      );
    }
    // The first turn's cwd is both the child's cwd and the ACP session cwd.
    const cwd = firstOpts.cwd ?? process.cwd();
    const transport = this.#transportFactory({
      args: command.slice(1),
      command: bin,
      cwd,
      env: firstOpts.env,
    });
    const client = connect(transport, { name: "anyagent" });
    client.onPermissionRequest((request) => this.#onPermission(request));
    await client.initialize();

    if (this.#resume !== undefined) {
      if (client.capabilities?.loadSession) {
        const live = await client.loadSession({ cwd, sessionId: this.#resume });
        this.#live = live;
        this.#id = live.sessionId;
        return { kind: "native", live };
      }
      // Mixed tier: the CLI still resumes cross-process through its own flag
      // even though ACP `session/load` is unavailable (gemini). Reattachment
      // falls back to the emulated print-mode cursor for the whole session.
      client.close();
      const delegate = new SessionImpl<C>(
        this.agent,
        this.#runner,
        { resume: this.#resume },
        true
      );
      return { delegate, kind: "emulated" };
    }

    const live = await client.newSession({ cwd });
    this.#live = live;
    this.#id = live.sessionId;
    return { kind: "native", live };
  }

  #onPermission(request: RequestPermissionRequest): RequestPermissionOutcome {
    const active = this.#active;
    if (active) {
      const nativeName =
        request.toolCall.name ??
        request.toolCall.title ??
        request.toolCall.toolCallId;
      this.#emit(active, {
        input: request.toolCall.rawInput,
        name: toToolName(nativeName),
        nativeName,
        options: request.options.map(toPermissionOption),
        raw: request,
        requestId: request.toolCall.toolCallId,
        type: "permission-request",
      });
    }
    // Unattended contract: auto-select the first allow-kind option so a plain
    // run never blocks; cancel when the agent offers no way to allow.
    const allow = request.options.find(
      (option) => option.kind === "allow_once" || option.kind === "allow_always"
    );
    if (allow) {
      return { optionId: allow.optionId, outcome: "selected" };
    }
    return { outcome: "cancelled" };
  }

  #emit(active: ActiveTurn, event: AgentEvent): void {
    if (event.type === "text-delta") {
      active.text.push(event.text);
    }
    active.events.push(event);
    active.run.push(event);
  }

  async #driveNative(
    live: AcpSession,
    prompt: string,
    acpRun: AcpTurnRun
  ): Promise<void> {
    const active: ActiveTurn = { events: [], run: acpRun, text: [] };
    this.#active = active;
    const turn = live.prompt(prompt, (update) => {
      const event = translateUpdate(update);
      if (event) {
        this.#emit(active, event);
      }
    });
    let response: PromptResponse;
    try {
      response = await turn.result;
    } finally {
      this.#active = undefined;
    }
    const stop = response.stopReason;
    if (stop === "cancelled") {
      acpRun.settleErr(
        new AnyAgentError("Aborted", "the run was aborted", { raw: response })
      );
      return;
    }
    if (!SUCCESS_STOPS.has(stop)) {
      acpRun.settleErr(
        new AnyAgentError(
          "Invocation",
          `the agent ended the turn with stop reason "${stop}"`,
          { raw: response }
        )
      );
      return;
    }
    this.#id = live.sessionId;
    acpRun.settleOk({
      events: active.events,
      raw: response,
      sessionId: live.sessionId,
      text: active.text.join(""),
    });
  }

  async #bridgeEmulated(
    delegate: SessionImpl,
    prompt: string,
    opts: RunOptions,
    acpRun: AcpTurnRun
  ): Promise<void> {
    // Relay the emulated cursor's turn through this handle: the print-mode
    // runner drives it, we forward every event and settle on its result.
    const run = delegate.run(prompt, opts);
    for await (const event of run) {
      if (event.type !== "done") {
        acpRun.push(event);
      }
    }
    const result = await run;
    this.#id = result.sessionId ?? this.#id;
    acpRun.settleOk(result);
  }
}
