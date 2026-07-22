# Harness audit

Per-CLI facts behind the landing-page statuses and the adapter capability
tables. "Shipped" means the adapter exists in `packages/anyagent/src/<id>/`
with recorded fixtures and passing live tests; "soon" means the headless
surface is audited here and the adapter is on the way. Every claim below was
verified hands-on (CLI installed, flags confirmed from `--help`, and — for
shipped adapters — real runs recorded) in July 2026; versions and pricing move
fast, so re-verify before building on a "soon" row. Shipped rows were
re-verified live on 2026-07-22 for the API-v2 work — see
[api-v2.md](api-v2.md) §12 for that verification ledger.

## Shipped

### Claude Code (`claude`)

- Headless: `claude -p --output-format stream-json --verbose`, prompt over
  stdin. Resume `--resume <sessionId>`; `--append-system-prompt`;
  `--mcp-config` (pass `--strict-mcp-config` or user-config servers load
  too); `--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`.
- Permission modes (re-verified 2.1.216): `default` vanished from the help
  choices but is still accepted; `manual` is its successor and behaves
  identically headless (edit denied, agent reports it, `is_error: false`) —
  adapters should emit `manual`. The new `auto` choice is a classifier mode,
  NOT `bypassPermissions`.
- Auth status: `claude auth status --json` — exit 0/1,
  `{loggedIn, authMethod, subscriptionType, …}` (pass `--json` explicitly;
  it is the default today).
- Native structured output: `--json-schema '<json>'` works together with
  `--output-format stream-json`; the result event carries
  `structured_output` (schema pre-validated upstream since 2.1.205).
- Reasoning effort: `--effort low|medium|high|xhigh|max`.
- Auth: subscription or `ANTHROPIC_API_KEY` (pay-per-token).

### Codex (`codex`)

- Headless: `codex exec --json`, prompt over stdin via the `-` positional.
  Resume `codex exec resume <threadId>`; `--sandbox
read-only|workspace-write|danger-full-access`; `--model`.
- Auth: ChatGPT plan or `OPENAI_API_KEY` (pay-per-token).

### opencode (`opencode`) — v1.17 audited

- Headless: `opencode run --format json`, prompt over stdin (verified) or
  positional. NDJSON events `step_start`/`text`/`tool_use`/`step_finish`;
  tool parts arrive in a terminal state with input and output together; each
  `step_finish` carries per-step tokens and cost. Typed `error` events plus
  exit 1 on failure.
- Resume: `--session <id>`; the id appears as `sessionID` on every event.
- Model: `--model provider/model` (e.g. `openrouter/openai/gpt-4o-mini`).
- Permissions: config-file (`opencode.json` / `OPENCODE_PERMISSION` env), not
  flags. Re-verified on 1.18.3, superseding the earlier hang note: a `deny`
  rule does NOT hang — the tool call returns an error part to the model
  ("The user has specified a rule which prevents…") and the loop continues
  to a final answer, exit 0. `ask` is auto-rejected headless (stderr
  "auto-rejecting") but the run then ends with NO final assistant turn — use
  `deny`, never `ask`. Matrix keys are categories (`"*"`, `edit`, `bash`,
  `webfetch`); per-tool-name keys are silently ignored. Per-tool-name
  availability works via the config `tools` map instead
  (`OPENCODE_CONFIG_CONTENT='{"tools":{"write":false,…}}'` verified: the
  tool is hidden from the model entirely). A `read` level built on the deny
  matrix is therefore viable — see api-v2.md §8.3. `--auto` approves
  everything not explicitly denied; the bare default already edits.
- Model listing: `opencode models [provider]` — one `provider/model` per
  line. Reasoning effort: `--variant <name>` (free-form, provider-defined).
- Auth: BYOK — auto-detects `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`, …; MIT, repo `anomalyco/opencode` (moved from `sst`).
- Quirks: without a git root, relative paths in the model's tool calls can
  land outside the cwd (model-dependent, not adapter-fixable).

### Kilo Code (`kilo`, `kilocode`) — @kilocode/cli v7.4 audited

