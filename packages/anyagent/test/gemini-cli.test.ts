import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { runConformance } from "../src/conformance.js";
import { geminiCli } from "../src/gemini-cli.js";
import { fakeSystemProbe } from "./fake-adapter.js";

const transcript = readFileSync(
  path.join(import.meta.dir, "fixtures/acp/gemini-cli.jsonl"),
  "utf-8"
);

test("gemini-cli drives its CLI over the ACP endpoint", () => {
  const adapter = geminiCli();
  expect(adapter.mode).toBe("acp");
  // Without the bypass the endpoint downgrades its approval mode on an
  // untrusted cwd with only a stderr notice.
  expect(adapter.acp.command).toEqual(["gemini", "--acp", "--skip-trust"]);
  // Plan mode is escapable headless (exit_plan_mode self-approves), so no mode
  // option is declared and permission denial holds the read-only line.
  expect(adapter.acp.readOnly).toBeUndefined();
  expect(adapter.capabilities.readOnly).toBe("emulated");
  // Reattachment is broken upstream (#15502).
  expect(adapter.capabilities.resume).toBe(false);
});

test("acp settings put the model on argv and never default one", () => {
  const { settings } = geminiCli().acp;
  expect(settings?.({ model: "gemini-3.5-flash-lite" })).toEqual({
    args: ["-m", "gemini-3.5-flash-lite"],
  });
  // Automatic routing can spend minutes on a trivial prompt, so an unset model
  // must stay unset.
  expect(settings?.({})).toEqual({ args: [] });
});

test("authStatus: oauth_creds.json means authenticated via oauth", async () => {
  const probe = fakeSystemProbe({
    readFile: (p) =>
      Promise.resolve(
        p === "/home/fake/.gemini/oauth_creds.json" ? "{}" : undefined
      ),
  });
  const status = await geminiCli().authStatus?.(probe);
  expect(status?.state).toBe("authenticated");
  expect(status?.method).toBe("oauth");
});

test("authStatus: GEMINI_API_KEY or GOOGLE_API_KEY means authenticated", async () => {
  const gemini = await geminiCli().authStatus?.(
    fakeSystemProbe({ env: { GEMINI_API_KEY: "k" } })
  );
  const google = await geminiCli().authStatus?.(
    fakeSystemProbe({ env: { GOOGLE_API_KEY: "k" } })
  );
  expect(gemini?.state).toBe("authenticated");
  expect(gemini?.method).toBe("api-key");
  expect(google?.state).toBe("authenticated");
});

test("authStatus: a selected auth type without visible creds is unknown", async () => {
  // Keys can live in the OS keychain or a CLI-discovered .env file the
  // probe cannot see; a configured auth type must not read as a denial.
  const probe = fakeSystemProbe({
    readFile: (p) =>
      Promise.resolve(
        p === "/home/fake/.gemini/settings.json"
          ? JSON.stringify({
              security: { auth: { selectedType: "gemini-api-key" } },
            })
          : undefined
      ),
  });
  const status = await geminiCli().authStatus?.(probe);
  expect(status?.state).toBe("unknown");
  expect(status?.method).toBe("gemini-api-key");
});

test("authStatus: a bare machine is unauthenticated", async () => {
  const status = await geminiCli().authStatus?.(fakeSystemProbe());
  expect(status?.state).toBe("unauthenticated");
});

test("authStatus: a corrupt settings.json still reads as unauthenticated", async () => {
  const probe = fakeSystemProbe({
    readFile: (p) =>
      Promise.resolve(
        p === "/home/fake/.gemini/settings.json" ? "not json" : undefined
      ),
  });
  const status = await geminiCli().authStatus?.(probe);
  expect(status?.state).toBe("unauthenticated");
});

test("conformance holds over the recorded transcript", async () => {
  await runConformance(geminiCli(), {
    fixtures: {},
    transcripts: { recorded: transcript },
  });
});
