import type { SystemProbe } from "../types.js";

/**
 * Upper bound on a response body. Every usage endpoint an adapter reads
 * answers with a small JSON document — a few kilobytes at most — so this is
 * generous by three orders of magnitude while still bounding the damage from
 * a misbehaving proxy or a hijacked host.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Default per-request budget. Usage discovery is never worth a long wait. */
export const DEFAULT_TIMEOUT_MS = 10_000;

const MAX_REDIRECTS = 5;

export interface JsonRequest {
  /** A request body, which makes the request a POST. */
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** A response that arrived and parsed. Non-2xx still reaches the caller. */
export interface JsonResponse {
  body: unknown;
  status: number;
}

const sameOrigin = (a: string, b: string): boolean => {
  try {
    const from = new URL(a);
    const to = new URL(b);
    return from.origin === to.origin;
  } catch {
    return false;
  }
};

// Read the stream with a hard cap. `Content-Length` is checked first when
// present, then the body is read in chunks, so a lying or absent length
// cannot get past the limit either.
const readCapped = async (response: Response): Promise<string | undefined> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: a stream is read one chunk at a time; that sequencing is the point, since it is what keeps the cap ahead of the allocation.
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(joined);
};

/**
 * Read a JSON document through the caller's own `fetch` — a GET, or a POST
 * when {@link JsonRequest.body} is set.
 *
 * Every rail this puts up exists because the request carries a credential
 * the CLI stored for its vendor:
 *
 * - Redirects are followed manually and **only within one origin**. The
 *   platform strips `Authorization` on a cross-origin hop but not the
 *   vendor-specific header names these endpoints use (`x-api-key`,
 *   `Cookie`), so a redirect off-origin ends the exchange instead.
 * - The body is size-capped ({@link MAX_BODY_BYTES}) and the request is
 *   time-capped ({@link DEFAULT_TIMEOUT_MS}).
 *
 * Resolves `undefined` for every failure — no network, timeout, cap
 * exceeded, unparseable body. Usage discovery degrades to
 * `{ state: "unknown" }`; it never turns a flaky endpoint into a throw the
 * caller has to catch. A non-2xx status that *did* arrive is returned, since
 * `401` ("signed out") is an answer and a transport failure is not.
 */
export const fetchJson = async (
  fetchImpl: NonNullable<SystemProbe["fetch"]>,
  url: string,
  req: JsonRequest = {}
): Promise<JsonResponse | undefined> => {
  let target = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: a redirect chain is sequential by definition — each hop's target is only known once the previous response has arrived.
      const response = await fetchImpl(target, {
        ...(req.body === undefined
          ? {}
          : { body: req.body, method: "POST" as const }),
        headers: req.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, target).toString();
        if (!sameOrigin(target, next)) {
          return;
        }
        target = next;
        continue;
      }
      const text = await readCapped(response);
      if (text === undefined) {
        return;
      }
      return {
        body: text === "" ? undefined : JSON.parse(text),
        status: response.status,
      };
    }
  } catch {
    // Transport failure, timeout, or a body that is not JSON. All of them
    // mean the same thing to a caller: no answer from here.
  }
};