- opencode fork; identical `run --format json` surface and event stream,
  verified independently against real `kilo` output (fixtures recorded from
  the kilo binary, not copied from opencode).
- Permissions (re-verified 7.4.11): same as opencode — `KILO_PERMISSION`
  deny returns an error to the model, no hang; `ask` auto-rejects and ends
  the run early; category keys only (`{"*":"allow","write":"deny"}` did NOT
  block `write` — silently ignored).
- `kilo profile --json` exists but reflects only Kilo Gateway auth (exit 1
  even with a valid BYO provider key) — not a general auth probe; read
  `~/.local/share/kilo/auth.json` instead. `kilo models` works
  unauthenticated. `kilo session list --format json` works.
- QUIRK (npx 7.4.11): `--format json` emitted every event line twice —
  dedupe by `part.id`; confirm against an installed binary before relying
  on it.
- Auth: BYOK via the same env vars, or a Kilo account (free tier: starter
  credits + free models). MIT.

### Pi (`pi`) — @earendil-works/pi-coding-agent v0.80 audited

- Headless: `pi --mode json -p <prompt>`. Piped stdin WORKS as of v0.80.6
  (verified — the earlier "positional only, no stdin form" note is
  obsolete), and `@path` file/image attachments compose with a
  stdin-piped prompt (verified with an image). `pi --list-models` prints a
  table filtered to credentialed providers; `--thinking
  off|minimal|low|medium|high|xhigh|max`.
  NDJSON events `session`/`agent_start`/`turn_start`/`message_start`/
  `message_update`/`message_end`/`turn_end`/`agent_end`; token-level
  `text_delta` updates; toolCall blocks on assistant `message_end`;
  toolResult messages carry `toolName`.
- Resume: `--session-id <uuid>` (creates if missing); id from the `session`
  event.
- Model: `--model` accepts Pi's `provider/model` pattern
  (`openrouter/openai/gpt-4o-mini` verified) or a pattern with `--provider`.
- System prompt: `--append-system-prompt` (append semantics verified live).
- Permissions: none natively — Pi never prompts. Read-only via `--tools read`
  (verified: only the read tool runs). `edit` == `auto` == default.
- CRITICAL QUIRK: exit code is 0 even when the turn fails. Errors surface as
  `stopReason: "error"` + `errorMessage` on the assistant message /
  `turn_end`; the adapter throws from the stream, never trusts the exit code.
- Auth: pure BYOK, ~20 provider env vars. MIT, repo `badlogic/pi-mono`.

### Goose (`goose`) — v1.41 audited, re-verified on 1.43

- Headless: `goose run --output-format stream-json`, prompt via `-t` or
  stdin with `-i -` (verified). MUST pass `--quiet`: without it goose prints
  an ASCII banner to STDOUT that corrupts the NDJSON stream. Events:
  `message` (role assistant: text tokens + toolRequest; role user:
  toolResponse) and a final `complete` with token counts (no cost).
- Resume: by session NAME — `--name <n> --resume` (verified recall). The
  headless stream exposes no session id, so callers name the first run via
  `extraArgs: ["--name", …]`.
- Model/provider: `--provider` and `--model` flags override
  `GOOSE_PROVIDER`/`GOOSE_MODEL` env; model naming is the provider's own.
- System prompt: `--system` ("additional instructions" — append, verified).
- Permissions: `GOOSE_MODE` env (auto/approve/chat/smart_approve). Chat mode
  skips ALL tools (agent cannot even read files — too weak for a `read` level);
  approve modes can hang headless. Adapter: `edit` = goose default,
  `auto` = GOOSE_MODE=auto.
