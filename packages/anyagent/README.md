# AnyAgent

Detect the coding-agent CLI your end user already has installed and drive it through one unified interface. Prompts run on their agent, their login, their subscription: no API keys to collect, no inference bill to pay.

## Install

```sh
npm i anyagent
```

Zero runtime dependencies. Node.js 18+ or Bun, ESM only. Built-in adapters cover Claude Code, Codex, opencode, Kilo Code, Pi, goose, and Cline, each importable from its own subpath (`anyagent/claude-code`, `anyagent/codex`, …).

## Use

```ts
import { create, detect } from "anyagent";

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

`detect()` scans `PATH` for every supported agent, and `create()` wraps one in a runnable handle. Use `agent.runStream()` instead of `run()` to render normalized events as the agent works.

A run is unattended, at the full autonomy the CLI offers. The one restriction is `readOnly: true`, which guarantees nothing on the machine changes; `agent.supports("readOnly")` both checks it at runtime and unlocks the option in the types. Agents that cannot guarantee it throw instead of pretending.

Capabilities differ per agent: check `agent.capabilities` before asking for an option. Most fields are `"native"`, `"emulated"`, or `false`. An emulated capability, such as a system prompt or structured output on a CLI whose flags lack it, is supplied by AnyAgent’s core so it works the same on every agent; pass a JSON Schema as `schema` to `run()` and read the parsed reply from `result.json`. `agent.authStatus()` and `agent.models()` answer whether the CLI is signed in and which models it accepts, without a paid call. An unsupported request throws `AnyAgentError` (`code: "UnsupportedCapability"`) before anything spawns.

## Documentation

The docs site (`apps/web` in this repository) covers the rest: a quickstart, guides for detecting agents, running prompts, streaming progress, and handling errors, the recommended production flow, escape hatches down to each CLI’s native surface, and a full API reference.
