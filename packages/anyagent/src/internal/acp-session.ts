import { spawn } from "node:child_process";
import type {
  McpServer as AcpMcpServer,
  PermissionOption as AcpPermissionOption,
  Usage as AcpUsage,
  ContentBlock,
  Cost,
  PermissionOptionKind,
  PromptResponse,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionNotification,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";

import { AnyAgentError } from "../errors.js";
import type {
  AcpSettings,
  Agent,
  AgentEvent,
  Capabilities,
  Invocation,
  McpConfig,
  OutputSource,
  PermissionOption,
  Run,
  RunOptions,
  RunResult,
  Session,
  SessionKey,
  SessionOptions,
  ToolName,
  Usage,
} from "../types.js";
import type { AcpClient, AcpSession, AcpTransport } from "./acp.js";
import { connect } from "./acp.js";
import { validateOptions } from "./capabilities.js";
import { promptWithSchema } from "./emulate.js";
import { RunHandle, runWithSchema } from "./run.js";
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

// The `ToolKind`s that cannot change the machine. `kind` is optional on the
// wire, so a read-only turn denies everything else, unannounced included.
const READ_ONLY_KINDS = new Set<string>(["fetch", "read", "search", "think"]);

const denial = (
  request: RequestPermissionRequest
): RequestPermissionOutcome => {
  const reject = request.options.find(
    (option) => option.kind === "reject_once" || option.kind === "reject_always"
  );
  return reject
    ? { optionId: reject.optionId, outcome: "selected" }
    : { outcome: "cancelled" };
};

const toAcpMcpServers = (mcp: McpConfig | undefined): AcpMcpServer[] => {
  const servers: AcpMcpServer[] = [];
  for (const [name, server] of Object.entries(mcp ?? {})) {
    if (server.url !== undefined) {
      servers.push({ headers: [], name, type: "http", url: server.url });
      continue;
    }
    if (server.command === undefined) {
      throw new AnyAgentError(
        "InvalidOptions",
        `mcp server "${name}" needs a command or a url`
      );
    }
    servers.push({
      args: server.args ?? [],
      command: server.command,
      env: Object.entries(server.env ?? {}).map(([key, value]) => ({
        name: key,
        value,
      })),
      name,
    });
  }
  return servers;
};

const textOf = (content: ContentBlock): string | undefined =>
  content.type === "text" ? content.text : undefined;

const aborted = (): AnyAgentError =>
  new AnyAgentError("Aborted", "the run was aborted");

const whenAborted = (signal: AbortSignal, listener: () => void): void => {
  if (signal.aborted) {
    listener();
    return;
  }
  signal.addEventListener("abort", listener);
};

interface ToolIdentity {
  name: ToolName;
  nativeName: string;
}

// Only a USD cost maps onto the normalized field; any other currency stays on
// the event's `raw`.
const usdOf = (cost: Cost | null | undefined): number | undefined =>
  cost && cost.currency.toUpperCase() === "USD" ? cost.amount : undefined;

const toUsage = (usage: AcpUsage | null | undefined): Usage | undefined =>
  usage
    ? {
        cacheReadTokens: usage.cachedReadTokens ?? undefined,
        cacheWriteTokens: usage.cachedWriteTokens ?? undefined,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.thoughtTokens ?? undefined,
      }
    : undefined;

// A tool call announces its name once, so `tools` carries that identity forward
// to the update that ends it.
const translateUpdate = (
  update: SessionUpdate,
  tools: Map<string, ToolIdentity>
): AgentEvent | undefined => {
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
      const identity: ToolIdentity = {
        name: toToolName(nativeName),
        nativeName,
      };
      tools.set(update.toolCallId, identity);
      return {
        ...identity,
        callId: update.toolCallId,
        input: update.rawInput,
        raw: update,
        type: "tool-call",
      };
    }
    case "tool_call_update": {
      // A call ends either way; `failed` carries its error payload as the
      // result. Anything else is progress on a call still running.
      if (update.status !== "completed" && update.status !== "failed") {
        return;
      }
      const announced = tools.get(update.toolCallId);
      const nativeName = announced?.nativeName ?? update.name ?? "unknown";
      return {
        callId: update.toolCallId,
        name: announced?.name ?? toToolName(nativeName),
        nativeName,
        output: update.rawOutput ?? update.content,
        raw: update,
        type: "tool-result",
      };
    }
    case "usage_update": {
      const costUsd = usdOf(update.cost);
      return costUsd === undefined
        ? undefined
        : { raw: update, type: "usage", usage: { costUsd } };
    }
    default:
      return;
  }
};