- QUIRK: provider errors are reported as ordinary assistant text ("Ran into
  this error: …") with `complete.total_tokens: null` and exit 0 — no
  structured error event to throw on.
- Re-verified on 1.43 (see api-v2.md §12): `goose info -v` exists, exit 0,
  prints `GOOSE_PROVIDER`/`GOOSE_MODEL` and extensions without any LLM call
  — the auth/config probe. Unconfigured runs exit 1 with a clean
  "error: Error Unknown provider: ." message (no Rust panic on this
  version). `GOOSE_THINKING_EFFORT` is now first-class config. Stream-json
  emits `thinking` content blocks (a reasoning-delta source).
  `goose session list --format json` works; the stream still never carries
  a session id.
- Native structured output (verified 1.43): a recipe with
  `response.json_schema` works headless — goose injects a `final_output`
  tool and the final `text` content is the pure JSON object. `--recipe`
  CONFLICTS with `-t` (exit 2), so the prompt must be embedded in the
  synthesized recipe file.
- Auth: pure BYOK (`OPENROUTER_API_KEY` verified via `--provider
openrouter`). Apache-2.0, repo `block/goose` (now `aaif-goose/goose`).
  Install is a ~300 MB platform binary (curl installer / brew, no npm).

### Cline (`cline`) — npm `cline` v3.0 audited

- Headless: `cline --json "<prompt>"`. NDJSON events `hook_event`/
  `agent_event` (iteration\_\*, usage, content_start/delta/end for text and
  tool content) closed by `run_result` (finishReason, aggregate usage, final
  text). Errors: `run_result.finishReason: "error"` + exit 1.
- QUIRKS (all verified on 3.0.37):
  - Piped-stdin prompts error out despite the CLI claiming support — the
    prompt must be positional (argv size limit applies).
  - A single-word prompt is misparsed as a command name.
  - `--id <session>` resume is broken in JSON mode: the prompt positional is
    never accepted alongside it, in any order → adapter declares
    `sessionResume: false`.
  - Plan mode (`--plan`) still EXECUTES shell commands (verified writing a
    file through run_commands) → no `read` level.
  - Stray plain-text "AI SDK Warning …" lines appear on stdout mid-stream →
    the adapter filters non-JSON lines.
  - `-s` REPLACES the system prompt (RunOptions.systemPrompt promises
    append) → declared false.
- Re-verified on 3.0.46 (see api-v2.md §12): provider settings land at
  `<data>/settings/providers.json`; `CLINE_DATA_DIR` (drops the `data/`
  level), `CLINE_DIR` (keeps it), and `CLINE_PROVIDER_SETTINGS_PATH` (exact
  file) all work. Unauthenticated runs: exit 1,
  `run_result.finishReason: "error"`, message starting `Unauthorized:` — a
  stable detection signature. `@./path` mentions in the prompt genuinely
  inject file content (verified: answer recovered with zero tool calls).
- Auth: BYOK — `cline auth -p openrouter -k <key>` (also anthropic, openai,
  gemini, openai-compatible with `-b <baseurl>`), or per-run `-P`/`-k`.
  Apache-2.0, repo `cline/cline` (CLI at `apps/cli`).

## Audited, adapter on the way ("soon")

### Gemini CLI (`gemini`) — v0.49 audited, re-verified live on 0.46 (2026-07-22)

Deprecated upstream but still widely deployed — facts below verified with
real runs, so an adapter remains viable.

- Headless: `gemini -p "<prompt>" -o stream-json`. Clean NDJSON: `init`
  (`session_id`, `model`) → `message` (role user/assistant; assistant text
  arrives as deltas with `delta: true`) → `tool_use`/`tool_result`
  (`tool_id`, `status`, `output`) → terminal `result` with `status` and
  `stats` (`total/input/output_tokens`, `cached`, `duration_ms`,
  `tool_calls`, per-model breakdown). Stray "Ripgrep is not available"
  noise stays on stderr.
- TRUST GATE: an untrusted cwd exits **55** with a message on stderr —
  headless runs must pass `--skip-trust` (or
  `GEMINI_CLI_TRUST_WORKSPACE=true`).
- stdin composes with `-p` (verified): piped stdin is prepended, the `-p`
  text appended, into one user message.
- Permissions: `--approval-mode plan` is ENFORCED read-only — `write_file`
  returns "Access denied: plan path…" to the model, the run completes with
  the refusal, exit 0 (a genuine `readOnly`, unlike cline's plan mode).
  Bare `default` headless does not hang: the model attempts no writes at
  all — edits need `auto_edit`, everything needs `yolo`/`-y`.
- Resume: `-r latest` (or index) verified — prior-session recall works; ids
  surface in `init` and `--list-sessions` (human-readable list with UUIDs,
  not JSON). `--session-id <uuid>` pins new sessions; `--session-file`
  loads from a file.
- Usage: `cached` tokens and a per-model stats breakdown in `result` —
  richer than most shipped adapters.
- QUIRKS: default `model: auto` can spiral on trivial prompts (a "reply
  pong" run spent 2+ minutes self-investigating) — pin `-m`. Stats can be
  keyed to a different model than requested (asked `gemini-2.5-flash`, stats
  said `gemini-3.5-flash` — upstream routing/aliasing). `--allowed-tools`
  is deprecated in favor of the policy engine (`--policy` files).
- System prompt only via `GEMINI_SYSTEM_MD` env; MCP via `gemini mcp add`
  config + `--allowed-mcp-server-names` (no per-run inline MCP flag found).
- Auth: `GEMINI_API_KEY` (free AI Studio tier works headless), or Google
  account login (`~/.gemini/google_accounts.json`). Apache-2.0.
- Testable without subscription: YES (free key). Still the next easiest
  adapter; deprecation argues for shipping it while the surface is frozen.

### Antigravity CLI (`agy`) — audited live 2026-07-22

Gemini CLI's successor. README and docs claim TUI-only ("lightweight
Terminal User Interface") — the shipped binary disagrees: a full headless
surface exists, just undocumented.

- Headless: `agy -p/--print "<prompt>"` (`--print-timeout`, default 5m).
  UNDOCUMENTED but working: `--output-format json` → one object
  `{conversation_id, status, response, duration_seconds, num_turns, usage:
  {input_tokens, output_tokens, thinking_tokens, total_tokens}}`;
  `--output-format stream-json` → NDJSON `init` (cwd, full tool list) →
  `step_update` (`step_index`, `state ACTIVE|DONE`, `step_type
  user_input|agent_response|tool|checkpoint|error_message`, `tool_name`,
  `tool_info`, per-step `usage`) → terminal `result`. The values
  `ndjson`/`jsonl` are accepted but silently fall back to plain text.
- CRITICAL QUIRK: in default mode a permission ask self-CANCELs the
  headless run — `result.status: "CANCELED"`, empty `response`, **exit 0**.
  An adapter must gate on `result.status`, never the exit code, and pass
  `--mode plan|accept-edits` or `--dangerously-skip-permissions` for
  deterministic runs (plan-mode enforcement not yet tested).
- Models: `agy models` — clean one-per-line, cross-vendor
  (`gemini-3.6/3.5-flash-{high,medium,low}`, `gemini-3.1-pro-*`,
  `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b`); effort
  is baked into the gemini ids AND exposed as `--effort low|medium|high`.
- Sessions: `--conversation <id>` resume, `-c/--continue`;
  `conversation_id` in `init` and `result` (recall not yet tested).
- Also: `--agent` + `agy agents` listing, plugin system, `--sandbox`,
  `--add-dir`, projects.
- Auth: Google OAuth browser flow; unauthenticated `-p` exits 1 with
  "Authentication required" + URL on stderr; `agy models` prints a sign-in
  message. Proprietary.
- v2 fit: modelListing native, reasoning effort native, sessions by id,
  step-level usage with thinking tokens — one of the richest surfaces
  audited. Untested: plan-mode enforcement, resume recall, MCP, system
  prompt, attachments.

### Cursor CLI (`agent`, alias `cursor-agent`) — re-verified live 2026-07-22 (2026.07.17 build)

- Binary is now `agent` (`cursor-agent` still resolves) — `meta.bin` should
  list both, `agent` first.
- Headless: `agent -p --output-format stream-json` (`--stream-partial-output`
  for token deltas). Verified event taxonomy, claude-code-family shaped:
  `system` (`subtype: init`, `session_id`, `model`, `apiKeySource`) →
  `user` → `thinking` (`subtype delta|completed` — native reasoning
  deltas) → `assistant` (content blocks) → `tool_call`
  (`subtype started|completed`, `readToolCall`/`writeToolCall` shapes) →
  `result` (`subtype`, `is_error`, `result` text, `duration_ms`, camelCase
  `usage` incl. `cacheReadTokens`/`cacheWriteTokens`). `session_id` on
  every event.
- TRUST GATE: pass `--trust` in headless mode (workspace-trust prompt
  otherwise).
- Permissions (verified): `--mode plan` is ENFORCED read-only — write
  refused, agent reports it, exit 0, no file. Per docs, print mode WITHOUT
  `-f/--force` only *proposes* edits; `-f`/`--yolo` applies them. So:
  read → `--mode plan`, full → `-f`. `--sandbox enabled|disabled`,
  `--auto-review` classifier mode also exist.
- Models: `--list-models` verified — `id - Label` lines; effort/speed baked
  into ids (`gpt-5.3-codex-{low,high,xhigh}[-fast]`) plus bracket
  overrides on `--model` (`'claude-opus-4-8[context=1m,effort=high,fast=false]'`)
  — a second native reasoning-effort mechanism.
- Attachments: no flag — reference file paths in the prompt and the agent
  auto-reads them (images/videos per docs); cline-style mention injection,
  so `"emulated"` tier at best.
- Resume: `--resume [chatId]` / `--continue`; ids surface on every event
  (recall not yet live-tested).
- Auth: `agent login` browser flow (verified working; `apiKeySource:
  "login"`) or `CURSOR_API_KEY`. `logout` exists; no status subcommand —
  probe via a cheap run or config presence. Proprietary.
- Testable without subscription: LIMITED (Hobby quota) — but a logged-in
  Pro session verified everything above.

### GitHub Copilot CLI (`copilot`) — v1.0 audited

- Headless: `copilot -p "<prompt>" --output-format json` (JSONL);
  `--allow-all-tools` required non-interactively; resume `--resume`/
  `--session-id`; `--model`.
- Auth: `COPILOT_GITHUB_TOKEN`/`GH_TOKEN` (fine-grained PAT with Copilot
  Requests). Copilot FREE excludes the CLI — Pro ($10/mo) minimum.
  Proprietary.
- Testable without subscription: NO.

### Factory droid (`droid`) — v0.164 audited

- Headless: `droid exec -o stream-json` (also `json`, `stream-jsonrpc`);
  resume `-s <sessionId>`; `--auto low|medium|high`; `-m`. The most
  Claude-Code-like surface of the unshipped set; even unauthenticated errors
  are structured JSON.
- Auth: `FACTORY_API_KEY` — paid plans only ($20/mo+; the 2025 free-token
  promo ended; BYOK is itself a paid feature). Proprietary.
- Testable without subscription: NO.

### Kiro CLI (`kiro-cli`) — audited from docs (installer blocked in sandbox)

- Headless: `kiro-cli chat --no-interactive --trust-all-tools` — plain text
  only; JSON output is an open upstream feature request (kirodotdev/Kiro
  #5423). Resume `--resume`/`--resume-id`.
- Auth: `KIRO_API_KEY` is paid-only; the free Builder ID tier (50
  credits/mo) needs a one-time interactive device-flow login. Proprietary.
- Blocked on: machine-readable output. Re-audit when #5423 lands.

### Devin CLI (`devin`) — v3000.1 audited

- Headless: `devin -p "<prompt>"` — plain text only; the structured surface
  is `devin acp` (JSON-RPC over stdio), a different integration shape than
  an NDJSON stream. `--permission-mode`; `--model`; resume `-r`.
- Auth: browser/token login into a credentials file; no API-key env var.
  Free self-serve plan exists (light quota).
- Blocked on: no stream-JSON print mode; awkward non-interactive auth.

### Amp (`amp`) — v0.0.17832… audited

- Headless: `amp -x "<prompt>" --stream-json` (explicitly Claude-Code-
  compatible stream format), `--stream-json-input` for bidirectional JSONL;
  resume `amp threads continue <threadId>`. No model flag (mode-based:
  `-m deep|rush|smart|free`).
- Auth: `AMP_API_KEY`; the ad-supported Amp Free tier covers CLI use at $0.
  Proprietary.
- Testable without subscription: YES (Amp Free). Near-reuse of the
  claude-code parser is plausible.

## Testing shipped adapters without subscriptions

One OpenRouter (or any provider) key drives all five BYOK adapters:

```bash
export ANYAGENT_LIVE=1 OPENROUTER_API_KEY=sk-or-…
export ANYAGENT_OPENCODE_MODEL=openrouter/openai/gpt-4o-mini
export ANYAGENT_KILO_MODEL=openrouter/openai/gpt-4o-mini
export ANYAGENT_PI_MODEL=openrouter/openai/gpt-4o-mini
export GOOSE_PROVIDER=openrouter ANYAGENT_GOOSE_MODEL=openai/gpt-4o-mini
cline auth openrouter -k "$OPENROUTER_API_KEY" -m openai/gpt-4o-mini
export ANYAGENT_CLINE_MODEL=openai/gpt-4o-mini
bun test packages/anyagent/test/*.live.test.ts
```

A free Google AI Studio `GEMINI_API_KEY` works the same way for opencode,
goose, pi, and cline (and for the future gemini-cli adapter).

## M1 implementation findings (2026-07-22)

Facts discovered while building API v2 M1 (all live on this machine unless
noted; versions: claude 2.1.217, codex 0.144.6, opencode 1.18.3, pi 0.80.6,
goose 1.43.0, cline 3.0.46 fixtures):

- claude-code: with `--json-schema`, the model answers through a
  `StructuredOutput` tool_use and emits zero text blocks; the `result` event
  carries `structured_output` (object) and `result` (its exact
  serialization). Recorded as `fixtures/claude-code/structured.jsonl`. The
  current mutating built-ins for a deny list are `Bash,Edit,NotebookEdit,Write`
  (comma-separated `--disallowedTools` value). 2.1.217 behaves identically to
  2.1.216 on everything re-checked.
- codex: `codex login status` prints its verdict to stderr ("Logged in using
  ChatGPT"), exit 0. `codex debug models` returns one JSON object
  (`{"models": [...]}`, ~244 KB — mostly embedded prompt text) with 7 models;
  `supported_reasoning_levels` confirms the open per-model effort vocabulary
  (sol/terra accept low…max plus ultra); `visibility: "hide"` marks models the
  CLI's own picker hides (e.g. codex-auto-review). Fixtures prove
  `input_tokens` folds cache reads in (9633 input / 7552 cached in one step)
  and reasoning is folded into `output_tokens` — the adapter reports native
  accounting with the folded shares split out as cacheReadTokens /
  reasoningTokens.
- opencode: `opencode models` prints one `provider/model` per line, nothing
  else, and works unauthenticated (lists the 6 built-in zen models). Fixture
  `part.callID` (`call_…`) is the tool call/result pairing key; `part.id` is
  a fallback only.
- pi: `pi --list-models` prints a whitespace-aligned table
  (`provider model context max-out thinking images`), credential-filtered.
  Per-turn usage reports `cacheRead`/`cacheWrite`/`reasoning` alongside
  input/output/cost (fixture-confirmed nonzero cacheRead).
- goose: `goose info -v` against an empty config still exits 0 — the
  unconfigured signal is the *absence* of the `GOOSE_PROVIDER:`/`GOOSE_MODEL:`
  lines, not the exit code. The 1.43 binary's content-block serde tags include
  `thinking {thinking, signature}`, `redactedThinking`,
  `toolConfirmationRequest`, `frontendToolRequest`, `systemNotification`,
  `image`; only `thinking`/`redactedThinking` were observed headless.
- cline: fixtures confirm `toolCallId` correlates call/result and
  `run_result` carries cache read/write tokens; no reasoning-token field
  exists in any recording.
