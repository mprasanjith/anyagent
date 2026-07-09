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
  "Summarize this repository for a new contributor.",
  {
    permission: "read",
  }
);

console.log(result.text);
```

`detect()` scans `PATH` for every supported agent, and `create()` wraps one in a runnable handle. Use `agent.runStream()` instead of `run()` to render normalized events as the agent works.

Capabilities differ per agent: check `agent.capabilities` before asking for an option. An unsupported request throws `AnyAgentError` (`code: "UnsupportedCapability"`) before anything spawns.

## Documentation

The docs site (`apps/web` in this repository) covers the rest: a quickstart, guides for detecting agents, running prompts, streaming progress, and handling errors, the recommended production flow, escape hatches down to each CLI’s native surface, and a full API reference.