const STDERR_SNIPPET_LEN = 200;

// The default transport: spawn the ACP endpoint and frame its stdio one
// JSON-RPC message per line. `spawnChild` cannot be reused here because it ends
// the child's stdin, whereas an ACP duplex writes to it for the session's life.
// stderr is drained for its whole life, or the child blocks on a full pipe.
const spawnTransport = (invocation: Invocation): AcpTransport => {
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env ? { ...process.env, ...invocation.env } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const argv = [invocation.command, ...invocation.args];
  let stderrText = "";
  let killed = false;
  let death: AnyAgentError | undefined;
  let onDeath: ((failure: AnyAgentError) => void) | undefined;
  // The child can die before the client registers its listener, so the first
  // failure is held and replayed there.
  const die = (failure: AnyAgentError): void => {
    if (death) {
      return;
    }
    death = failure;
    onDeath?.(failure);
  };
  const failed = (message: string, raw?: unknown): AnyAgentError =>
    new AnyAgentError("Invocation", message, { argv, raw, stderr: stderrText });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrText += chunk;
  });
  // Writing to a child that already exited raises EPIPE; the exit that caused
  // it is what the turn should see.
  child.stdin?.on("error", () => undefined);
  child.on("error", (error: Error) => {
    die(
      failed(`failed to spawn ${invocation.command}: ${error.message}`, error)
    );
  });
  child.on("close", (code) => {
    if (killed) {
      die(
        new AnyAgentError("Aborted", `${invocation.command} run aborted`, {
          argv,
          stderr: stderrText,
        })
      );
      return;
    }
    const tail = stderrText.trim().slice(0, STDERR_SNIPPET_LEN);
    die(
      failed(`${invocation.command} exited ${code}${tail ? `: ${tail}` : ""}`)
    );
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
      killed = true;
      child.kill();
    },
    onDeath: (cb) => {
      onDeath = cb;
      if (death) {
        cb(death);
      }
    },
    onLine: (cb) => {
      listener = cb;
    },
    send: (line) => {
      child.stdin?.write(`${line}\n`);
    },
  };
};

// `failure` is set when something outside the prompt — a rejected `steer` —
// already decided the turn is lost.
interface ActiveTurn {
  events: AgentEvent[];
  failure?: AnyAgentError;
  readOnly: boolean;
  run: AcpTurnRun;
  sessionId?: string;
  text: string[];
  tools: Map<string, ToolIdentity>;
}

interface QueuedTurn {
  run: AcpTurnRun;
  task: () => Promise<void>;
}

// A native session may find its ACP reattachment unsupported and fall back to
// the emulated cursor; the mode decided on the first turn covers every turn.
type Mode =
  | { kind: "native"; live: AcpSession }
  | { kind: "emulated"; delegate: SessionImpl };

// A {@link Run} fed by translated ACP notifications rather than a spawned CLI.
// `abort` reaches this turn only; the session decides what that means. Settling
// is first-wins.
class AcpTurnRun extends RunHandle {
  readonly #controller = new AbortController();

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  override abort(): void {
    this.#controller.abort();
  }

  push(event: AgentEvent): void {
    this.emit(event);
  }

  settleOk(result: RunResult): void {
    if (this.settled) {
      return;
    }
    this.emit({ result, type: "done" });
    this.finish();
    this.resolve(result);
  }

  settleErr(failure: unknown): void {
    if (this.settled) {
      return;
    }
    this.finish(failure);
    this.reject(failure);
  }
}

