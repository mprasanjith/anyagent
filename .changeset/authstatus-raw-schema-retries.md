---
"anyagent-js": minor
---

**BREAKING** — `AuthStatus.raw` is gone. Every adapter's `authStatus()` now returns only `state`, `method`, and `providers`; the native payload it carried could hold live credentials. Read the normalized fields instead.

**New** — `schemaRetries: 0 | 1` on a run with a `schema`: `1` (the default) keeps the single correction attempt, `0` fails on the first bad reply. A `schema-retry` event marks the boundary between attempts, and `AnyAgentError.issues` lists the schema checks a reply failed on `code: "Parse"`. Turns on a live session validate their options before connecting and honor `schema` like every other path.

**Docs** — the Node.js floor reads 20, matching `engines`; stale `runStream` references are gone.
