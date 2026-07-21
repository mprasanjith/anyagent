# API v2: baseline standard plus gated extensions

Status: proposal. Sources: a 7-harness upstream audit (flags live-verified on claude 2.1.216, codex 0.144.6, opencode 1.18.3, pi 0.80.6; kilo/cline via npx; goose from source and docs), a source-level audit of the AI SDK's experimental harness packages and the three community `ai-sdk-provider-*` packages, and two adversarial review passes whose confirmed findings are folded in below. Open items that still need live verification before implementation are collected in §12.

## 1. Product frame

AnyAgent's surface has three layers with different sources of guarantee. The **harness baseline** is what every CLI provides natively: a model-addressed, unattended run in a chosen directory, streamed (`text-delta*` → exactly one `done`, deltas concatenate to `text`), cancellable, with input/output token usage on success. **Core services** are guaranteed on all 7 because the core implements them above the CLI: `schema` → validated `json` with one retry (a uniform, core-owned contract regardless of native/emulated tier), and `systemPrompt` delivery (native system-role append on 3, prompt-folding on 4 — the tier is observable in adherence and must be documented as such, not papered over). **Extensions** are gated by the capability table (`"native" | "emulated" | false`, fail-fast `UnsupportedCapability` before spawn). This iteration adds four user-priority capabilities (auth status, model listing, model contract, reasoning effort), converges the event taxonomy with the AI SDK's stream-part vocabulary so a future provider/harness bridge is mechanical, and flips capabilities that research proved over-conservative (MCP is `false` on 6/7 adapters while verified per-run paths exist on 5).

Positioning, confirmed against the AI SDK harness source: their product provisions harnesses inside mandatory sandboxes; ours drives locally installed, already-authenticated CLIs. Their per-tool layer is a serializable allow/deny shape, never a callback; ours follows (§8). Permission is redesigned in this revision (§8.3): `run()`/`runStream()` have no approval channel, so every run is definitionally unattended and the only caller-decidable question is blast radius — the `PermissionLevel` enum is replaced by a `readOnly` flag.

## 1.5 Surface structure: the tier lives in the types

The three layers of §1 must be visible in the type system, not only in docs. Three mechanisms, all type-level, no runtime change:

1. **Exported split**: `RunOptions = BaselineRunOptions & Partial<ExtensionOptions>`. `BaselineRunOptions` (model, cwd, env, signal, systemPrompt, schema, extraArgs) is the importable baseline contract — portable caller code types against it and the compiler enforces portability. Every `ExtensionOptions` key pairs 1:1 with a capability-table field; rename capability fields to match option names (`reasoningEffort` → `effort`, `sessionFork` → `forkSession`) so types, `GUARDED_OPTIONS`, and the docs matrix all derive from one alignment and cannot drift. `systemPromptMode: "append"` is baseline; the `"replace"` value is what the extension unlocks.
2. **`agent.supports(...keys)` type guard**: `Agent<C>` from `detect()`/`create()` accepts only baseline options until `supports("effort", "mcp")` narrows `C` — the runtime capability check and the compile-time unlock are the same gesture. Extension usage without the check does not typecheck.
3. **Literal capability types on factories**: adapter tables declared `as const satisfies CapabilityTable`; `create(goose())` statically rejects `effort` (goose declares it `false`) with no runtime check needed. `detect()` results stay dynamically typed — on an unknown machine, `supports()` is the honest path.

A nested `extensions: {}` options bag was considered and rejected: grouping without type enforcement adds ceremony, not safety.

## 2. Enablers (ship first)

### 2.1 `SystemProbe`

Auth status and model listing need env, home-dir, and file reads while staying fixture-testable with zero subprocesses:

```ts
export interface SystemProbe extends VersionProbe {
  env: Record<string, string | undefined>;
  homedir: () => string;
  readFile: (path: string) => Promise<string | undefined>; // undefined = missing/unreadable
}
```