// The native {@link Session}: one live ACP connection for its lifetime. It is
// lazy — the connection opens on the first `run` — and turns queue through the
// same FIFO discipline as the emulated tier, one live `session/prompt` at a
// time. `steer` injects an extra prompt; permission requests are surfaced as
// events and auto-answered so a run never blocks waiting on an answer.
export class AcpSessionImpl<C extends Capabilities = Capabilities>
  implements Session<C>
{
  readonly agent: Agent<C>;
  readonly #runner: Runner;
  readonly #transportFactory: AcpTransportFactory;
  readonly #resume: string | undefined;
  readonly #settings: SessionOptions;
  readonly #acp: AcpSettings;
  readonly #mcpServers: AcpMcpServer[];
  #id: string | undefined;
  #client: AcpClient | undefined;
  #live: AcpSession | undefined;
  #delegate: SessionImpl<C> | undefined;
  #modePromise: Promise<Mode> | undefined;
  #active: ActiveTurn | undefined;
  #inFlight: AcpTurnRun | undefined;
  #readOnly = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  readonly #queue: QueuedTurn[] = [];
  #draining = false;

  constructor(
    agent: Agent<C>,
    runner: Runner,
    opts: SessionOptions = {},
    transportFactory: AcpTransportFactory = spawnTransport
  ) {
    this.agent = agent;
    this.#runner = runner;
    this.#transportFactory = transportFactory;
    this.#resume = opts.resume;
    this.#id = opts.resume;
    this.#settings = opts;
    // Both throw for a setting this endpoint cannot carry — here, before the
    // constructor returns, so nothing has spawned yet.
    this.#acp = agent.adapter.acp?.settings?.(opts) ?? {};
    this.#mcpServers = toAcpMcpServers(opts.mcp);
    if (opts.fork === true) {
      // No recorded `session/fork` transcript exists to code against, so a
      // branch runs on the print tier, whose copy-on-resume flag is verified.
      this.#delegate = new SessionImpl<C>(agent, runner, opts, true);
      this.#modePromise = Promise.resolve({
        delegate: this.#delegate,
        kind: "emulated",
      });
    }
  }

  get id(): string | undefined {
    return this.#id;
  }

  supports(...keys: SessionKey[]): boolean {
    // The live tier provides `steer`; `respond` waits for the onPermission
    // design, so it stays gated off this build.
    return this.#delegate === undefined && keys.every((key) => key === "steer");
  }

  steer(text: string): void {
    const live = this.#live;
    if (!live) {
      throw new AnyAgentError(
        "InvalidOptions",
        "no live turn to steer yet; call run() first"
      );
    }
    // Fire-and-forget: a failure ends the turn it was meant to guide — once,
    // there.
    const active = this.#active;
    live.prompt(text).result.catch((error: unknown) => {
      this.#failSteer(live, error, active);
    });
  }

  #failSteer(
    live: AcpSession,
    error: unknown,
    active: ActiveTurn | undefined
  ): void {
    if (!active) {
      return;
    }
    active.failure = AnyAgentError.wrap(error);
    active.run.settleErr(active.failure);
    if (this.#active === active) {
      live.cancel().catch(() => undefined);
    }
  }

  respond(_requestId: string, _choice: string): void {
    throw new AnyAgentError(
      "UnsupportedCapability",
      "manual permission responses arrive with onPermission; this build auto-answers permission requests"
    );
  }

  close(): Promise<void> {
    this.#closing ??= this.#teardown();
    return this.#closing;
  }

  async #teardown(): Promise<void> {
    this.#closed = true;
    for (const queued of this.#queue.splice(0)) {
      queued.run.settleErr(aborted());
    }
    // Settled here rather than cancelled over the wire: the channel is about
    // to go, so waiting for a stop reason that may never arrive would hang.
    this.#inFlight?.settleErr(aborted());
    await this.#delegate?.close();
    const live = this.#live;
    if (live && this.#client?.capabilities?.sessionCapabilities?.close) {
      // The connection dies next either way, so a refused close changes
      // nothing worth surfacing.
      await live.close().catch(() => undefined);
    }
    this.#client?.close();
  }

  run(prompt: string, opts: RunOptions = {}): Run {
    if (this.#closed) {
      throw new AnyAgentError("InvalidOptions", "this session is closed");
    }
    if (opts.resume !== undefined || opts.forkSession !== undefined) {
      throw new AnyAgentError(
        "InvalidOptions",
        "resume and forkSession are owned by the session; use agent.session({ resume, fork })"
      );
    }
    const acpRun = new AcpTurnRun();
    const turn: QueuedTurn = {
      run: acpRun,
      task: () => this.#turn(prompt, opts, acpRun),
    };
    this.#queue.push(turn);
    whenAborted(acpRun.signal, () => {
      this.#abortTurn(turn);
    });
    if (opts.signal) {
      whenAborted(opts.signal, () => {
        acpRun.abort();
      });
    }
    this.#drain();
    return acpRun;
  }

  // Turn-scoped: aborting a queued turn never disturbs the one in flight.
  #abortTurn(turn: QueuedTurn): void {
    if (this.#inFlight === turn.run && this.#live) {
      // The turn still ends through its `cancelled` stop reason if the notify
      // never lands, so a send failure is nothing to surface.
      this.#live.cancel().catch(() => undefined);
      return;
    }
    const at = this.#queue.indexOf(turn);
    if (at >= 0) {
      this.#queue.splice(at, 1);
    }
    turn.run.settleErr(aborted());
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
    let turn = this.#queue.shift();
    while (turn) {
      this.#inFlight = turn.run;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one live turn at a time by contract.
        await turn.task();
      } catch (failure) {
        // The conversation is broken where it stands, as on the emulated tier.
        for (const queued of this.#queue.splice(0)) {
          queued.run.settleErr(failure);
        }
      } finally {
        this.#inFlight = undefined;
      }
      turn = this.#queue.shift();
    }
  }

  async #turn(
    prompt: string,
    opts: RunOptions,
    acpRun: AcpTurnRun
  ): Promise<void> {
    try {
      // Before the connection opens, so a live session fails fast on an
      // option this agent cannot honor exactly as every other path does.
      validateOptions(this.agent.adapter, opts);
      const mode = await this.#ensureMode();
      if (mode.kind === "emulated") {
        await this.#bridgeEmulated(mode.delegate, prompt, opts, acpRun);
        return;
      }
      await this.#applyReadOnly(mode.live, opts.readOnly === true);
      await this.#driveNative(mode.live, prompt, opts, acpRun);
    } catch (error) {
      const failure = AnyAgentError.wrap(error);
      acpRun.settleErr(failure);
      throw failure;
    }
  }

  #ensureMode(): Promise<Mode> {
    this.#modePromise ??= this.#connect();
    return this.#modePromise;
  }

  async #connect(): Promise<Mode> {
    const spec = this.agent.adapter.acp;
    const bin = spec?.command[0];
    if (!(spec && bin)) {
      throw new AnyAgentError(
        "UnsupportedCapability",
        `${this.agent.adapter.meta.id} declares no ACP endpoint`
      );
    }
    // The session's cwd is both the child's cwd and the ACP session cwd.
    const cwd = this.#settings.cwd ?? process.cwd();
    const transport = this.#transportFactory({
      args: [
        ...spec.command.slice(1),
        ...(this.#acp.args ?? []),
        ...(this.#settings.extraArgs ?? []),
      ],
      command: bin,
      cwd,
      env: this.#settings.env,
    });
    const client = connect(transport, { name: "anyagent" });
    this.#client = client;
    client.onPermissionRequest((request) => this.#onPermission(request));
    await client.initialize();

    if (this.#resume !== undefined) {
      if (client.capabilities?.loadSession) {
        return await this.#open(
          client.loadSession({
            cwd,
            mcpServers: this.#mcpServers,
            sessionId: this.#resume,
          })
        );
      }
      // Mixed tier: the CLI still resumes cross-process through its own flag
      // even though ACP `session/load` is unavailable (gemini). Reattachment
      // falls back to the emulated print-mode cursor for the whole session.
      client.close();
      this.#client = undefined;
      this.#delegate = new SessionImpl<C>(
        this.agent,
        this.#runner,
        { ...this.#settings, resume: this.#resume },
        true
      );
      return { delegate: this.#delegate, kind: "emulated" };
    }

    return await this.#open(
      client.newSession({ cwd, mcpServers: this.#mcpServers })
    );
  }

  async #open(opening: Promise<AcpSession>): Promise<Mode> {
    const live = await opening;
    this.#live = live;
    this.#id = live.sessionId;
    for (const option of this.#acp.configOptions ?? []) {
      // biome-ignore lint/performance/noAwaitInLoops: each option is acknowledged before the next.
      await live.setConfigOption(option);
    }
    return { kind: "native", live };
  }

  // Mode is only used where the agent advertised the option's current value,
  // so a later turn can always put back what this one found.
  async #applyReadOnly(live: AcpSession, readOnly: boolean): Promise<void> {
    const option = this.agent.adapter.acp?.readOnly;
    if (!option || readOnly === this.#readOnly) {
      return;
    }
    const restore = live.config.get(option.configId);
    if (restore === undefined) {
      return;
    }
    await live.setConfigOption({
      configId: option.configId,
      value: readOnly ? option.value : restore,
    });
    this.#readOnly = readOnly;
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
    if (active?.readOnly && !READ_ONLY_KINDS.has(request.toolCall.kind ?? "")) {
      return denial(request);
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

  #emitSession(active: ActiveTurn, sessionId: string, raw?: unknown): void {
    if (active.sessionId === sessionId) {
      return;
    }
    active.sessionId = sessionId;
    this.#id = sessionId;
    this.#emit(active, { raw, sessionId, type: "session" });
  }

  #onUpdate(
    active: ActiveTurn,
    update: SessionUpdate,
    notification: SessionNotification
  ): void {
    if (update.sessionUpdate === "session_info_update") {
      this.#emitSession(active, notification.sessionId, update);
      return;
    }
    const event = translateUpdate(update, active.tools);
    if (event) {
      this.#emit(active, event);
    }
  }

  async #driveNative(
    live: AcpSession,
    prompt: string,
    opts: RunOptions,
    acpRun: AcpTurnRun
  ): Promise<void> {
    const final = await runWithSchema(
      prompt,
      opts,
      (text) => this.#promptOnce(live, text, opts, acpRun),
      (event) => {
        acpRun.push(event);
      }
    );
    this.#id = live.sessionId;
    acpRun.settleOk(final);
  }

  // Failures throw so the caller settles the handle once, after the schema
  // contract has had its say.
  async #promptOnce(
    live: AcpSession,
    prompt: string,
    opts: RunOptions,
    acpRun: AcpTurnRun
  ): Promise<RunResult> {
    if (acpRun.signal.aborted || this.#closed) {
      throw aborted();
    }
    const active: ActiveTurn = {
      events: [],
      readOnly: opts.readOnly === true,
      run: acpRun,
      text: [],
      tools: new Map(),
    };
    this.#active = active;
    this.#emitSession(active, live.sessionId);
    const text =
      opts.schema === undefined
        ? prompt
        : promptWithSchema(prompt, opts.schema);
    const turn = live.prompt(text, (update, notification) => {
      this.#onUpdate(active, update, notification);
    });
    let response: PromptResponse;
    try {
      response = await turn.result;
    } finally {
      this.#active = undefined;
    }
    if (active.failure) {
      throw active.failure;
    }
    const stop = response.stopReason;
    if (stop === "cancelled") {
      throw new AnyAgentError("Aborted", "the run was aborted", {
        raw: response,
      });
    }
    if (!SUCCESS_STOPS.has(stop)) {
      throw new AnyAgentError(
        "Invocation",
        `the agent ended the turn with stop reason "${stop}"`,
        { raw: response }
      );
    }
    const usage = toUsage(response.usage);
    if (usage) {
      this.#emit(active, { raw: response, type: "usage", usage });
    }
    return {
      events: active.events,
      raw: response,
      sessionId: live.sessionId,
      text: active.text.join(""),
      usage,
    };
  }

  async #bridgeEmulated(
    delegate: SessionImpl,
    prompt: string,
    opts: RunOptions,
    acpRun: AcpTurnRun
  ): Promise<void> {
    const run = delegate.run(prompt, opts);
    whenAborted(acpRun.signal, () => {
      run.abort();
    });
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
