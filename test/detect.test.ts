import { expect, test } from "bun:test";

import { defaultDetect } from "../src/internal/detect.js";
import type {
  Adapter,
  CapabilityTable,
  RunResult,
  VersionProbe,
} from "../src/internal/types.js";

const caps: CapabilityTable = {
  cwd: true,
  mcp: false,
  modelSelection: true,
  permissionLevels: ["edit"],
  sessionResume: false,
  streaming: true,
  structuredOutput: false,
  systemPrompt: false,
};

// oxlint-disable-next-line require-yield -- stub parser; never invoked in detection tests.
const noopParse = async function* noopParse(): AsyncGenerator<
  never,
  RunResult
> {
  await Promise.resolve();
  return { events: [], exitCode: 0, raw: null, text: "" };
};

const adapter: Adapter = {
  buildInvocation: () => ({ args: [], command: "demo" }),
  capabilities: caps,
  detection: {
    versionCommand: ["--version"],
    versionRegex: /(?<version>\d+\.\d+\.\d+)/u,
  },
  meta: { bin: ["demo", "demo-cli"], id: "demo", name: "Demo" },
  parse: noopParse,
};

const probe = (
  resolved: Record<string, string | null>,
  versionOut: string
): VersionProbe => ({
  exec: () => Promise.resolve({ code: 0, stderr: "", stdout: versionOut }),
  which: (b) => Promise.resolve(resolved[b] ?? null),
});

test("resolves first bin on PATH and parses version", async () => {
  const r = await defaultDetect(
    adapter,
    probe({ demo: null, "demo-cli": "/usr/bin/demo-cli" }, "Demo 1.2.3 (build)")
  );
  expect(r.installed).toBe(true);
  expect(r.path).toBe("/usr/bin/demo-cli");
  expect(r.version).toBe("1.2.3");
  expect(r.adapter).toBe(adapter);
  expect(r.capabilities).toBe(caps);
});

test("not installed when no bin resolves", async () => {
  const r = await defaultDetect(
    adapter,
    probe({ demo: null, "demo-cli": null }, "")
  );
  expect(r.installed).toBe(false);
  expect(r.path).toBeNull();
  expect(r.version).toBeNull();
});

test("installed but null version when regex misses (never blocks use)", async () => {
  const r = await defaultDetect(
    adapter,
    probe({ demo: "/x/demo" }, "no version here")
  );
  expect(r.installed).toBe(true);
  expect(r.version).toBeNull();
});
