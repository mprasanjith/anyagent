#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BUILTINS } from "./builtins.js";
import { spawnAndStream } from "./runtime/spawn.js";

const main = async (): Promise<void> => {
  const [id, scenario, ...promptParts] = process.argv.slice(2);
  if (!(id && scenario) || promptParts.length === 0) {
    process.stderr.write(
      "usage: anyagent-record <adapterId> <scenario> <prompt...>\n"
    );
    process.exit(2);
  }
  const adapter = BUILTINS.find((a) => a.meta.id === id);
  if (!adapter) {
    process.stderr.write(`unknown adapter: ${id}\n`);
    process.exit(2);
  }
  const inv = adapter.buildInvocation(promptParts.join(" "), {
    permission: "read",
  });
  const source = spawnAndStream(inv);
  let body = "";
  for await (const line of source.lines()) {
    body += `${line}\n`;
  }
  try {
    await source.exitCode;
  } catch {
    // Record whatever was produced even on a nonzero exit.
  }
  const out = path.join("test/fixtures", id, `${scenario}.jsonl`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, body);
  process.stderr.write(`wrote ${out}\n`);
};

await main();
