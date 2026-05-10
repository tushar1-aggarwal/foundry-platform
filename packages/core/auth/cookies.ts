/**
 * Cookie policy wrapper for the Phase 1 cookie-based login flow.
 *
 * Owns the *policy* (HttpOnly / Secure / SameSite / Max-Age / Path /
 * Domain). The `cookie` npm package owns the *syntax* (RFC-6265 grammar,
 * quoting, percent-encoding, duplicate handling).
 *
 * Two read paths:
 *
 *   - `getSessionCookie(req, name)` -- for auth-bearing cookies
 *     (the session cookie AND the OAuth state cookie). Fails closed on
 *     duplicate occurrences of the same name in the Cookie header. The
 *     `cookie.parse()` default silently collapses duplicates (last wins),
 *     which would let an attacker overwrite the session via a sibling
 *     subdomain or XSS injection. We pre-scan the raw header before
 *     parsing.
 *
 *   - `getCookie(req, name)` -- for non-auth cookies (theme, locale,
 *     analytics, etc.). Uses `cookie.parse()` default behavior. Generic
 *     ambiguity is not worth the false-positive cost for cosmetic
 *     cookies.
 *
 * Two write paths:
 *
 *   - `setSessionCookie({ name, value, maxAgeSec, domain, secure })`
 *     -- builds a Set-Cookie header value with HttpOnly + Secure (per
 *     config) + SameSite=Lax + Path=/. Use for all auth cookies.
 *
 *   - `clearSessionCookie({ name, domain })` -- builds a Set-Cookie
 *     header value with Max-Age=0 to delete the cookie.
 */

import { parse, serialize } from "cookie";
import { logDebug } from "../observability/structured-log.js";

/**
 * Read an auth cookie (session OR OAuth state) from a request. Fails
 * closed when the cookie name appears more than once in the `Cookie:`
 * header.
 *
 * Cookie-tossing attack: a sibling subdomain or XSS-injected duplicate
 * cookie can swap the session out from under the user. `cookie.parse()`
 * silently collapses duplicates (last wins) which would give the
 * attacker control of the value the server reads. We scan the raw
 * header for occurrences of the named cookie BEFORE parsing; if the
 * count is > 1, we return null and force the user to re-authenticate.
 *
 * Browser order of cookies in the header is implementation-defined, so
 * we cannot rely on "first wins" or "last wins" being consistent. The
 * only safe response to ambiguity is rejection.
 */
export function getSessionCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;

  const occurrences = countCookieOccurrences(header, name);
  if (occurrences > 1) {
    // Don't log the cookie value itself (it IS the bearer credential).
    logDebug("auth", `duplicate '${name}' cookie in Cookie header (count=${occurrences}) -- rejecting`);
    return null;
  }
  if (occurrences === 0) return null;

  // Single occurrence -- safe to parse normally.
  const parsed = parse(header);
  return parsed[name] ?? null;
}

/**
 * Read a NON-auth cookie. Uses `cookie.parse()` default behaviour
 * (silent duplicate collapse, last-occurrence wins). Suitable for
 * theme / locale / analytics cookies where ambiguity is cosmetic.
 *
 * NEVER use this for the session or OAuth state cookies -- it
 * bypasses the duplicate-fail-closed protection. Call
 * `getSessionCookie` for those.
 */
export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const parsed = parse(header);
  return parsed[name] ?? null;
}

export interface SetSessionCookieOptions {
  name: string;
  value: string;
  /** Cookie Max-Age in seconds. The browser deletes the cookie after this. */
  maxAgeSec: number;
  /** Cookie Domain attribute. `null` produces a host-only cookie. */
  domain?: string | null;
  /** Cookie Secure attribute. Browser only sends Secure cookies over HTTPS. */
  secure: boolean;
}

/**
 * Build a hardened Set-Cookie header value for an auth cookie. Always
 * sets:
 *   - HttpOnly  (JavaScript cannot read it -- defends against XSS exfil)
 *   - SameSite=Lax  (cookie not sent on cross-site POST forms)
 *   - Path=/  (cookie sent to all paths on the host)
 *
 * Caller-controlled:
 *   - `secure`  (production HTTPS = true; local HTTP dev = false)
 *   - `domain`  (null = host-only; ".paytm.com" = share across subdomains)
 *   - `maxAgeSec`  (cookie expiry)
 *
 * Centralizing these flags here means a route handler can't forget one
 * of them.
 */
export function setSessionCookie(opts: SetSessionCookieOptions): string {
  return serialize(opts.name, opts.value, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: "lax",
    path: "/",
    maxAge: opts.maxAgeSec,
    ...(opts.domain ? { domain: opts.domain } : {}),
  });
}

export interface ClearSessionCookieOptions {
  name: string;
  domain?: string | null;
}

/**
 * Build a Set-Cookie header value that deletes the cookie. The browser
 * removes any cookie with `Max-Age=0`. Domain must match the original
 * Set-Cookie's Domain so the browser scopes the delete correctly.
 */
export function clearSessionCookie(opts: ClearSessionCookieOptions): string {
  return serialize(opts.name, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    ...(opts.domain ? { domain: opts.domain } : {}),
  });
}

/**
 * Count occurrences of `name=` in the raw Cookie header. Cookie syntax
 * is `name=value; name=value; ...` -- pairs separated by `; ` or `;`.
 * We split on `;`, trim, and count entries whose name (the part before
 * the first `=`) exactly matches.
 *
 * Exact match avoids prefix collisions (e.g., `ark_session=A;
 * ark_session_legacy=B` doesn't count as a duplicate of `ark_session`).
 */
function countCookieOccurrences(header: string, name: string): number {
  let count = 0;
  for (const segment of header.split(";")) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const cookieName = trimmed.slice(0, eqIdx);
    if (cookieName === name) count++;
  }
  return count;
}