Injected out-of-band per house style — `create(found, { probe })` and `detect({ probe })` — never as a per-call method parameter (two calls with two probes on one agent would simulate two machines). `Agent.authStatus()` / `Agent.models()` stay zero-arg.

### 2.2 Known-event expansion in strict parsers

Prerequisite for every new flag: native flags emit event types the strict parsers currently reject with `Parse` (claude `stream_event`/`hook_*`/`prompt_suggestion`, kilo `reasoning`, pi `compaction_*`/`auto_retry_*`/`agent_settled`/`queue_update`, goose banner lines). Expand each adapter's known-event set to tolerate-and-drop these *named* types; genuinely unknown types still throw, so the drift canary survives.

### 2.3 `Invocation.blobs`

Pure adapters need per-run temp files (goose recipes, codex `model_instructions_file`, isolation dirs). `buildInvocation` may return `blobs?: Record<string, string>` plus `${blob:key}` / `${tmpdir:key}` placeholders in args/env; the core materializes them before spawn and cleans up after exit.

**This is breaking for `RawHandle`** (the review caught it marked additive): `Invocation` is documented as a fully-resolved command line. Resolution: `raw.buildInvocation` returns the invocation with `blobs` attached and placeholders intact — documented, so a caller running it elsewhere materializes them — and `raw.spawn` materializes and removes them on child exit. `runConformance` validates placeholder/blob-key correspondence.

## 3. Auth status (user priority 1)

"Are this CLI's credentials configured?" — never "verified live", never spawning a paid run.

```ts
export type AuthState = "authenticated" | "unauthenticated" | "unknown";
export interface AuthStatus { state: AuthState; method?: string; providers?: string[]; raw?: unknown }
export type DiscoverySupport = "native" | "probed" | false;

// Adapter:        authStatus?: (probe: SystemProbe) => Promise<AuthStatus>;
// CapabilityTable: authStatus: DiscoverySupport;
// Agent:           authStatus: () => Promise<AuthStatus>;
```

`DiscoverySupport` is new and deliberate: the review confirmed that calling credential-file probing `"emulated"` would contradict the documented meaning (core-provided, identical everywhere). `"native"` = the CLI answers itself; `"probed"` = best-effort file/env heuristics, documented as drift-prone and covered by the live drift check; `"unknown"` is a first-class honest answer.

| Adapter | Tier | Mechanism |
|---|---|---|
| claude-code | native | `claude auth status --json` (pass `--json` explicitly), exit 0/1, `{loggedIn, authMethod, subscriptionType, ...}` |
| codex | native | `codex login status`, exit 0/1, text |
| goose | probed | exec `goose info -v` (verified 1.43: exit 0, prints `GOOSE_PROVIDER`/`GOOSE_MODEL`, no LLM call) + provider key env vars; `unknown` when the key lives in the keyring. Unconfigured-run signature: exit 1, "error: Error Unknown provider" |
| opencode | probed | read `~/.local/share/opencode/auth.json` (the `auth list` exit code is untrustworthy: 0 with zero credentials) |
| kilo-code | probed | read `~/.local/share/kilo/auth.json` (`kilo profile --json` exists but reflects only Kilo Gateway auth, exit 1 even with a valid provider key — verified; not usable as a BYO-provider probe) |
| pi | probed | read `~/.pi/agent/auth.json` + provider env vars |
| cline | probed | read providers.json: `CLINE_PROVIDER_SETTINGS_PATH` ?? `$CLINE_DATA_DIR/settings/providers.json` ?? `$CLINE_DIR/data/settings/providers.json` ?? `~/.cline/data/settings/providers.json` (all three env vars live-verified on 3.0.46). Never exec: `cline config --json` exits 1 without a TTY. Unauthenticated-run signature: exit 1, `run_result.finishReason: "error"`, message starting `Unauthorized:` |

