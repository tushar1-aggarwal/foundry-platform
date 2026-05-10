/**
 * Origin verification for cookie-authed state-changing requests.
 *
 * SameSite=Lax already blocks cross-site cookie attach on every modern
 * browser, but (a) older browsers don't honor it, (b) the SameSite default
 * for top-level POST navigation has changed multiple times across vendors,
 * and (c) attackers don't pick the SameSite-honoring browser. Belt-and-
 * braces: the server enforces an explicit `Origin` allowlist on every
 * cookie-authed state-changing request.
 *
 * Scope:
 *   - State-changing methods: POST, PUT, PATCH, DELETE
 *   - WebSocket upgrades
 *   - Cookie path is in play (Bearer-only requests skip this entirely)
 *
 * Out of scope:
 *   - Cookie-authed GET / HEAD / OPTIONS (browser top-level navigation may
 *     omit Origin; SameSite=Lax already blocks the cookie attach there).
 *   - Bearer requests (no auto-attach by the browser; CSRF-immune).
 */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True when the HTTP method changes server state (per RFC 7231 + this PR's scope). */
export function isStateChanging(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase());
}

/** True when the request is a WebSocket upgrade. Case-insensitive `Upgrade:` match. */
export function isWebSocketUpgrade(req: Request): boolean {
  const upgrade = req.headers.get("upgrade");
  return upgrade != null && upgrade.toLowerCase() === "websocket";
}

/**
 * Verify the request's `Origin:` header is in the allowlist.
 *
 * Fails closed:
 *   - missing Origin header → false (browsers always attach Origin on the
 *     methods we gate; absence means non-browser, which should be using
 *     Bearer, OR a header-stripping proxy attack -- both 401)
 *   - empty `allowed` array → false (deployment must explicitly configure)
 *   - exact-string match only (`http://localhost:8420` vs `http://localhost:8421`
 *     differ; we don't normalize trailing slashes or strip ports)
 */
export function verifyOriginForCookieAuth(req: Request, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return false;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  return allowed.includes(origin);
}
