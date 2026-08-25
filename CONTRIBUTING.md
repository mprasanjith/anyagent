# Contributing

This guide is for contributors changing the AnyAgent repo itself. If you are building on top of the library, read the [docs site](https://anyagent.madusha.me/docs) instead. The main contribution is adding an adapter: support for a new coding-agent CLI.

One rule governs the whole flow: no adapter ships against a guessed schema. Every claim about a CLI's flags and output is verified against a real audit plus recorded real output.

## Before you start

You need three things in place:

- A clone of the repo with `bun install` run at the root
- The target CLI installed and signed in, so you can record real output
- The CLI's headless docs: its non-interactive invocation, streaming format, and autonomy or sandbox flags

Everything you claim about a CLI has to come from running it. Record what you see — the invocation, the output format, the autonomy flags — and keep that recording in the repo as a fixture. That fixture is the evidence for every capability you declare.

The examples below add a fictional Hopper CLI with the id `hopper`; substitute your CLI's id throughout. Read `packages/anyagent/src/claude-code.ts` alongside this guide as the reference implementation, and mirror its shape.

## Adding an adapter

### 1. Spec first

Run the CLI by hand first and write down four things: how to invoke it non-interactively, what its output looks like, how to give it full autonomy, and how to restrict it to reading. Nothing downstream is trustworthy until you have seen all four yourself.

### 2. Pick a mode and implement its contract

An adapter drives its CLI one way, declared on `mode`. Prefer `"acp"` where the CLI ships an ACP endpoint: the protocol carries streaming, permissions, attachments, and steering, so there is no output format to track.

- `mode: "acp"` (`AcpAdapter`) declares `acp`: the argv that launches the endpoint, an optional `readOnly` config option, and an optional `settings` mapping a session's `SessionOptions` onto the endpoint's own channels. Throw `AnyAgentError` (`code: "UnsupportedCapability"`) from `settings` for a setting the endpoint has no channel for, so the session fails before anything spawns rather than dropping it. Declare `readOnly` only where the endpoint's own option is trustworthy; permission denial holds the line otherwise. `systemPrompt` and `structuredOutput` are never `"native"` here — a live turn carries content blocks and nothing else, so the core emulates both.
- `mode: "stdout"` (`StdoutAdapter`) declares `buildInvocation` and `parse` (see step 3). Sessions here are client-side bookkeeping over one process per turn, so the CLI must reveal a session id in its output for a second turn to resume.

The two field sets are mutually exclusive: declaring the other mode's fields is a compile error. Write the adapter in `packages/anyagent/src/hopper.ts` and export it as a factory function. Full field-level docs live in the TSDoc on those interfaces (and `AdapterMeta`, `DetectionSpec`, `Invocation`, `OutputSource`) in `packages/anyagent/src/types.ts`.

Two constraints that are not in the types:

- Declare `capabilities` `as const satisfies Capabilities` so the literal types reach consumers and an unsupported option fails to compile. `authStatus` and `listModels` are required exactly when the matching capability is declared, and must never cost a model call.
- Keep `buildInvocation` pure: it maps the prompt and validated options to command, args, env, and stdin `input`, and never launches anything. The core spawns, which keeps adapters testable offline. Pipe the prompt through `Invocation.input`, never a positional argument, so a large prompt cannot exceed the OS argv limit.

### 3. Map output to events in parse

This step is for `mode: "stdout"` only; an ACP adapter's events come from the protocol.

`parse` maps process output to normalized events and must end with exactly one `done` event. Under `strict: true`, throw `AnyAgentError` with `code: "Parse"` on any shape you do not recognize; the drift canary depends on strict mode to catch upstream format changes.

When the CLI streams newline-delimited JSON, build `parse` from `ndjsonParser`, as all built-in adapters do. The helper owns line decoding, result buffering, the nonzero-exit `Invocation` throw, and the terminal `done`. You supply three hooks:

```ts
import { AnyAgentError } from "./errors.js";
import { ndjsonParser } from "./ndjson.js";

interface Ctx {
  text: string[];
  raw?: unknown;
}

const parse = ndjsonParser<Ctx>({
  init: () => ({ text: [] }),
  map: (obj, ctx, strict) => {
    const ev = obj as { type: string; text?: string };
    if (ev.type === "message") {
      ctx.text.push(ev.text ?? "");
      return { raw: obj, text: ev.text ?? "", type: "text-delta" };
    }
    if (strict) {
      throw new AnyAgentError("Parse", `unknown event type ${ev.type}`);
    }
    return undefined;
  },
  finalize: (ctx) => ({ events: [], raw: ctx.raw, text: ctx.text.join(""), usage: undefined }),
});
```

`init` creates the per-run accumulator, `map` turns one raw object into event(s) or `undefined` to ignore it, and `finalize` builds the terminal `RunResult`. The parser fills `RunResult.events` from what `map` emitted after `finalize` returns. A real adapter maps its CLI's whole event taxonomy, including tool calls and usage. Relative imports are for in-repo adapters; an adapter published outside this repo imports `ndjsonParser` from `anyagent-js/ndjson` and `AnyAgentError` from `anyagent-js/errors`.

### 4. Register in BUILTINS

Append your factory result to `BUILTINS` in `packages/anyagent/src/internal/builtins.ts`. `detect()` scans that list and the recorder resolves adapters by id from it, so registration comes before recording.

```ts
import { hopper } from "../hopper.js";

export const BUILTINS: Adapter[] = [claudeCode(), codex(), hopper()];
```

### 5. Record real output

A stdout adapter's fixtures are recorded real CLI output, checked into `packages/anyagent/test/fixtures/hopper/`. The recorder builds the read-only invocation where the CLI honors one, runs it, and writes the raw lines. Record from `packages/anyagent/`:

```bash
bun src/internal/record.ts hopper simple "Reply with exactly the word: pong"
# wrote test/fixtures/hopper/simple.jsonl
```

Record at least a `simple` scenario. Add `tools` and `edit` scenarios when the CLI's tool-call and file-change output has shapes `simple` does not exercise.

An ACP adapter records one transcript of a real exchange into `test/fixtures/acp/hopper.jsonl` instead:

```bash
bun src/internal/record-acp.ts hopper /tmp/hopper-scratch
```

### 6. Run the conformance suite

`runConformance` replays your recording through the full pipeline and asserts the contract invariants: a stdout adapter passes `fixtures`, an ACP adapter passes `transcripts`, and the other mode's key is a compile error. Add a test to `packages/anyagent/test/conformance.test.ts`:

```ts
import { test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { hopper } from "../src/hopper.js";
import { runConformance } from "../src/conformance.js";

const read = (p: string) => readFileSync(path.join(import.meta.dir, p), "utf-8");

test("hopper passes conformance", async () => {
  await runConformance(hopper(), { fixtures: { simple: read("fixtures/hopper/simple.jsonl") } });
});
```

An ACP adapter passes `transcripts: { recorded: read("fixtures/acp/hopper.jsonl") }` instead, recorded with `bun src/internal/record-acp.ts hopper <scratchRoot>`; each transcript is replayed through both `agent.run()` and `agent.session()`.

Run it and confirm green before moving on:

```bash
bun test test/conformance.test.ts
```

### 7. Add a live test and drift canary

`test/hopper.live.test.ts` drives the real CLI, opt-in behind `ANYAGENT_LIVE=1` so CI stays hermetic. Mirror `test/claude-code.live.test.ts`: one test runs a trivial prompt and asserts text and usage arrived; the second is the drift canary, which runs fresh CLI output through strict mode so an upstream format change throws instead of silently producing empty text. Assert shape, never content, since agent output is non-deterministic.

```bash
ANYAGENT_LIVE=1 bun test test/hopper.live.test.ts
```

### 8. Add a docs page

Add an adapter page under `apps/web/content/docs/adapters/` following the existing pages. These are now short, roughly 20 lines: a one-line summary, caller-actionable bullets, and a flag table. Do not restate the contract.

## Checklist

Before you open the change, confirm all seven:

1. `src/hopper.ts` exports the `hopper()` factory, with TSDoc on it
2. The adapter is appended to `BUILTINS`
3. A recording lives in `test/fixtures/hopper/` (stdout) or `test/fixtures/acp/hopper.jsonl` (ACP)
4. A conformance test covers it
5. A `hopper.live.test.ts` includes the strict-mode drift canary
6. `bun run check && bun run types && bun test` is green at the repo root
7. A changeset describes the change: run `bun run changeset` and commit the generated file

Declare `false` for any capability you have not verified against real output. Honest capabilities matter more than broad ones.

## Reporting usage limits

`usageStatus` is optional, and `false` is a fine answer — the call returns `{ state: "unknown" }` for those agents rather than throwing. If your CLI can report how much of the user's plan is left, there are three ways to get it, and which one you use decides what you declare:

- **`"native"`** — the CLI has a command or service that reports its own limits. Ask it.
- **`"probed"`** — the CLI leaves a file on the machine with the numbers in it. Read that file with `probe.readFile`, and set `asOf` so callers can judge how stale it is.
- **`"remote"`** — only the vendor knows. Read the credential the CLI already stored, then call the vendor with `probe.fetch`.

`probe.fetch` is **absent unless the user opted in** with `create(agent, { network: true })`. Check for it and return `{ state: "unknown" }` when it is missing — never reach for `globalThis.fetch`, which would make a network call the user did not agree to. Go through the `fetchJson` helper in `src/internal/http.ts` rather than calling `probe.fetch` yourself; it caps the request and refuses to follow a redirect off the original site, so a credential cannot leak to another host.

Talking to a server on the user's own machine is different: nothing leaves the computer, so it needs no opt-in. `probe.localListeners(pattern)` finds the ports a matching local process is listening on, and `probe.fetchLocal` calls them. Both are always present.

Three rules the existing adapters follow, each learned from a real bug:

- **Never refresh a credential.** Vendors that rotate refresh tokens will sign the user out of their own CLI if you use theirs. An expired token means no answer, not a refresh.
- **Set `windowMinutes`, and never infer a window's length from its name.** Codex has shipped its weekly figure in the slot labelled `primary`. If the CLI does not say how long a window is, leave it absent.
- **Do not require a particular window to exist.** Which buckets a plan reports varies by tier, and a parser that insists on a 5-hour bucket will fail outright on an account that has none.

Missing or malformed numbers are always `undefined`, never a default. Reporting "0% used" for a window whose real standing you could not read is the one failure worth avoiding above all others — it reads as reassuring, and it gets acted on.

## Releasing

Versioning is driven by [changesets](https://github.com/changesets/changesets). Every PR with a user-visible change includes a changeset (`bun run changeset`); the release workflow on `main` collects them into a "Version Packages" PR, and merging that PR publishes `anyagent-js` to npm and tags the release. `bun run release` builds and publishes from a local checkout if the workflow is unavailable.

## Contract invariants

`runConformance` in `packages/anyagent/src/conformance.ts` is the executable half of the contract; it asserts what every adapter must uphold whatever its mode: exactly one terminal `done` per stream, `result.text` equal to the concatenated text deltas, a `sessionId` consistent with the `session` event, and an `UnsupportedCapability` throw for everything the capabilities do not declare, `authStatus()` and `models()` included. A stdout adapter also owes a valid invocation for whatever it declares. An ACP adapter owes the invariants only a live connection can break: a turn opens with its `session` event, an aborted or failed turn reaches exactly one terminal state, a prompt response carrying usage reaches `RunResult.usage`, and neither `systemPrompt` nor `structuredOutput` claims to be native. Read that file rather than reimplement the checks. Conformance helpers (`sourceFromBody`, `fixedRunner`) live in the same file.

## KnownAgents for custom adapter authors

An adapter published outside this repo teaches the `AgentId` type about its own id through module augmentation, so the custom id autocompletes alongside the built-ins:

```ts
declare module "anyagent-js/types" {
  interface KnownAgents {
    "acme-cli": true;
  }
}
```
