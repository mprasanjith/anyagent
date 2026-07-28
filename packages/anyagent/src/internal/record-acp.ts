#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BUILTINS } from "./builtins.js";

// A raw ACP transcript recorder. Unlike src/internal/record.ts (which captures
// a stdout-mode CLI's output), this speaks newline-framed JSON-RPC 2.0 directly
// over the agent's stdio and captures EVERY line both directions. It never
// reuses the AcpClient: the transcript has to be the raw wire, so the session
// gate (docs/specs/sessions.md §6 M-2) can judge a real handshake, not our
// framing of one. The single prompt is trivial and read-only in intent so the
// recording costs next to nothing.

const PROTOCOL_VERSION = 1;
const PROMPT = "Reply with exactly the word: pong";
const TIMEOUT_MS = 120_000;

// One captured wire line. JSON-RPC lines carry `body`; anything the agent
// prints that is not JSON (a stray log line) is kept verbatim as `text`.
interface Entry {
  body?: unknown;
  dir: "in" | "out";
  text?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: raw JSON-RPC is dynamically shaped.
type Json = any;

interface Verdict {
  adapterId: string;
  chunkCount: number;
  loadSession: boolean;
  partial: boolean;
  protocolVersion: number | undefined;
  sessionId: string | undefined;
  stopReason: string | undefined;
}

const isAllowKind = (kind: unknown): boolean =>
  kind === "allow_once" || kind === "allow_always";

const main = async (): Promise<void> => {
  const [id, scratchRoot] = process.argv.slice(2);
  if (!(id && scratchRoot)) {
    process.stderr.write("usage: record-acp <adapterId> <scratchRoot>\n");
    process.exit(2);
  }
  const adapter = BUILTINS.find((a) => a.meta.id === id);
  if (!adapter?.acp) {
    process.stderr.write(`adapter ${id} declares no acp endpoint\n`);
    process.exit(2);
  }

  const [command, ...args] = adapter.acp.command;
  if (!command) {
    process.stderr.write(`adapter ${id} declares an empty acp command\n`);
    process.exit(2);
  }
  const cwd = mkdtempSync(path.join(scratchRoot, `${id}-cwd-`));
  const entries: Entry[] = [];
  const verdict: Verdict = {
    adapterId: id,
    chunkCount: 0,
    loadSession: false,
    partial: false,
    protocolVersion: undefined,
    sessionId: undefined,
    stopReason: undefined,
  };

  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const send = (message: Json): void => {
    entries.push({ body: message, dir: "out" });
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };

  let done: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  // A reverse request from the agent: answer request_permission by selecting
  // the first allow-kind option, and refuse anything else (fs/*, terminal/*)
  // so the agent never stalls waiting on us — the pong prompt needs none.
  const answerRequest = (message: Json): void => {
    if (message.method === "session/request_permission") {
      const options: Json[] = message.params?.options ?? [];
      const allow = options.find((o) => isAllowKind(o.kind));
      const outcome = allow
        ? { optionId: allow.optionId, outcome: "selected" }
        : { outcome: "cancelled" };
      send({ id: message.id, jsonrpc: "2.0", result: { outcome } });
      return;
    }
    send({
      error: { code: -32_601, message: "method not supported by recorder" },
      id: message.id,
      jsonrpc: "2.0",
    });
  };

  // A response to one of our three requests, driving the handshake forward.
  const advance = (message: Json): void => {
    if (message.id === 1) {
      verdict.protocolVersion = message.result?.protocolVersion;
      verdict.loadSession =
        message.result?.agentCapabilities?.loadSession === true;
      send({
        id: 2,
        jsonrpc: "2.0",
        method: "session/new",
        params: { cwd, mcpServers: [] },
      });
      return;
    }
    if (message.id === 2) {
      verdict.sessionId = message.result?.sessionId;
      send({
        id: 3,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: {
          prompt: [{ text: PROMPT, type: "text" }],
          sessionId: verdict.sessionId,
        },
      });
      return;
    }
    if (message.id === 3) {
      verdict.stopReason = message.result?.stopReason;
      done();
    }
  };

  const handle = (message: Json): void => {
    if (message.id !== undefined && typeof message.method === "string") {
      answerRequest(message);
      return;
    }
    if (message.method === "session/update") {
      if (message.params?.update?.sessionUpdate === "agent_message_chunk") {
        verdict.chunkCount += 1;
      }
      return;
    }
    advance(message);
  };

  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.trim().length === 0) {
        continue;
      }
      let parsed: Json;
      try {
        parsed = JSON.parse(line);
      } catch {
        entries.push({ dir: "in", text: line });
        continue;
      }
      entries.push({ body: parsed, dir: "in" });
      handle(parsed);
    }
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error: Error) => {
    stderr += `spawn error: ${String(error)}\n`;
    done();
  });
  child.on("exit", () => done());

  // Kick the handshake off.
  send({
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      clientCapabilities: {},
      clientInfo: { name: "anyagent-recorder", version: "0.0.0" },
      protocolVersion: PROTOCOL_VERSION,
    },
  });

  const timer = setTimeout(() => {
    verdict.partial = true;
    done();
  }, TIMEOUT_MS);
  await finished;
  clearTimeout(timer);
  child.kill();

  const dir = path.join("test/fixtures/acp");
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${id}.jsonl${verdict.partial ? ".partial" : ""}`);
  writeFileSync(out, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  process.stderr.write(`wrote ${out}\n`);
  if (stderr.trim().length > 0) {
    process.stderr.write(`--- child stderr ---\n${stderr}\n`);
  }
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  // A killed child can keep the event loop alive (its own children linger), so
  // exit explicitly once the transcript is on disk.
  process.exit(0);
};

await main();
