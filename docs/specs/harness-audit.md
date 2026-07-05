# Harness audit

Per-CLI facts behind the landing-page statuses and the adapter capability
tables. "Shipped" means the adapter exists in `packages/anyagent/src/<id>/`
with recorded fixtures and passing live tests; "soon" means the headless
surface is audited here and the adapter is on the way. Every claim below was
verified hands-on (CLI installed, flags confirmed from `--help`, and — for
shipped adapters — real runs recorded) in July 2026; versions and pricing move
fast, so re-verify before building on a "soon" row.

## Shipped

### Claude Code (`claude`)

- Headless: `claude -p --output-format stream-json --verbose`, prompt over
  stdin. Resume `--resume <sessionId>`; `--append-system-prompt`;
  `--mcp-config`; `--permission-mode default|acceptEdits|bypassPermissions`.
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
  flags. A denied permission in a non-interactive run can HANG waiting for
  approval (observed live) — so the adapter offers no `read` level.
  `--auto` approves everything not explicitly denied; the bare default
  already edits.
- Auth: BYOK — auto-detects `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`, …; MIT, repo `anomalyco/opencode` (moved from `sst`).
- Quirks: without a git root, relative paths in the model's tool calls can
  land outside the cwd (model-dependent, not adapter-fixable).

### Kilo Code (`kilo`, `kilocode`) — @kilocode/cli v7.4 audited

- opencode fork; identical `run --format json` surface and event stream,
  verified independently against real `kilo` output (fixtures recorded from
  the kilo binary, not copied from opencode).
- Auth: BYOK via the same env vars, or a Kilo account (free tier: starter
  credits + free models). MIT.

### Pi (`pi`) — @earendil-works/pi-coding-agent v0.80 audited

- Headless: `pi --mode json -p <prompt>` (positional only, no stdin form).
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

### Goose (`goose`) — v1.41 audited

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
- Auth: BYOK — `cline auth -p openrouter -k <key>` (also anthropic, openai,
  gemini, openai-compatible with `-b <baseurl>`), or per-run `-P`/`-k`.
  Apache-2.0, repo `cline/cline` (CLI at `apps/cli`).

## Audited, adapter on the way ("soon")

### Gemini CLI (`gemini`) — v0.49 audited

- Headless: `gemini -p "<prompt>" --output-format stream-json` (JSONL) or
  `json`; `--approval-mode default|auto_edit|yolo|plan`; resume `--resume`,
  `--session-id`; model `-m`. System prompt only via `GEMINI_SYSTEM_MD` env;
  MCP via settings + `--allowed-mcp-server-names`.
- Auth: `GEMINI_API_KEY` (free AI Studio tier works headless). Apache-2.0.
- Testable without subscription: YES (free key). Next easiest adapter.

### Cursor CLI (`cursor-agent`) — 2026.07 build audited

- Headless: `cursor-agent -p --output-format stream-json`
  (`--stream-partial-output` for deltas); resume `--resume <chatId>`;
  `--model`; permissions `-f`, `--mode plan|ask`, `--sandbox`.
- Auth: `CURSOR_API_KEY` (dashboard). Free Hobby keys work headless but the
  agent-credit quota is tiny. Proprietary.
- Testable without subscription: LIMITED (Hobby quota).

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
