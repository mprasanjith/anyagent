---
"anyagent-js": minor
---

**BREAKING** — `AuthStatus.raw` is gone. Every adapter's `authStatus()` now returns only `state`, `method`, and `providers`; the native payload it carried could hold live credentials. Read the normalized fields instead.

**BREAKING** — `Capabilities.session` now answers `"acp" | "stdout" | false` — the mode sessions run in — replacing `"native" | "emulated"`.

**BREAKING** — a session is a thread: `model`, `effort`, `cwd`, `env`, `mcp`, and `extraArgs` moved from per-turn options to `agent.session()`, where they are validated up front and ride every turn. Passing one to `session.run()` throws `InvalidOptions`. Fork a session to continue the conversation under different settings. `agent.run()` is unchanged.

**New** — `Session.close()` ends a thread and releases what it holds, killing the agent's process; queued turns reject and a closed session refuses new ones.

**New** — ACP-mode sessions honor a thread's settings through the agent's own channels: `model` and `effort` reach the running agent, and `cwd`, `env`, `extraArgs`, and `mcp` reach its endpoint. A setting the endpoint cannot carry throws `UnsupportedCapability` at `agent.session()` rather than being dropped. A `readOnly` turn switches the agent into its read-only mode and denies every tool that could change the machine; the next turn without it restores the mode. `fork: true` now works on ACP-mode agents — over the connection where the agent advertises `session/fork` (opencode), through the stdout-mode bridge everywhere else.

**New** — cline and kilo-code move to ACP-mode sessions: `agent.session()` holds a `cline --acp` or `kilo acp` connection with steering and a session `model`, and kilo adds `fork: true` over `session/fork`, a `readOnly` plan mode, and a session `effort` its endpoint validates against the levels its current model offers. Cline could not continue a conversation at all before this.

**New** — opencode and kilo-code gain `mcp`, joining claude-code: a run's or a thread's MCP servers ride the adapter-owned config env var (`OPENCODE_CONFIG_CONTENT` / `KILO_CONFIG_CONTENT`), each under the name you key it by, added to the machine's own configured servers rather than replacing them. cursor, gemini-cli, and goose still throw — none has a per-run channel that can name a server without editing the user's config.

**New** — `runConformance` takes `transcripts`, recorded ACP transcripts it replays through an ACP-mode session, so an adapter's ACP mode answers for the same stream invariants as its stdout mode.

**New** — `schemaRetries: 0 | 1` on a run with a `schema`: `1` (the default) keeps the single correction attempt, `0` fails on the first bad reply. A `schema-retry` event marks the boundary between attempts, and `AnyAgentError.issues` lists the schema checks a reply failed on `code: "Parse"`.

**Fixed** — ACP-mode sessions now behave like stdout-mode runs. A spawn failure, malformed agent output, or an agent dying mid-turn rejects with the same error codes (`Invocation`, `Parse`) and the same `argv`/`stderr` instead of hanging or crashing the host. Turns validate their options before connecting and honor `schema` like every other path. `abort()` and `signal` are scoped to the turn they were given, a failed turn rejects the turns queued behind it, and a turn reaches exactly one terminal state. ACP-mode turns also emit `session` and `usage` events, carry `RunResult.usage`, and report a `tool-result` for every tool call — named from its call, including the ones that failed.

**Docs** — the Node.js floor reads 20, matching `engines`; stale `runStream` references are gone.
