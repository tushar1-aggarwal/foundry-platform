/**
 * OAuth state-token utilities for the Phase 1 cookie-based login flow.
 *
 * The state token is the CSRF defense for the `/auth/google/callback`
 * route: when `/auth/google/start` redirects the user to Google, it
 * also sets an `ark_oauth_state` cookie with a freshly-generated random
 * token AND passes the same token in the OAuth `state=` query
 * parameter. When Google bounces back to `/auth/google/callback`, we
 * read both and compare constant-time. A mismatch (or absence) means
 * the request didn't originate from our own start route -- reject.
 *
 * Constant-time compare via `crypto.timingSafeEqual` to defeat timing
 * oracles (an attacker watching response timing can otherwise infer
 * one byte at a time). Length mismatches are handled defensively:
 * `timingSafeEqual` throws if the two buffers have different lengths;
 * we catch that and return false rather than letting the comparison
 * itself leak whether the lengths matched.
 */

import { randomBytes, timingSafeEqual } from "crypto";

/**
 * Generate a fresh random state token. 32 bytes of entropy, hex-encoded
 * (64 chars). Hex is URL-safe and reversible without escaping. The
 * value is opaque to the caller; we only use it for round-trip
 * comparison.
 */
export function generateState(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Compare two state tokens in constant time. Returns false on any
 * mismatch including length mismatch. Empty / missing tokens always
 * fail.
 */
export function validateState(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (!presented || !expected) return false;
  if (presented.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    // timingSafeEqual throws on length mismatch -- the explicit length
    // check above should prevent that, but the catch is a defense in
    // depth in case Buffer.from returns unexpected widths for non-ASCII.
    return false;
  }
}
