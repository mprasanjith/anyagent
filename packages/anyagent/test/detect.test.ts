import { expect, test } from "bun:test";

import { defaultDetect, runDetect } from "../src/internal/detect.js";
import type {
  Adapter,
  Capabilities,
  Detection,
  RunResult,
  VersionProbe,
} from "../src/types.js";

const caps: Capabilities = {
  attachments: false,
  authStatus: false,
  cwd: "native",
  effort: false,
  mcp: false,
  modelListing: false,
  modelSelection: "native",
  readOnly: false,
  session: false,
  sessionFork: false,
  streaming: "native",
  structuredOutput: false,
  systemPrompt: false,
};

// biome-ignore lint/correctness/useYield: stub parser; never invoked in detection tests.
const noopParse = async function* noopParse(): AsyncGenerator<
  never,
  RunResult
> {
  await Promise.resolve();
  return { events: [], raw: undefined, text: "" };
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
  resolved: Record<string, string | undefined>,
  versionOut: string
): VersionProbe => ({
  exec: () => Promise.resolve({ code: 0, stderr: "", stdout: versionOut }),
  which: (b) => Promise.resolve(resolved[b]),
});

test("resolves the first bin alias found on PATH and parses the version", async () => {
  const r = await defaultDetect(
    adapter,
    probe(
      { demo: undefined, "demo-cli": "/usr/bin/demo-cli" },
      "Demo 1.2.3 (build)"
    )
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
    probe({ demo: undefined, "demo-cli": undefined }, "")
  );
  expect(r.installed).toBe(false);
  expect(r.path).toBeUndefined();
  expect(r.version).toBeUndefined();
});

test("installed but no version when regex misses (never blocks use)", async () => {
  const r = await defaultDetect(
    adapter,
    probe({ demo: "/x/demo" }, "no version here")
  );
  expect(r.installed).toBe(true);
  expect(r.version).toBeUndefined();
});

test("installed but no version when the version probe throws", async () => {
  const r = await defaultDetect(adapter, {
    exec: () => Promise.reject(new Error("probe blew up")),
    which: () => Promise.resolve("/x/demo"),
  });
  expect(r.installed).toBe(true);
  expect(r.version).toBeUndefined();
});

test("falls back to default version command and regex (captures suffix)", async () => {
  const noSpec: Adapter = { ...adapter, detection: {} };
  const r = await defaultDetect(
    noSpec,
    probe({ demo: "/x/demo", "demo-cli": undefined }, "v1.2.3-beta.1 (nightly)")
  );
  expect(r.version).toBe("1.2.3-beta.1");
});

test("runDetect delegates to a custom adapter.detect when present", async () => {
  const custom: Detection = {
    adapter,
    capabilities: caps,
    id: "demo",
    installed: true,
    name: "Demo",
    path: "/custom/demo",
    version: "9.9.9",
  };
  const withDetect: Adapter = {
    ...adapter,
    detect: () => Promise.resolve(custom),
  };
  const r = await runDetect(
    withDetect,
    probe({ demo: undefined, "demo-cli": undefined }, "")
  );
  expect(r).toBe(custom);
  expect(r.path).toBe("/custom/demo");
});
