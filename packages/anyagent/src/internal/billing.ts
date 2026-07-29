import type { BillingMode } from "../types.js";

/**
 * The harness-level {@link BillingMode} a BYOK credential store supports:
 * all-oauth entries are subscription-backed, all keys are metered, and a
 * mix asserts neither — per-model overrides are the precise channel there.
 */
export const credentialBilling = (
  oauthSeen: boolean,
  keySeen: boolean
): BillingMode => {
  if (oauthSeen && keySeen) {
    return "unknown";
  }
  if (oauthSeen) {
    return "subscription";
  }
  if (keySeen) {
    return "api-key";
  }
  return "unknown";
};
