# Contributing

This guide is for contributors changing the AnyAgent repo itself. If you are building on top of the library, read the [docs site](https://anyagent.madusha.me/docs) instead. The main contribution is adding an adapter: support for a new coding-agent CLI.

One rule governs the whole flow: no adapter ships against a guessed schema. Every claim about a CLI's flags and output is verified against a real audit plus recorded real output.

## Before you start

You need three things in place:

- A clone of the repo with `bun install` run at the root
- The target CLI installed and signed in, so you can record real output
- The CLI's headless docs: its non-interactive invocation, streaming format, and autonomy or sandbox flags

Per-CLI facts collected during audits live in `docs/specs/harness-audit.md`. Verify your CLI's row there, or write it, before you write code.

The examples below add a fictional Hopper CLI with the id `hopper`; substitute your CLI's id throughout. Read `packages/anyagent/src/claude-code.ts` alongside this guide as the reference implementation, and mirror its shape.

## Adding an adapter

### 1. Spec first

Confirm the CLI's row in `docs/specs/harness-audit.md`: invocation, streaming format, autonomy and sandbox flags. Nothing downstream is trustworthy until the audit is.

### 2. Implement the contract

Implement the `Adapter` interface in `packages/anyagent/src/hopper.ts` and export it as a factory function. Full field-level docs live in the TSDoc on `Adapter` (and `AdapterMeta`, `DetectionSpec`, `Invocation`, `OutputSource`, `SessionSeed`) in `packages/anyagent/src/types.ts`.

Two constraints that are not in the types:

- Declare `capabilities` `as const satisfies Capabilities` so the literal types reach consumers and an unsupported option fails to compile. `authStatus` and `listModels` are required exactly when the matching capability is declared, and must never cost a model call.
- Keep `buildInvocation` pure: it maps the prompt and validated options to command, args, env, and stdin `input`, and never launches anything. The core spawns, which keeps adapters testable offline. Pipe the prompt through `Invocation.input`, never a positional argument, so a large prompt cannot exceed the OS argv limit.

`acp` declares an ACP endpoint that backs a native-tier session; `sessionSeed` supplies a resume handle up front for a CLI that reveals none headless (goose).

### 3. Map output to events in parse

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

### 5. Record real fixtures

Fixtures are recorded real CLI output, checked into `packages/anyagent/test/fixtures/hopper/`. The recorder builds the read-only invocation where the CLI honors one, runs it, and writes the raw lines. Record from `packages/anyagent/`:

```bash
bun src/internal/record.ts hopper simple "Reply with exactly the word: pong"
# wrote test/fixtures/hopper/simple.jsonl
```

Record at least a `simple` scenario. Add `tools` and `edit` scenarios when the CLI's tool-call and file-change output has shapes `simple` does not exercise.

### 6. Run the conformance suite

`runConformance` replays your fixtures through the full pipeline and asserts the contract invariants. Add a test to `packages/anyagent/test/conformance.test.ts`:

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

An adapter with an ACP endpoint passes `transcripts: { recorded: read("fixtures/acp/hopper.jsonl") }` too, which replays the recorded transcript through a live session.

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
3. Recorded fixtures live in `test/fixtures/hopper/`
4. A conformance test covers those fixtures
5. A `hopper.live.test.ts` includes the strict-mode drift canary
6. `bun run check && bun run types && bun test` is green at the repo root
7. A changeset describes the change: run `bun run changeset` and commit the generated file

Declare `false` for any capability you have not verified against real output. Honest capabilities matter more than broad ones.

## Releasing

Versioning is driven by [changesets](https://github.com/changesets/changesets). Every PR with a user-visible change includes a changeset (`bun run changeset`); the release workflow on `main` collects them into a "Version Packages" PR, and merging that PR publishes `anyagent-js` to npm and tags the release. `bun run release` builds and publishes from a local checkout if the workflow is unavailable.

## Contract invariants

`runConformance` in `packages/anyagent/src/conformance.ts` is the executable half of the contract; it asserts what every adapter must uphold: exactly one terminal `done` per stream, `result.text` equal to the concatenated text deltas, a `sessionId` consistent with the `session` event, a valid invocation for whatever the capabilities declare, and an `UnsupportedCapability` throw for everything they do not, `authStatus()` and `models()` included. Recorded ACP transcripts hold the live tier to those same invariants plus the ones only it can break: a turn opens with its `session` event, an aborted or failed turn reaches exactly one terminal state, and a prompt response carrying usage reaches `RunResult.usage`. Read that file rather than reimplement the checks. Conformance helpers (`sourceFromBody`, `fixedRunner`) live in the same file.

## KnownAgents for custom adapter authors

An adapter published outside this repo teaches the `AgentId` type about its own id through module augmentation, so the custom id autocompletes alongside the built-ins:

```ts
declare module "anyagent-js/types" {
  interface KnownAgents {
    "acme-cli": true;
  }
}
```
