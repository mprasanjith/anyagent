# AnyAgent

Detect the coding-agent CLI your end user already has installed and drive it through one unified interface. Prompts run on their agent, their login, their subscription: no API keys to collect, no inference bill to eat.

```ts
import { create, detect } from "anyagent";
import { claudeCode } from "anyagent/claude-code";

const installed = await detect(); // every supported agent present, unordered
const agent = create(installed[0] ?? claudeCode());

const result = await agent.run("summarize the README", { permission: "edit" });
console.log(result.text);

for await (const ev of agent.runStream("refactor foo.ts")) {
  if (ev.type === "text-delta") {
    process.stdout.write(ev.text);
  }
}
```

Zero runtime dependencies. Node 18+ or Bun, ESM. Built-in adapters: `anyagent/claude-code`, `anyagent/codex`.

Capabilities differ per agent: check `agent.capabilities`. An unsupported request throws `AnyAgentError` (`code: "UnsupportedCapability"`) before anything spawns.

## Documentation

The docs site (`apps/web` in this repo) covers the full surface: a quickstart, guides for detection, streaming, and error handling, the recommended production flow, and an API reference generated from the source.

## Escape hatches

The unified surface is the feature subset most agents share. To reach a native capability it doesn't model:

- **`extraArgs`**: append native CLI flags while keeping normalized events: `agent.run(prompt, { extraArgs: ["--some-native-flag"] })`
- **`agent.raw`**: full manual control. `raw.buildInvocation(prompt, opts)` returns the exact argv; `raw.spawn(prompt, opts)` returns a Node `ChildProcess` you drive yourself
