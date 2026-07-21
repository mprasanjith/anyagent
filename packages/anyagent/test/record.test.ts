import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const runCli = (args: string[]) =>
  spawnSync("bun", ["src/internal/record.ts", ...args], {
    cwd: root,
    encoding: "utf-8",
  });

test("exits 2 with usage when required args are missing", () => {
  const r = runCli([]);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("usage:");
});

test("exits 2 for an unknown adapter id", () => {
  const r = runCli(["nope", "scenario", "a prompt"]);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("unknown adapter: nope");
});
