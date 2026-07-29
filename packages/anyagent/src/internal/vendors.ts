// Canonical model-vendor resolution for `provider/model`-shaped ids. The
// contract on {@link ModelInfo.provider}: the vendor (the pricing/benchmark
// join key), never the gateway or biller the id happens to route through —
// `kilo/~anthropic/claude-…` is anthropic's model billed by kilo, and only
// the vendor belongs on the field. Absent beats guessed: an id this table
// can't place stays vendor-less.

/** The canonical vendor slugs assertable from an id's leading segment. */
const VENDORS = new Set([
  "anthropic",
  "openai",
  "google",
  "meta",
  "mistral",
  "deepseek",
  "xai",
  "groq",
  "qwen",
  "z-ai",
]);

// Gateways whose segment names a biller, not a vendor: resolution recurses
// into the rest of the id (`openrouter/openai/gpt-4o` → openai; kilo's
// `~vendor` convention marks the vendor inside its gateway ids).
const GATEWAYS = new Set(["openrouter", "opencode", "kilo"]);

/**
 * The canonical vendor slug for a `provider/model`-shaped id, or
 * `undefined` when none can be asserted. Never returns a gateway name.
 */
export const vendorOf = (id: string): string | undefined => {
  const [head, ...rest] = id.split("/");
  if (head === undefined || rest.length === 0) {
    return;
  }
  const segment = head.startsWith("~") ? head.slice(1) : head;
  if (VENDORS.has(segment)) {
    return segment;
  }
  if (GATEWAYS.has(segment)) {
    return vendorOf(rest.join("/"));
  }
};