Fallback documented for callers: an unauthenticated run exits 1 with a recognizable message on every harness tested.

## 4. Model listing (user priority 2)

```ts
export interface ModelInfo { id: string; provider?: string; reasoningEfforts?: string[]; raw?: unknown }
// Adapter:        listModels?: (probe: SystemProbe) => Promise<ModelInfo[]>;
// CapabilityTable: modelListing: DiscoverySupport;
// Agent:           models: () => Promise<ModelInfo[]>;
```

Native on 4: codex (`codex debug models`, JSON, includes per-model `supported_reasoning_levels` → `reasoningEfforts`), opencode (`opencode models`), kilo (`kilo models`, works unauthenticated), pi (`pi --list-models`, credential-filtered — documented as "this machine's usable models"). **`false` on claude-code, goose, cline** — no listing mechanism exists; static alias lists are rejected (drift, plan-gating lies).

Contract: any `ModelInfo.id` is valid verbatim as `RunOptions.model` on the same agent. Per the review, this round-trip is a **live drift-check property, not a fixture property** — conformance asserts only that ids parse out of recorded output; the live suite lists models and runs the cheapest one.

**models.dev** (the public catalog opencode itself vendors; `https://models.dev/api.json`, per-model `reasoning_options`, `attachment`, `structured_output`, context `limit`, `cost`; per-provider `env` var lists) gets two sanctioned roles and two named rejections. Sanctioned: an opt-in `anyagent/catalog` subpath that enriches `models()` results with catalog metadata (exact id join for the opencode family and pi), built on the official `@opencode-ai/models` client (exact-pinned; zero-dep, ships an offline snapshot — so enrichment works with no network by default, and a live refresh is the caller's opt-in); and a small env-var table generated into core source at build time from the snapshot's per-provider `env` arrays, backing the pi/opencode/goose auth probes instead of a hand-maintained list (core itself stays zero-dependency — the package is a devDependency of the generator, never a runtime dep of `anyagent`). The `/logos/{provider}.svg` endpoints are a docs-site nicety for the adapter pages, not SDK surface. Rejected: substituting the catalog for native `models()` on claude-code/goose/cline (the catalog says what exists, not what this CLI+account accepts — it would break the round-trip contract), and computing `costUsd` from its price data (§11 already rejects client-side price-table accounting).

## 5. Model contract (user priority 3)

`RunOptions.model` stays a pass-through string in the CLI's own vocabulary; the CLI is the authority and a bad name fails fast as an `Invocation` error. One adapter change: **goose splits `"provider/model"` into `--provider`/`--model`**, aligning its vocabulary with opencode/kilo/pi (breaking for goose callers passing bare slash-containing strings).

## 6. Reasoning effort (user priority 4)

```ts
export type ReasoningEffort =
  | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
  | (string & Record<never, never>); // autocomplete, open by design

// RunOptions:      effort?: ReasoningEffort;
// CapabilityTable: reasoningEffort: CapabilitySupport;
//                  reasoningEfforts?: string[];   // present only when the CLI's vocabulary is closed
```

The review killed the original closed-enum design twice over: codex accepts `max` and `ultra` (per-model, from `debug models`), and opencode/kilo `--variant` is a free-form provider-specific string — a closed subset would reject values the CLI happily forwards. Resolution: `effort` is validated for *capability presence* everywhere; value-level fail-fast happens only where the adapter declares `reasoningEfforts` because the CLI's own vocabulary is closed and version-stable (claude `low..max`, pi `off..max` with `none→off` spelling, cline `none..xhigh`). Codex and opencode/kilo pass through; per-model valid values are discoverable via `models()`.

| Adapter | Mechanism |
|---|---|
| claude-code | `--effort <v>`, closed `[low, medium, high, xhigh, max]` |
| codex | `-c model_reasoning_effort=<v>`, pass-through (per-model) |
| opencode / kilo-code | `--variant <v>`, pass-through (provider-defined names; CLI surfaces its own error) |
| pi | `--thinking <v>`, closed `[none→off, minimal, low, medium, high, xhigh, max]` |
| cline | `--thinking <v>`, closed `[none, low, medium, high, xhigh]` |
| goose | `false` — env-only per-provider knobs, unstable; extraArgs territory |

Nearest-level remapping is rejected: silently changing cost/latency semantics.

## 7. Events and usage: AI SDK-converged shapes

### 7.1 `AgentEvent` additions (breaking — every union addition breaks exhaustive switches; the ledger treats them uniformly)

```ts
export type ToolName = "read" | "write" | "edit" | "bash" | "grep" | "glob" | "webSearch"
  | (string & Record<never, never>);

| { type: "session"; sessionId: string; raw?: unknown }
| { type: "reasoning-delta"; text: string; raw?: unknown }
| { type: "tool-call";   name: ToolName; nativeName: string; callId?: string; input: unknown;  raw?: unknown }
| { type: "tool-result"; name: ToolName; nativeName: string; callId?: string; output: unknown; raw?: unknown }
| { type: "file-change"; kind: "create" | "modify" | "delete"; path: string; raw?: unknown }
```

Tool names normalize to the cross-harness vocabulary (claude `Bash` and codex `shell` both surface as `bash`) with the native name always preserved. `RunResult` gains `sessionId?: string` (undefined honestly on goose — never emitted headless — and cline) and `finishReason?: { unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other"; raw?: string }` (ships with `maxTurns`, which is what makes `"length"` reachable). `Usage` gains `cacheReadTokens?`, `cacheWriteTokens?`, `reasoningTokens?` — and per the fact-check, **opencode/kilo must map `tokens.cache.{read,write}` and `tokens.reasoning`**, which our own fixtures show as nonzero (the draft wrongly claimed they don't report them). Before documenting `inputTokens` as strictly uncached, audit each adapter's native accounting against fixtures; apply codex-style subtraction where a CLI folds cache in.

### 7.2 Mapping to AI SDK stream parts (paper exercise; the bridge ships later)

| AgentEvent | AI SDK stream part |
|---|---|
| `text-delta` | `text-delta` (bridge synthesizes start/end) |
| `reasoning-delta` | `reasoning-delta` (ditto) |
| `tool-call` / `tool-result` | `tool-call {toolName, providerExecuted: true}` / `tool-result`, paired by `callId` |
| `file-change` | `file-change` (their vocabulary verbatim) |
| `session` | provider metadata |
| `usage` | `finish-step` (`inputTokens → inputTokens.noCache`, cache fields map 1:1, `reasoningTokens → outputTokens.reasoning`) |
| `done` | `finish` |
| thrown `AnyAgentError` | `error` |

Not adopted: `text-start/end` triples (synthesizable), a `raw` stream part (`raw` rides on every event), `tool-approval-request` (no one-shot path exists).

## 8. Capability expansions

### 8.1 MCP: 1/7 → 5/7, no API change

Flip to native: codex (`-c mcp_servers.<id>.command/.args/.env`, `.url/.bearer_token_env_var` — live-verified to register), opencode (`OPENCODE_CONFIG_CONTENT` `mcp` key), kilo (`KILO_CONFIG_CONTENT`), goose (`--with-extension` / `--with-streamable-http-extension`). Stays `false`: pi (flag exists only with an adapter package installed — undetectable precondition would fail mid-spawn, not fail-fast) and cline (verified path needs a pre-run subprocess, violating pure adapters). claude-code additionally gains `--strict-mcp-config` so `RunOptions.mcp` means *only those servers* (today user-config servers leak in — a correctness fix, breaking for anyone relying on the leak).

**Single-writer rule** (review finding): `OPENCODE_CONFIG_CONTENT`/`KILO_CONFIG_CONTENT`/`KILO_PERMISSION` become adapter-owned env vars carrying mcp, maxTurns-steps, tool policy, and replace-prompt config. The adapter merges caller JSON supplied via `opts.env` under its own (adapter wins on conflicting keys), and the docs must state that `extraArgs` cannot override env-delivered settings on these adapters.

### 8.2 Native structured output where real

Flip claude-code `structuredOutput` to `"native"` via `--json-schema` — live-verified to work with `--output-format stream-json`, result carried in `structured_output`. The caller contract is unchanged (core still validates and retries); the adapter maps `structured_output` into `RunResult.text`/parse input so the pipeline holds, and the caps-value change is listed as observable in the ledger. Codex stays emulated deliberately: `--output-schema` speaks a restricted dialect (all-fields-required, `format`/`pattern` ignored) — acceptance would become schema-dependent. Goose flips to native (verified 1.43): a synthesized recipe blob with `response.json_schema` works headless — goose injects a `final_output` tool and the final text content is the pure JSON, so the core pipeline reads it unchanged. Constraint: `--recipe` conflicts with `-t`, so the prompt is embedded in the recipe file (via `Invocation.blobs`).

### 8.3 Permission redesign: `readOnly` replaces `PermissionLevel`

The 3-level enum does not survive contact with the data. anyagent's API has no approval channel — nothing in `run()`/`runStream()` can answer a CLI's permission prompt — so a "guarded" middle level is incoherent by construction: headless, an approval request only ever resolves to a denial (claude-code) or a hang (opencode family, observed live in the harness audit). Caller usage is correspondingly bimodal: read-only analysis, or unattended full access. The two native "middles" aren't even one contract (claude `acceptEdits` denies shell; codex `workspace-write` runs shell confined to the workspace) — they are harness-specific nuances, not a neutral level.

```ts
// RunOptions:      readOnly?: boolean;          // default false = unattended full access
// CapabilityTable: readOnly: CapabilitySupport;  // replaces permissionLevels
```

- **Omitted / `false`** — the baseline, deliverable on all 7: unattended, never blocks, the maximum autonomy the CLI offers (claude `--permission-mode bypassPermissions`, codex `--sandbox danger-full-access`, opencode/kilo `--auto`, goose `GOOSE_MODE=auto`, cline `--auto-approve true`, pi as-is). Loud doc callout required: this default is more permissive than v1's `edit`.
- **`readOnly: true`** — contract: nothing on the machine changes. Coverage **5/7, all live-verified 2026-07-22**: claude-code (`--permission-mode manual`, verified behaviorally identical to the legacy `default` headless — edit denied, agent reports it, `is_error: false` — plus `--disallowedTools` belt-and-braces, since a client-side deny-list alone fails open on upstream tool additions; the live drift check asserts the mode stays accepted), codex (`--sandbox read-only`), pi (`--tools read`), opencode and kilo-code (`OPENCODE_PERMISSION`/`KILO_PERMISSION` deny matrix — verified on 1.18.3/7.4.11: a denied tool call returns an error part to the model and the loop continues to a final answer, exit 0, no hang; this supersedes the old harness-audit hang note, which applied to `ask`-shaped prompts — `ask` is auto-rejected headless and ends the run early with no final assistant turn, so adapters must use `deny`, never `ask`). Matrix keys are categories (`"*"`, `edit`, `bash`, `webfetch`), not tool names — per-tool-name keys are **silently ignored** (verified on kilo). goose and cline are honestly `false` — requesting it throws `UnsupportedCapability`. Under `readOnly: true` + `RunOptions.mcp`, MCP tools join the deny set. Docs note: under a deny matrix the model may burn many turns probing read-only alternatives — recommend pairing `readOnly` with `maxTurns` on the opencode family.
- The former middles stay reachable via `extraArgs` or typed factory options (§9).
- Migration: `permission: "read"` → `readOnly: true`; `"auto"` → omit; `"edit"` and the old implicit default → omit — a **behavior change**, not just a rename: claude-code moves from `acceptEdits` to `bypassPermissions` unless the caller pins the old mode via `extraArgs`. `resolvePermission` is deleted; `validateOptions` gates `readOnly` against the capability table.

### 8.4 Tool policy (allow/deny)

```ts
export interface ToolPolicy { allow?: string[]; deny?: string[] } // native tool names
// RunOptions:      tools?: ToolPolicy;
// CapabilityTable: toolPolicy: CapabilitySupport;
```

Names are native (a policy is an instruction to the CLI; translating names could silently fail open or closed). Deny wins. **A policy may only narrow what the run already allows — under `readOnly: true` it may never grant a mutating tool** — and per the review's blocker, that rules out claude-code's `--allowedTools`, whose native semantics are *auto-approval*, not availability. On claude-code, `allow` compiles to `--tools` (availability restriction of the built-in set) and `deny` to `--disallowedTools`; approval-granting rule syntax stays in `extraArgs`. pi maps to `--tools`/`--exclude-tools` (true availability filters). opencode/kilo: the permission matrices only accept category keys (per-tool-name keys silently ignored, live-verified on kilo — a name-keyed policy would fail open), so per-tool-name policy rides the config `tools` availability map instead — live-verified on opencode (`tools: {"write": false, …}` hides the tool from the model entirely; run completes with the honest refusal). Kilo uses the same mechanism via `KILO_CONFIG_CONTENT`; one confirmation run there before flipping (§12). codex, goose, cline: `false`. Conformance adds: a `ToolPolicy` combined with `readOnly: true` never emits an approval-granting or write-enabling flag. Web-search toggles fold into this policy rather than a dedicated option.

### 8.5 `maxTurns`

`RunOptions.maxTurns` + `CapabilityTable.maxTurns`. Native: claude-code (`--max-turns`, hidden but probe-verified), goose (`--max-turns`), opencode/kilo (agent `steps` via config env). `false`: codex, pi, cline. No emulation — killing a process mid-turn is a different feature. Ships together with `finishReason` (§7.1).

### 8.6 Attachments

`RunOptions.attachments?: string[]` (local file paths — every CLI consumes files; base64 buffering through the SDK is pure overhead). Native: codex `-i/--image`, opencode/kilo `-f/--file`, pi `@path` positionals (interaction with the new stdin prompt needs a fixture first, §12). cline's ` @./path` prompt mentions are **prompt mutation — declared `"emulated"`**, not native (review finding; it inherits prompt-folding failure modes). `false`: claude-code (no headless flag, probe-verified rejected), goose.

### 8.7 Sessions: fork, list

- `RunOptions.forkSession?: boolean` (requires `resume`, else throws — see §10 error code) — native on claude-code `--fork-session`, opencode/kilo `--fork`, pi `--fork`; `false` on codex/goose/cline.
- `Agent.sessions()` / `Adapter.listSessions?(probe)` / `CapabilityTable.sessionList: DiscoverySupport` — native on opencode/kilo (`session list --format json`), goose (`session list --format json`), cline (`history --json`); `false` on claude-code/codex/pi (reverse-engineering private transcript layouts is upstream's contract to offer, not ours — the same standard §3 applies via `DiscoverySupport`). Deferred to M3; `RunResult.sessionId` already unblocks resume workflows.

### 8.8 System-prompt mode

```ts
// RunOptions:      systemPrompt?: string;
//                  systemPromptMode?: "append" | "replace";  // default "append"
// CapabilityTable: systemPrompt: CapabilitySupport;          // append tier (core service)
//                  systemPromptReplace: CapabilitySupport;   // "native" | false — never emulated
```

One content field, one delivery mode — no second content field, so "both set" cannot be expressed. `"append"` is the guaranteed core service (§1). `"replace"` gates on `systemPromptReplace`: no emulated tier exists because you cannot subtract a builtin prompt by adding text. `systemPromptMode` without `systemPrompt` throws `InvalidOptions`; `applyEmulations` folds only in append mode. Replace is native on 6 — claude `--system-prompt`, codex `-c model_instructions_file=` blob, opencode/kilo agent `prompt` config key, pi `--system-prompt`, cline `-s` (its true replace semantics finally used honestly) — and `false` on goose, whose `--system` only appends.

### 8.9 Hermetic runs — deferred pending per-adapter semantics

The draft claimed a `hermetic: boolean` native on all 7. The fact-check broke it: claude `--bare` **forces API-key-only auth** (silently logs out subscription users), opencode `--pure` isolates plugins only, kilo/cline fresh-dir isolation also strips the credential store (a hermetic run would be an unauthenticated run), and pi's flags isolate project context, not user config. One boolean, seven different guarantees — the flagship cross-harness semantic lie. Deferred until a per-adapter table specifies exactly what is isolated, what happens to credentials, and how `hermetic × resume` errors when the session store lives inside the isolated dir.

## 9. Factory options

Adapter factories gain optional typed settings for harness-idiosyncratic knobs. The rule: concepts shared by ≥2 harnesses go to `RunOptions` + `CapabilityTable` (effort is the proof case — a run option here, unlike the AI SDK's `createCodex({reasoningEffort})`); factory options shape the adapter, never one run, and never duplicate `RunOptions` fields. Initial: `claudeCode({ settingsFile?, addDirs? })`, `codex({ profile?, configOverrides? })`, `goose({ provider? })`. Zero-arg calls keep working.

## 10. Cross-cutting corrections

- **Adapter truth fixes (M1)**: pi prompt switches to piped stdin (works since 0.80.6; the adapter comment is outdated and the argv cap is real); claude-code `--strict-mcp-config` (§8.1); claude-code permission-mode succession (§8.3); goose model split (§5); the `RunOptions.systemPrompt` doc comment stops claiming "appended to the CLI's own system prompt" universally — on emulated adapters it is a prompt preamble, and the doc must say so.
- **New error code**: dependent-option mistakes (`forkSession` without `resume`, `systemPromptMode` without `systemPrompt`) throw a new `InvalidOptions` code — reusing `Invocation` would make the documented error vocabulary lie (it means "the CLI itself went wrong").
- **Conformance additions (M1, explicit)**: every new gated option joins `GUARDED_OPTIONS` and the probe list; `validateOptions` learns the `reasoningEfforts` subset check and the `readOnly` gate; `runConformance` asserts `models()`/`authStatus()`/`sessions()` throw on a `false` capability, blob-placeholder correspondence, and the §8.4 never-widen check.

## 11. Rejections

Cost budget (1/7 native; a client-side kill is not a cap — the money is already spent). Hooks, in-process custom tools, per-tool permission callbacks (no portable one-shot path; MCP and `raw` are the routes). Bidirectional multi-turn in core (seven protocols; if ever, one ACP client — ACP is on 4/7 — as a separate package). `continueLast` (ambient-state-dependent, flaky in CI; `sessionId` covers it). Background dispatch, scheduling, session export, sandbox config, subagent definitions (incomparable semantics). Static model catalogs, nearest-effort remapping, base64 attachment parts, `LanguageModelV2` as the core surface (the AI SDK itself keeps harnesses separate from providers).

## 12. Live-verification ledger

Verified 2026-07-22 (claude 2.1.216, opencode 1.18.3, pi 0.80.6 local; kilo 7.4.11, cline 3.0.46 via npx; temp OpenRouter key):

1. ✅ **opencode/kilo deny does not hang.** A `deny`-rule tool call returns an error part to the model ("The user has specified a rule which prevents…"); the loop continues to a final answer, exit 0, nothing written. `ask` is auto-rejected headless (stderr "auto-rejecting") but ends the run right after the rejected step with **no final assistant turn** — adapters must emit `deny`, never `ask`. New caveat: matrix keys are categories only (`"*"`, `edit`, `bash`, `webfetch`); per-tool-name keys are silently ignored (`{"*":"allow","write":"deny"}` did not block `write`).
2. ✅ **claude `manual` ≡ legacy `default` headless**: identical behavior on an edit-forcing prompt (no file, `CANNOT`, `is_error: false`). Adapter switches `readOnly` to `--permission-mode manual`.
3. ✅ **`kilo profile --json` exists but is Kilo-Gateway-only** — exit 1 with a valid BYO provider key; not an auth probe.
4. ✅ **cline data layout + env vars**: `<data>/settings/providers.json`; `CLINE_DATA_DIR` (drops the `data/` level), `CLINE_DIR` (keeps it), and `CLINE_PROVIDER_SETTINGS_PATH` (exact file) all work. Unauthenticated signature: exit 1, `run_result.finishReason: "error"`, `Unauthorized: …`.
5. ✅ **cline `@`-mentions inject file content** (answer recovered from the file with zero tool calls) — the `attachments: "emulated"` tier is justified, not `false`.
6. ✅ **pi `@path` + stdin prompt compose** (image attached positionally, prompt piped; correct answer).

Verified 2026-07-22, second pass (goose 1.43 installed locally):

7. ✅ **`goose info -v` exists** — exit 0, prints provider/model/extensions, no LLM call; the auth probe. Unconfigured runs exit 1 with a clean "error: Error Unknown provider" message (no panic on 1.43).
8. ✅ **goose recipe `response.json_schema` works headless** — injected `final_output` tool, final text = pure JSON; `--recipe` conflicts with `-t`, so the prompt embeds in the recipe blob. Structured output flips to native on goose (§8.2). `-q` keeps stream-json clean; the stream emits `thinking` blocks (goose is a `reasoning-delta` source) and still never carries a session id; `goose session list --format json` works.
9. ✅ **opencode config `tools` map is a real name-keyed availability filter** — `tools: {"write": false, …}` via `OPENCODE_CONFIG_CONTENT` hides the tools from the model; `toolPolicy` unblocked on opencode (§8.4).

Still open:

1. **Per-adapter native input-token accounting** (folds cache reads or not) before tightening the `Usage.inputTokens` doc (§7.1).
2. **kilo mirrors**: one confirmation run each for the `tools` map via `KILO_CONFIG_CONTENT`, and the npx event-duplication quirk (`--format json` emitted each event line twice; dedupe by `part.id`) against an installed binary.

## 13. Milestones

**M1 — user priorities + truth fixes**: `SystemProbe`; known-event expansion; the `readOnly` permission redesign (§8.3); `authStatus` (7/7); `models()` (4 native, 3 honest `false`); `effort` (6/7); `Usage` cache/reasoning tokens (incl. opencode/kilo mappings); `session` event + `RunResult.sessionId`; claude-code structured-output → native (fixtures first); adapter truth fixes; `InvalidOptions`; conformance extensions.

**M2 — coverage expansion**: `Invocation.blobs` + `RawHandle` contract; MCP flips (4); `systemPromptMode: "replace"` (6/7 native, needs blobs for codex); tool policy; `maxTurns` + `finishReason`; attachments; event taxonomy completion (tool-name normalization, `reasoning-delta`, codex `file-change`); factory options; `readOnly` on opencode/kilo (verified, ships); goose structured-output → native (verified, ships); `toolPolicy` on opencode (verified) and kilo (after its §12 mirror run).

**M3 — session conveniences + deferred**: `forkSession`; `sessions()`; `hermetic` (only with the §8.9 semantics table).

**Future, deliberately undesigned**: an AI SDK provider bridge over the M1/M2 event shapes; a harness-contract bridge (needs mid-turn suspend/continue; upstream is experimental); `@anyagent/acp`.
