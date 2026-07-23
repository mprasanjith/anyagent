# Sessions v3: Run, Session, fork, and the ACP native tier

Status: accepted direction 2026-07-22 (v3: single-verb surface; ACP in scope for this build; supersedes v2's `AgentSession`/`runStream` shape, which shipped unreleased and is deleted by M-1). Extends api-v2.md; §5 records what this build also adopts from its want-to-haves (`maxTurns`, attachments) and what stays out (`sessions()` listing).

## 1. Surface

Two nouns, one verb each, consumed identically:

```ts
interface Run extends PromiseLike<RunResult>, AsyncIterable<AgentEvent> {
  abort(): void;
}

interface Session {
  readonly id: string | undefined;
  run(prompt: string, opts?: SessionRunOptions): Run;
}

interface Agent {
  run(prompt: string, opts?: RunOptions): Run;      // one-shot; { resume } continues a persisted id
  session(opts?: SessionOptions): Session;           // a conversation cursor
}

interface SessionOptions {
  resume?: string;
  fork?: boolean; // requires resume, else InvalidOptions; gated by Capabilities.sessionFork
}
```

- `Run` spawns on call. Awaiting resolves the `RunResult` (schema runs parse and retry here, as today). Iterating streams `AgentEvent`s; on a schema retry the iterator sees every attempt's events while `result.events` stays the final attempt's. Breaking an iteration loop stops watching, never the agent; `abort()` stops the agent; an un-awaited, un-iterated `Run` runs to completion like any un-awaited promise. `runStream` is deleted.
- `Session` turns queue: a second `run` before the first settles spawns after it, threaded automatically — no turn-in-flight error. A failed turn rejects its queued successors; the caller retries on the same session explicitly. No session-level `systemPrompt`: pass it per turn.
- `fork: true` makes the session's first turn carry the CLI's copy-on-resume flag; `session.id` then reveals the new conversation's id. Resuming one id into two sessions without `fork` stays legal and is documented as a relay, not a branch.
- Seeding generalizes: on adapters declaring `sessionSeed`, the core applies the seed to every run without `resume` and sets `result.sessionId` to the seed id when parse reveals none — every goose result becomes resumable, and the special case leaves the session layer.

## 2. Tiers, unchanged in principle

`Capabilities.session: "native" | "emulated" | false` as in v2. Emulated: the cursor respawns per turn over the CLI's resume. Native: the session holds one live ACP connection, unlocking `session.steer(text)` — guidance injected into the running turn — and permission round-trips. Code against the emulated tier runs unchanged on native; `session.supports("steer")` is the same check-and-narrow gesture as `agent.supports()`. Tiers may mix per operation: a native-tier agent whose ACP `session/load` is broken (gemini) still resumes cross-process through its CLI flag — live turns native, reattachment emulated.

Permission round-trips mirror the protocol rather than flattening it. An ACP `session/request_permission` carries the agent's own option list (kinded allow-once / allow-always / reject-once / reject-always, each with id and label); the `permission-request` event surfaces those options verbatim, and `session.respond(requestId, optionId)` selects one. `"allow"` and `"deny"` are accepted as sugar, picking the first option of matching kind. `onPermission` on a run's options returns the same union for the non-streaming path. Events stay pure data — options on the event, the answer through the session — so `RunResult.events` remains serializable and an approval exchange is reconstructable from the log.

## 3. One protocol, one client — audited

The native tier is provided solely by an in-core ACP client. ACP v1 (agentclientprotocol.com): JSON-RPC 2.0, newline-framed, over stdio; integer protocol version negotiated in `initialize`; seven methods (`initialize`, `session/new`, `session/load`, `session/prompt`, `session/update` notification, `session/request_permission` reverse request, `session/cancel` notification). The client is built on the official `@agentclientprotocol/sdk` (pinned exact; `zod` peer follows it) — the dependency policy is minimal, not zero, and an official protocol SDK earns its place. The "zero runtime dependencies" claim in the README and docs is updated when the dependency lands (M-2). The client branches on each agent's `initialize`-advertised capabilities, never on binary identity.

**Transport boundary**: ACP replaces the print-mode invocation only where the session tier needs it. A native-tier `Session` holds one live ACP connection for its lifetime (turns via `session/prompt`, no per-turn respawn; the permission handler auto-answers to honor the run's unattended options). One-shot `agent.run()` and emulated-tier sessions keep the verified print modes: every audited capability contract (`readOnly` guarantees, schema flags, MCP strictness, usage accounting) is a print-mode fact, and the ACP surfaces are these CLIs' youngest. Promoting more traffic to ACP later is an adapter-level change with no API impact.

Adapters declare only an endpoint: `Adapter.acp?: { command: string[] }`. Separate-install ACP adapters (the Zed-org `claude-agent-acp` and `codex-acp` npx packages, community Pi/Antigravity bridges) are rejected: AnyAgent drives what the user installed and installs nothing at runtime.

## 4. Verification ledger (2026-07-22)

Levels: **live** = verified against the installed binary on this machine; **docs** = current official documentation; **—** = absent from help and docs. Behavioral transcripts are still required before any capability flips ship (M-2/M-3 below).

| CLI (version) | fork | ACP endpoint | maxTurns | attachments |
| --- | --- | --- | --- | --- |
| claude-code 2.1.217 | `--fork-session` live | — (Zed-org npx adapter only: rejected class) | — | — headless |
| codex 0.144.6 | — | — (`app-server` is not ACP) | — | `-i/--image` live |
| opencode 1.18.3 | `--fork` live | `opencode acp` live | unverified | `-f/--file` live |
| kilo-code (docs) | `--fork` docs | `kilo acp` docs | unverified | mirror of opencode, verify at impl |
| pi 0.80.6 | `--fork <path\|id>` live | — (open proposal) | — | `@file` positionals live |
| goose 1.43.0 | — | `goose acp` live | `--max-turns` live | — |
| cline (docs, 2.x) | — | `--acp` docs (CLI 2.0) | unverified | unverified |
| gemini-cli 0.46.0 | — (no flag) | `--acp` live; `session/load` broken upstream (#15502, closed not-planned) | — | — |
| antigravity 1.1.5 | — headless (`/fork` is TUI-only) | — (FR #31 open) | — | — |
| cursor 2026.07.17 | — (`--fork-session` open FR) | `agent acp` live (absent from top-level help) | — | — |

Net: `sessionFork` on 4/10; ACP endpoints on 6/10 (opencode, kilo, goose, cline, gemini, cursor) with two caveats (gemini reattach broken; goose ACP still stabilizing per its own maintainers); `maxTurns` verified on 1/10 so far; attachments on 3/10 plus kilo. Cline is the headline: its broken headless resume made it `session: false`, but `cline --acp` may flip it straight to the native tier — behavioral verification decides.

## 5. Want-to-haves adopted and declined

- **`maxTurns`** (api-v2 §8.5): dropped from this build. The audit found one verified flag in ten CLIs (goose); a 1/10 extension is not worth its surface now. The ledger row stands for whenever the ratio improves.
- **Attachments** (api-v2 §8.6): in. `ExtensionOptions.attachments: string[]` (file paths), gated by `Capabilities.attachments`; codex/opencode/pi mappings verified, kilo at impl time.
- **`sessions()` listing** (api-v2 §8.7): stays out. The cursor never lists; `resume` plus a persisted id covers continuation; browsing a user's conversations is a different feature.

## 6. Milestones

1. **M-1 — the v3 surface** — shipped 2026-07-22: `Run` handle (a real `Promise` subclass, so jest-style `.rejects` and `.catch`/`.finally` work), queued `Session` with FIFO turn discipline and failed-turn successor rejection, `fork` on the 4 verified CLIs (pi's `--fork <id>` replaces `--session-id`; claude/opencode/kilo add their flag beside resume), generalized seeding, `attachments` on codex (`-i` multi-value), opencode/kilo (`-f` per file), and pi (`@file` positionals), deletion of `runStream`/`AgentSession`, conformance additions for every new gate.
2. **M-2 — ACP client + native tier** — client and wiring shipped 2026-07-22 (`@agentclientprotocol/sdk` 1.3.0 exact, `zod` 4.4.3 exact; the README/docs dependency claim updated in the same change), `Adapter.acp` declared on all six endpoints, `AcpSessionImpl` behind the tier seam in `SessionImpl` (mixed-tier fallback to emulated when `loadSession` is not advertised), full update→event translation, permission emit-then-auto-allow, `steer` live. Known hardening notes from the build: the real spawn bridge keeps stdin open (the print-mode `spawnChild` closes it) and is the one untested-in-CI production path; the ACP client's per-session listener cleanup needs revisiting when steer semantics harden.

**Recording session (2026-07-22)**: transcripts recorded and flips landed for **cursor, goose, gemini-cli → `session: "native"`** (fixtures in `test/fixtures/acp/`, replay tests in CI; all three passed initialize/new/prompt with `stopReason: end_turn`). **opencode recorded and flipped later the same day** after the user authenticated (`test/fixtures/acp/opencode.jsonl`: proto 1, `end_turn`, loadSession advertised); its flip is a per-adapter capability override in `opencode.ts`, so kilo keeps the family's emulated tier until it records its own transcript (cline likewise, and its `session: false` may then jump straight to native). **Latent issue**: gemini advertises `loadSession: true` while its ACP reattach is broken upstream (#15502), so the mixed-tier fallback never fires for it — a gemini `session({ resume })` will attempt a real `session/load`; revisit when upstream fixes or the fallback learns a per-adapter override. Two decisions made at build time: (a) this build's permission policy is emit-then-auto-allow (the `permission-request` event carries the options verbatim, then the first allow-kind option is selected so an unattended run can never hang; manual `respond()` stays gated off until the `onPermission` design lands — `supports("respond")` is `false`); (b) `fork` on a live session throws `InvalidOptions` this build — it remains a print-mode feature until ACP forking semantics are examined. Each of the six flips to `session: "native"` only against a recorded ACP transcript; gemini's mixed-tier rule is implemented as a fallback to the emulated path when `loadSession` is not advertised; cline's flip is contingent on its ACP session behavior.
3. **M-3 — live sweep + guides revamp** — guides revamp shipped 2026-07-22 (ladder pages `single-turn-runs`/`multi-turn-sessions`/`interactive-sessions` at matching URLs — no backwards compatibility kept, per the user; testing extracted to its own guide; streaming folded into the run page; `<SupportedBy>` strips live with derived guards; how-it-works rewritten for the v3 model). Remaining from this milestone: `ANYAGENT_LIVE` runs across the installed nine, strict-mode drift canaries for ACP streams. Then a full revamp of the Guides section, written against the shipped API. Starting outline, to be reshaped by what the working API teaches: a three-level reader ladder — "Single-turn runs" (absorbs the streaming guide; watching is a consumption mode of `Run`, not an API), "Multi-turn sessions" (emulated-universal: cursor, queueing, persist/resume, fork, relay-vs-branch), "Interactive sessions" (native tier: steer, permission options UI, per-CLI caveats as deltas). The titles carry the vocabulary: single-turn/multi-turn names the axis, each title ends on the API noun it teaches, and levels 2 and 3 are the same `Session` noun gaining verbs, never two different things. Cross-cutting guides (structured output, skills, escape hatches, production) sit beside the ladder, not on it.

**Support strips**: every guide opens with a "works with" strip, and every capability-gated feature section carries its own, rendered as harness logos (assets exist in `public/agents/`) with name labels. Strips are a component parameterized by capability key (`<SupportedBy capability="sessionFork" />`), rendered from the adapters' own `Capabilities` declarations like the matrix is — never hand-listed, so they cannot drift and the declarations stay the one home for the fact. Each strip shows the tier where it differs (native/emulated badge) and links to the full matrix; logo-only rows are banned (name labels ride along, for recognition and accessibility). Each strip also carries its guard, derived from the same capability key (`agent.supports("fork")`, `agent.capabilities.modelSelection`, `session.supports("steer")`) as copyable inline code linking to the canonical check-and-narrow section in How AnyAgent works — the strip says which agents, the guard says what your code does about the rest, and both are generated so neither can drift. Hand-written guard snippets appear only where the standard gesture is not the whole story (closed effort vocabularies, permission-option selection). The Adapters matrix remains the complete reference; the strips are the same truth, placed where the reader already is. Reference follows mechanically: `Run`/`Session`/`PermissionOption` in api, Sessions/Fork/Attachments matrix columns, ACP endpoints on adapter pages, `Adapter.acp` in the contract. Vocabulary rule regardless of structure: a *run* is one turn, a *session* is a conversation — "one-shot session" never appears.

## 7. Standing rejections

Bespoke per-CLI bidirectional modes in core (claude-code `--input-format stream-json`, codex app-server); runtime installation of ACP adapter packages; sandbox/bridge lifecycle machinery; serialized lifecycle-state blobs (`session.id` remains the whole persistence story); TUI-only capabilities counted as headless support (antigravity `/fork`).
