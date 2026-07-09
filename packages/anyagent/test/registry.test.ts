import { expect, test } from "bun:test";

import { detect } from "../src/internal/registry.js";
import type { VersionProbe } from "../src/internal/types.js";
import { fakeStreaming, fakeText } from "./fake-adapter.js";

const probe: VersionProbe = {
  exec: () => Promise.resolve({ code: 0, stderr: "", stdout: "1.0.0" }),
  which: (b) =>
    Promise.resolve(b === "fake-stream" ? "/usr/bin/fake-stream" : null),
};

test("detect returns only the installed adapters with resolved paths", async () => {
  const res = await detect({ adapters: [fakeStreaming, fakeText], probe });
  expect(res.map((r) => r.id)).toEqual(["fake-stream"]);
  expect(res[0]?.path).toBe("/usr/bin/fake-stream");
  expect(res[0]?.adapter).toBe(fakeStreaming);
});

test("detect returns empty when none installed", async () => {
  const none: VersionProbe = {
    exec: () => Promise.resolve({ code: 0, stderr: "", stdout: "" }),
    which: () => Promise.resolve(null),
  };
  expect(await detect({ adapters: [fakeStreaming], probe: none })).toEqual([]);
});
