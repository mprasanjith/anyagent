# anyagent

Detect the coding-agent CLI a user already has installed and drive it through one interface.

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

Built-in adapters: `anyagent/claude-code`, `anyagent/codex`.

Capabilities differ per agent — check `agent.capabilities`; unsupported requests
throw `AnyAgentError` (`code: "UnsupportedCapability"`, message names the agent).

## Escape hatches

The unified surface is the feature subset most agents share. To reach a native
capability it doesn't model:

- **`extraArgs`** — append native CLI flags while keeping normalized events:
  `agent.run(prompt, { extraArgs: ["--some-native-flag"] })`.
- **`agent.raw`** — full manual control: `raw.buildInvocation(prompt, opts)`
  returns the exact argv; `raw.spawn(prompt, opts)` returns a Node
  `ChildProcess` you drive yourself.
