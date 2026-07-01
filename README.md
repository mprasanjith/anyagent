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

Capabilities differ per agent — check `agent.capabilities`; unsupported requests
throw `AnyAgentError` (`code: "UnsupportedCapability"`). Drop to `agent.raw` for
agent-specific flags.
