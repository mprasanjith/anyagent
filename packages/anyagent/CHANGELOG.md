# anyagent-js

## 0.3.0

### Minor Changes

- 23f3f2b: Billing mode, usage windows, and canonical vendors.

  - `AuthStatus.billing` (required): how runs are paid for — `"subscription" | "api-key" | "unknown"` — asserted by each adapter, never inferred from `method` strings; `ModelInfo.billing` can override it per model.
  - `agent.usageStatus(opts?)`: how much of the harness's rolling limits remain. Always callable — a harness with no surface answers `{ state: "unknown" }` instead of throwing. claude-code reads the CLI's cached window snapshot (5-hour, weekly, model-scoped buckets; `asOf` carries the cache's age) and codex asks its app-server live; `{ model }` scopes the answer to one placement.
  - `SystemProbe.rpc`: one-shot JSON-RPC (NDJSON over stdio) service dialogues for discovery, with ordered exchanges and fail-fast on non-JSON output.
  - `modelListing` flips to `"probed"` on claude-code (documented alias vocabulary plus the CLI's cached org entries) and gemini-cli (documented aliases and full ids).
  - `ModelInfo.provider` now means the canonical model vendor — the pricing join key — never a gateway or biller: `kilo/~anthropic/…` yields `"anthropic"`, `openrouter/openai/…` yields `"openai"`, and `opencode/big-pickle` yields nothing. Previously the opencode, kilo, and pi adapters put the leading gateway segment here.
  - gemini-cli turns now report token usage, read from the endpoint's `_meta.quota` channel.

## 0.2.1

### Patch Changes

- 2544a59: Fix native structured output being dropped when the model streams prose before answering through the schema channel. Claude Code ≥ 2.1.220 freely emits preamble text (and injects a `[structured-output-enforce]` nudge) before the StructuredOutput call, which made schema runs nondeterministically throw `Parse: no JSON value found in reply`. The CLI's payload now rides `RunResult.structuredOutput`, schema evaluation prefers it over text extraction (which stays the emulated-tier path), and a payload that fails validation is what the correction retry and `Parse` error quote back.

## 0.2.0

### Minor Changes

- 96fd593: **BREAKING** — `agent.raw` is gone. For the exact argv, call the adapter's own `buildInvocation` — pure, ungated, and available on any adapter that runs one process per turn. There is no replacement for `raw.spawn`.

  **BREAKING** — `agent.run()` is one turn of a thread that opens and closes around it, on both modes: it takes the same options as before, and a setting or `resume` among them shapes the thread rather than the turn.

  **BREAKING** — `AuthStatus.raw` is gone. Every adapter's `authStatus()` now returns only `state`, `method`, and `providers`; the native payload it carried could hold live credentials. Read the normalized fields instead.

  **BREAKING** — an adapter now drives its CLI one way, declared on `adapter.mode`: `"stdout"` carries `buildInvocation` and `parse`, `"acp"` carries an `acp` endpoint. The mixed-mode bridge is gone, so a mode an agent cannot honor throws rather than falling back. The two field sets are mutually exclusive to the compiler, so an adapter that declares both no longer builds.

  **BREAKING** — `Adapter.sessionSeed` and the `SessionSeed` type are gone. A stdout-mode session resumes from the id its CLI reveals in the turn's output; no adapter still needs a handle minted up front.

  **BREAKING** — `Capabilities.session` is now `Capabilities.resume`, answering whether a conversation can be continued from a persisted id. How an agent is driven moved to `adapter.mode`.

  **Changed** — gemini-cli declares `resume: false`: reattaching is broken upstream, so `resume` throws and every session starts fresh.

  **BREAKING** — a session is a thread: `model`, `effort`, `cwd`, `env`, `mcp`, and `extraArgs` moved from per-turn options to `agent.session()`, where they are validated up front and ride every turn. Passing one to `session.run()` throws `InvalidOptions`. Fork a session to continue the conversation under different settings.

  **New** — `Session.close()` ends a thread and releases what it holds, killing the agent's process; queued turns reject and a closed session refuses new ones.

  **Fixed** — `attachments` reach an ACP-mode turn on the adapters that declare them (opencode, kilo-code): the paths ride the prompt as resource links instead of being dropped. goose's `systemPrompt` is now `emulated` for the same reason — its `--system` flag never reached a live turn.

  **New** — ACP-mode sessions honor a thread's settings through the agent's own channels: `model` and `effort` reach the running agent, and `cwd`, `env`, `extraArgs`, and `mcp` reach its endpoint. A setting the endpoint cannot carry throws `UnsupportedCapability` at `agent.session()` rather than being dropped. A `readOnly` turn switches the agent into whatever mode its endpoint offers for the purpose and denies every tool that could change the machine; the next turn without it restores the mode. `fork: true` works over the connection where the agent advertises `session/fork` (opencode, kilo-code) and throws `UnsupportedCapability` where it does not.

  **BREAKING** — cline, cursor, gemini-cli, goose, kilo-code, and opencode are ACP-only: every turn holds a live connection with steering, permission-request events, and a session `model`, and kilo adds `fork: true` over `session/fork`, a `readOnly` plan mode, and a session `effort` its endpoint validates against the levels its current model offers. Cline could not continue a conversation at all before this. Their stdout halves are gone with the bridge, so the CLI flags those built are no longer reachable through run options — pass a native flag through `extraArgs`, which rides the endpoint's argv.

  **Changed** — what those six declare now follows the one mode each kept. opencode and cline no longer take `effort`: the flag that carried it was stdout-only and neither endpoint has a channel for it. goose gains `effort` (`thinking_effort`, `off` through `max`) and `mcp`. gemini-cli, cline, and goose declare `readOnly: "emulated"`, provided by AnyAgent denying every permission request for a tool that could change the machine — on goose the turn also runs in its `approve` mode, because goose's default runs tools without asking at all.

  **New** — opencode, kilo-code, and goose gain `mcp`, joining claude-code: a thread's MCP servers ride `mcpServers` on `session/new`, by `command` or by `url`, each under the name you key it by, added to the machine's own configured servers rather than replacing them. cursor and gemini-cli still throw — neither endpoint has a per-session channel that can name a server without editing the user's config.

  **New** — `runConformance` holds each mode to its own contract: a stdout adapter answers from `fixtures`, an ACP adapter from `transcripts` — recorded exchanges replayed through both `agent.run()` and `agent.session()` — plus the invariants only a live connection can break. The two are exclusive: `ConformanceOptionsFor<A>` makes the other mode's key a compile error, and every ACP adapter, kilo-code included, now answers from a recorded turn of its own.

  **New** — `schemaRetries: 0 | 1` on a run with a `schema`: `1` (the default) keeps the single correction attempt, `0` fails on the first bad reply. A `schema-retry` event marks the boundary between attempts, and `AnyAgentError.issues` lists the schema checks a reply failed on `code: "Parse"`.

  **Fixed** — ACP-mode sessions now behave like stdout-mode runs. A spawn failure, malformed agent output, or an agent dying mid-turn rejects with the same error codes (`Invocation`, `Parse`) and the same `argv`/`stderr` instead of hanging or crashing the host. Turns validate their options before connecting and honor `schema` like every other path. `abort()` and `signal` are scoped to the turn they were given, a failed turn rejects the turns queued behind it, and a turn reaches exactly one terminal state. ACP-mode turns also emit `session` and `usage` events, carry `RunResult.usage`, and report a `tool-result` for every tool call — named from its call, including the ones that failed.

  **Docs** — the Node.js floor reads 20, matching `engines`; stale `runStream` references are gone.
