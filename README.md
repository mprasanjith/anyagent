# AnyAgent

Detect the coding agent CLI your end user already has installed (Claude Code, Codex, and more) and drive it programmatically through one interface. Prompts run on their agent, their login, their subscription: no API keys to collect, no inference bill to pay.

## Install

```sh
npm i anyagent-js
```

Two runtime dependencies. Node.js 18+ or Bun, ESM only. Built-in adapters cover Claude Code, Codex, opencode, Kilo Code, Pi, goose, Cline, Gemini CLI, Antigravity, and Cursor, each importable from its own subpath (`anyagent-js/claude-code`, `anyagent-js/codex`, …).

## Use

```ts
import { create, detect } from "anyagent-js";

const installed = await detect();
const [first] = installed;
if (!first) {
  throw new Error("No supported coding agent found.");
}

const agent = create(first);
const result = await agent.run(
  "Summarize this repository for a new contributor."
);

console.log(result.text);
```

`detect()` scans `PATH` for every supported agent, and `create()` wraps one in a runnable handle. The run is also an async iterable: loop over it with `for await` to render normalized events as the agent works. `agent.session()` threads one conversation across many runs.

A run is autonomous: nothing pauses to wait for approval, at the full autonomy the CLI offers. The one restriction is `readOnly: true`, which guarantees nothing on the machine changes (this is only supported on a subset of agent CLIs).

Capabilities differ per agent: check `agent.capabilities` before asking for an option. Most fields are `"native"`, `"emulated"`, or `false`. An emulated capability, such as a system prompt or structured output on a CLI whose flags lack it, is supplied by AnyAgent’s core so it works the same on every agent; pass a JSON Schema as `schema` to `run()` and read the parsed reply from `result.json`. `agent.authStatus()` and `agent.models()` answer whether the CLI is signed in and which models it accepts. An unsupported request throws `AnyAgentError` (`code: "UnsupportedCapability"`) before anything spawns.

