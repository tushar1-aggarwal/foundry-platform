/**
 * Google ID token verification for the Phase 1 cookie-based login flow.
 *
 * Wraps `jose` to verify a Google-issued ID token end-to-end. Validates:
 *   - RS256 signature against Google's published JWKS (rotates regularly;
 *     `createRemoteJWKSet` handles fetch + cache + rotation transparently)
 *   - `iss` is one of Google's two accepted issuer strings
 *   - `aud` matches our registered Google OAuth client id
 *   - `hd` (Google hosted-domain claim) is one of `config.allowedDomains`
 *     (typically the Paytm Workspace domains: paytm.com, paytmpayments.com,
 *     paytmmoney.com, ...) -- prevents non-Paytm Google accounts from
 *     completing login. Different tenants live under different domains, so
 *     a single value would lock out PPSL / PML users.
 *   - `email_verified === true`
 *   - `exp` not past (enforced by `jose` defaults)
 *   - `iat` within the last 1h (enforced via `maxTokenAge: "1h"`; matches
 *     Google's own ID-token lifetime so legit tokens are unaffected)
 *
 * Returns the verified principal claims on success, or `null` on any
 * verification failure. Failure reasons are logged but never surfaced to
 * the caller -- the login handler should treat all failures as a
 * generic 401 and not leak which check failed.
 *
 * `jose` design notes:
 *   - `createRemoteJWKSet(url)` returns a key resolver that fetches the
 *     JWKS lazily on first verify call, then caches with TTL. We instantiate
 *     it once per `clientId` (because the JWKS URL is shared across audiences,
 *     a single instance per process would also be fine; per-clientId is just
 *     a defensive bound).
 *   - The library defaults are conservative: rejects `alg=none`, requires
 *     RS256/ES256/etc, and verifies all required claims by default.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { logDebug } from "../observability/structured-log.js";

/** Google's two accepted issuer strings. The library accepts either. */
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** Google's JWKS endpoint. Stable URL; keys rotate behind it. */
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export interface GoogleVerifyConfig {
  /** OAuth client id registered with Google. The token's `aud` must equal this. */
  clientId: string;
  /**
   * Allow-list of Google hosted-domain (`hd`) claim values. The token's
   * `hd` must equal one of these. Empty list rejects every login.
   * Paytm has multiple Workspace domains (paytm.com / paytmpayments.com /
   * paytmmoney.com), one per business entity, so a single domain wouldn't
   * cover all tenants.
   */
  allowedDomains: string[];
}

export interface GoogleIdentity {
  /** Google's stable subject id for this account. Use for `users.google_sub`. */
  sub: string;
  /** Verified primary email. Use as the join key into `users.email`. */
  email: string;
  /** Display name from the token. May be missing on some accounts. */
  name: string | null;
}

// Cache JWKS resolvers per clientId so the same process reuses one instance.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(clientId: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(clientId);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
    jwksCache.set(clientId, jwks);
  }
  return jwks;
}

/**
 * Verify a Google ID token. Returns the verified principal on success,
 * or `null` if verification fails for any reason. Reasons are logged at
 * debug level for diagnosis but not returned -- callers should respond
 * 401 without distinguishing failure modes.
 */
export async function verifyGoogleIdToken(token: string, config: GoogleVerifyConfig): Promise<GoogleIdentity | null> {
  if (!token || !config.clientId) return null;

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, getJwks(config.clientId), {
      issuer: GOOGLE_ISSUERS,
      audience: config.clientId,
      // jose enforces exp / nbf by default; algorithm allow-list prevents
      // alg-confusion attacks. `maxTokenAge: "1h"` makes jose actually
      // enforce `iat` -- tokens older than 1h since issuance are rejected
      // even if they haven't hit `exp` yet. Google ID tokens are 1h-lived
      // by design, so legit tokens are unaffected.
      algorithms: ["RS256"],
      maxTokenAge: "1h",
    });
    payload = result.payload;
  } catch (e) {
    logDebug("auth", `google id token signature/claims rejected: ${(e as Error).message}`);
    return null;
  }

  // Application-level claim checks beyond what jose enforces.
  const hd = (payload as Record<string, unknown>).hd;
  if (typeof hd !== "string" || !config.allowedDomains.includes(hd)) {
    logDebug(
      "auth",
      `google id token hd mismatch: got ${String(hd)}, expected one of [${config.allowedDomains.join(", ")}]`,
    );
    return null;
  }

  const emailVerified = (payload as Record<string, unknown>).email_verified;
  if (emailVerified !== true) {
    logDebug("auth", "google id token email_verified !== true");
    return null;
  }

  const email = (payload as Record<string, unknown>).email;
  const sub = payload.sub;
  if (typeof email !== "string" || !email || typeof sub !== "string" || !sub) {
    logDebug("auth", "google id token missing required email or sub");
    return null;
  }

  const name = (payload as Record<string, unknown>).name;
  return {
    sub,
    email,
    name: typeof name === "string" && name.length > 0 ? name : null,
  };
}

/**
 * Test seam: clear the JWKS cache. Tests that swap the verifier for a fake
 * one don't need this, but if a test ever exercises the real verifier with
 * stubbed Google endpoints it lets the next test start fresh.
 */
export function _resetJwksCacheForTesting(): void {
  jwksCache.clear();
}
