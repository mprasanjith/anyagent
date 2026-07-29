---
"anyagent-js": minor
---

Billing mode, usage windows, and canonical vendors.

- `AuthStatus.billing` (required): how runs are paid for — `"subscription" | "api-key" | "unknown"` — asserted by each adapter, never inferred from `method` strings; `ModelInfo.billing` can override it per model.
- `agent.usageStatus(opts?)`: how much of the harness's rolling limits remain. Always callable — a harness with no surface answers `{ state: "unknown" }` instead of throwing. claude-code reads the CLI's cached window snapshot (5-hour, weekly, model-scoped buckets; `asOf` carries the cache's age) and codex asks its app-server live; `{ model }` scopes the answer to one placement.
- `SystemProbe.rpc`: one-shot JSON-RPC (NDJSON over stdio) service dialogues for discovery, with ordered exchanges and fail-fast on non-JSON output.
- `modelListing` flips to `"probed"` on claude-code (documented alias vocabulary plus the CLI's cached org entries) and gemini-cli (documented aliases and full ids).
- `ModelInfo.provider` now means the canonical model vendor — the pricing join key — never a gateway or biller: `kilo/~anthropic/…` yields `"anthropic"`, `openrouter/openai/…` yields `"openai"`, and `opencode/big-pickle` yields nothing. Previously the opencode, kilo, and pi adapters put the leading gateway segment here.
- gemini-cli turns now report token usage, read from the endpoint's `_meta.quota` channel.
