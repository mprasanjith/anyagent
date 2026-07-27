---
"anyagent-js": minor
---

**BREAKING** — `AuthStatus.raw` is gone. Every adapter's `authStatus()` now returns only `state`, `method`, and `providers`; the native payload it carried could hold live credentials. Read the normalized fields instead.

**BREAKING** — a session is a thread: `model`, `effort`, `cwd`, `env`, `mcp`, and `extraArgs` moved from per-turn options to `agent.session()`, where they are validated up front and ride every turn. Passing one to `session.run()` throws `InvalidOptions`. Fork a session to continue the conversation under different settings. `agent.run()` is unchanged.

**New** — `Session.close()` ends a thread and releases what it holds, killing the live agent's process; queued turns reject and a closed session refuses new ones.

**New** — live sessions honor a thread's settings through the agent's own channels: `model` and `effort` reach the running agent, `cwd`, `env`, `extraArgs`, and `mcp` reach its endpoint, and a setting the live tier cannot carry throws `UnsupportedCapability` at `agent.session()` rather than being dropped. A `readOnly` turn switches the agent into its read-only mode and denies every tool that could change the machine; the next turn without it restores the mode. `fork: true` now works on live agents.

**New** — `schemaRetries: 0 | 1` on a run with a `schema`: `1` (the default) keeps the single correction attempt, `0` fails on the first bad reply. A `schema-retry` event marks the boundary between attempts, and `AnyAgentError.issues` lists the schema checks a reply failed on `code: "Parse"`. Turns on a live session validate their options before connecting and honor `schema` like every other path.

**Fixed** — live sessions now fail like print runs: a spawn failure, malformed agent output, or an agent dying mid-turn rejects with the same error codes (`Invocation`, `Parse`) and the same `argv`/`stderr` instead of hanging or crashing the host. `abort()` and `signal` are scoped to the turn they were given, a failed turn rejects the turns queued behind it, and a turn reaches exactly one terminal state. Live turns also emit `session` and `usage` events, carry `RunResult.usage`, and report a `tool-result` for every tool call — named from its call, including the ones that failed.

**Docs** — the Node.js floor reads 20, matching `engines`; stale `runStream` references are gone.
