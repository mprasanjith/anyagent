import { expect, test } from "bun:test";

import { create } from "../src/index.js";
import { fetchJson, MAX_BODY_BYTES } from "../src/internal/http.js";
import type { FetchLike, StdoutAdapter, SystemProbe } from "../src/types.js";
import { fakeStreaming, fakeSystemProbe } from "./fake-adapter.js";

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const redirect = (to: string, status = 302): Response =>
  new Response(null, { headers: { location: to }, status });

test("fetchJson returns the parsed body and the status", async () => {
  const res = await fetchJson(
    () => Promise.resolve(ok({ used: 12 })),
    "https://v.example/u"
  );
  expect(res).toEqual({ body: { used: 12 }, status: 200 });
});

test("fetchJson passes the caller's headers through", async () => {
  let seen: Record<string, string> | undefined;
  await fetchJson(
    ((_url, init) => {
      seen = init?.headers;
      return Promise.resolve(ok({}));
    }) as FetchLike,
    "https://v.example/u",
    { headers: { authorization: "Bearer t" } }
  );
  expect(seen).toEqual({ authorization: "Bearer t" });
});

// A signed-out answer is an answer; only transport failure is "no answer".
test("fetchJson surfaces a non-2xx that actually arrived", async () => {
  const res = await fetchJson(
    () => Promise.resolve(ok({ error: "unauthorized" }, 401)),
    "https://v.example/u"
  );
  expect(res?.status).toBe(401);
});

test("fetchJson follows a redirect within one origin", async () => {
  const seen: string[] = [];
  const res = await fetchJson((url) => {
    seen.push(String(url));
    return Promise.resolve(
      seen.length === 1 ? redirect("https://v.example/v2/u") : ok({ used: 3 })
    );
  }, "https://v.example/u");
  expect(seen).toEqual(["https://v.example/u", "https://v.example/v2/u"]);
  expect(res?.body).toEqual({ used: 3 });
});

// The platform strips `Authorization` across origins but not `Cookie` or
// `x-api-key`, which is exactly what these endpoints authenticate with.
test("fetchJson refuses to replay a credential at another origin", async () => {
  const seen: string[] = [];
  const res = await fetchJson((url) => {
    seen.push(String(url));
    return Promise.resolve(
      seen.length === 1
        ? redirect("https://attacker.example/u")
        : ok({ used: 3 })
    );
  }, "https://v.example/u");
  expect(seen).toEqual(["https://v.example/u"]);
  expect(res).toBeUndefined();
});

test("fetchJson gives up rather than follow a redirect loop", async () => {
  let hops = 0;
  const res = await fetchJson(() => {
    hops += 1;
    return Promise.resolve(redirect("https://v.example/again"));
  }, "https://v.example/u");
  expect(res).toBeUndefined();
  expect(hops).toBeLessThanOrEqual(6);
});

test("fetchJson refuses a body whose declared length exceeds the cap", async () => {
  const res = await fetchJson(
    () =>
      Promise.resolve(
        new Response("{}", {
          headers: { "content-length": String(MAX_BODY_BYTES + 1) },
        })
      ),
    "https://v.example/u"
  );
  expect(res).toBeUndefined();
});

// A lying or absent Content-Length must not get past the cap either.
test("fetchJson refuses an oversized body that understated its length", async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  const res = await fetchJson(
    () => Promise.resolve(new Response(stream)),
    "https://v.example/u"
  );
  expect(res).toBeUndefined();
});

test("fetchJson answers undefined when the request fails outright", async () => {
  const res = await fetchJson(
    () => Promise.reject(new Error("ENOTFOUND")),
    "https://v.example/u"
  );
  expect(res).toBeUndefined();
});

test("fetchJson answers undefined when the body is not JSON", async () => {
  const res = await fetchJson(
    () => Promise.resolve(new Response("<html>nope</html>")),
    "https://v.example/u"
  );
  expect(res).toBeUndefined();
});

// --- create({ network }) wiring -------------------------------------------

// Captures the probe an adapter is actually handed.
const probeCatcher = (): {
  adapter: StdoutAdapter;
  seen: () => SystemProbe;
} => {
  let captured: SystemProbe | undefined;
  const adapter: StdoutAdapter = {
    ...fakeStreaming,
    capabilities: { ...fakeStreaming.capabilities, usageStatus: "remote" },
    usageStatus: (probe) => {
      captured = probe;
      return Promise.resolve({ state: "unknown" as const });
    },
  };
  return { adapter, seen: () => captured as SystemProbe };
};

const askUsage = async (opts: Parameters<typeof create>[1]) => {
  const { adapter, seen } = probeCatcher();
  await create(adapter, opts).usageStatus();
  return seen();
};

test("no network option means no egress", async () => {
  expect((await askUsage({ probe: fakeSystemProbe() })).fetch).toBeUndefined();
});

test("network: true hands the adapter the platform fetch", async () => {
  const probe = await askUsage({ network: true, probe: fakeSystemProbe() });
  expect(probe.fetch).toBe(globalThis.fetch);
});

test("network can supply the caller's own fetch", async () => {
  const mine = () => Promise.resolve(ok({}));
  const probe = await askUsage({
    network: { fetch: mine },
    probe: fakeSystemProbe(),
  });
  expect(probe.fetch).toBe(mine);
});

// Injecting a fetch on the probe is itself an opt-in, so an unspecified
// `network` leaves it alone — that is how tests drive a remote adapter.
test("a probe's own fetch survives when network is unspecified", async () => {
  const mine = () => Promise.resolve(ok({}));
  const probe = await askUsage({ probe: fakeSystemProbe({ fetch: mine }) });
  expect(probe.fetch).toBe(mine);
});

test("network: false is a kill switch over a probe that carries one", async () => {
  const mine = () => Promise.resolve(ok({}));
  const probe = await askUsage({
    network: false,
    probe: fakeSystemProbe({ fetch: mine }),
  });
  expect(probe.fetch).toBeUndefined();
});
