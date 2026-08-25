---
"anyagent-js": minor
---

Opt-in network access for usage discovery, plus fixes to the local answers.

`create(agent, { network: true })` — off by default — lets an adapter read a
meter that only lives at its CLI's vendor. `{ network: { fetch } }` supplies
your own `fetch` for a proxy or a test double; `network: false` is an explicit
kill switch. Requests are time- and size-capped, and a redirect that leaves the
original origin ends the exchange rather than replaying the credential
elsewhere. A new `usageStatus: "remote"` capability marks the adapters that
need the opt-in.

- **opencode** reports its Zen plan's rolling, weekly, and monthly windows
  (`usageStatus: "remote"`), keyed by the Zen credential the CLI stores at
  login or `OPENCODE_GO_API_KEY`.
- **Claude Code** answers from the live usage endpoint when network is on,
  falling back to the CLI's cached snapshot otherwise, and reports the
  pay-as-you-go balance as `credits` — from the `spend` block, or the older
  `extra_usage` one. An expired token is never refreshed: refreshing would
  rotate the credential out from under the `claude` CLI and end its session.
- **Claude Code** now honors `CLAUDE_CONFIG_DIR`. An isolated login previously
  answered from the home config file, or not at all.
- **Codex** windows carry `windowMinutes`, and every limit set in
  `rateLimitsByLimitId` is read rather than only the mirrored top-level pair.
  Window labels are prefixed with their limit id. Wire position is not window
  identity: OpenAI has shipped the 7-day figure under `primary` with
  `secondary` absent, which previously read as a 5-hour bucket.
- **Antigravity** reports its account-wide quota (`usageStatus: "probed"`),
  read from the language server every Antigravity product runs on loopback.
  No opt-in: nothing leaves the machine. Buckets are per model group, so
  `{ model }` narrows to the Gemini or the Claude/GPT pool. No bucket is
  required — a Pro account reports weekly buckets and no 5-hour ones.
- **Antigravity** `models()` and `authStatus()` are fixed. `agy models` now
  prints `<id>\t<display name>`, and the id parser tested the whole line
  against the id shape — so it matched nothing, `models()` threw, and every
  signed-in user read as signed out.
- `UsageWindow.windowMinutes` and `UsageStatus.credits` are new: the first
  identifies a window across releases, the second reports the pay-as-you-go
  balance that keeps a harness usable once its windows are spent.
- `SystemProbe` gains `fetch` (egress, opt-in), plus `fetchLocal` and
  `localListeners` for reaching a service already running on the machine.
  The latter two are always present.
- Docs: a new "Usage and limits" guide covers reading windows, scoping to a
  model, staleness, the network opt-in, and credits. The Codex and Claude
  Code adapter pages had claims this change made untrue; both are corrected.
