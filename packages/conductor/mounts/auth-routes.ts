/**
 * Phase 1 Google OIDC HTTP routes:
 *   - GET  /auth/google/start    -- redirect user to Google OAuth
 *   - GET  /auth/google/callback -- Google bounces back; exchange code, mint cookie
 *   - POST /auth/logout          -- delete session row + clear cookie
 *
 * All three sit on the merged conductor port (default 19400). They run
 * BEFORE the WebSocket upgrade catch-all in `conductor/index.ts`.
 */

import type { AppContext } from "../../core/app.js";
import {
  generateState,
  validateState,
  getSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  LoginError,
} from "../../core/auth/index.js";
import { verifyOriginForCookieAuth } from "../../core/auth/origin.js";
import { logDebug, logError } from "../../core/observability/structured-log.js";

const STATE_COOKIE_NAME = "ark_oauth_state";
const STATE_COOKIE_MAX_AGE_SEC = 600; // 10 minutes

/**
 * GET /auth/google/start
 *
 * Generates an OAuth state token, sets `ark_oauth_state` cookie, builds
 * the Google OAuth URL, redirects the browser there.
 *
 * The `hd` URL parameter is passed only when exactly one Google domain
 * is configured (single-domain UX hint). With multiple domains, we omit
 * it -- Google's docs don't specify comma-list semantics, and `hd`
 * isn't security anyway (real `hd` enforcement happens in
 * `verifyGoogleIdToken` against the verified token claim).
 *
 * Not-configured behavior: this is a top-level browser navigation
 * (`window.location.assign(...)`) by design. Returning a 503 JSON body
 * would dump the user on a raw JSON page with no return path. Instead
 * we 302 back to the dashboard with an `?error=google_not_configured`
 * hint that LoginPage parses and surfaces as an inline banner.
 *
 * Account picker: by default we omit the `prompt` param so Google uses
 * its own heuristics (typically "skip the picker if you've recently
 * selected an account for this client"). Pass `?force=1` to add
 * `prompt=select_account` and force Google to show the picker -- used
 * by LoginPage's "Use a different account" link so single-account users
 * still get the fast path while multi-account users have an explicit
 * switcher.
 */
export function handleAuthGoogleStart(app: AppContext, req: Request): Response {
  const cfg = app.config.authSection;
  if (!cfg.google.clientId || !cfg.google.redirectUri) {
    logDebug("auth", "auth/google/start: clientId or redirectUri not configured");
    return new Response(null, {
      status: 302,
      headers: { Location: "/#login?error=google_not_configured" },
    });
  }

  const url = new URL(req.url);
  const forceAccountPicker = url.searchParams.get("force") === "1";

  const state = generateState();
  const params = new URLSearchParams({
    client_id: cfg.google.clientId,
    redirect_uri: cfg.google.redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state,
  });
  if (cfg.google.allowedDomains.length === 1) {
    // UX hint only: pre-fill the Workspace domain in Google's account picker.
    // Real enforcement is in verifyGoogleIdToken against the token's hd claim.
    params.set("hd", cfg.google.allowedDomains[0]);
  }
  if (forceAccountPicker) {
    params.set("prompt", "select_account");
  }
  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  const headers = new Headers({ Location: googleAuthUrl });
  headers.append(
    "Set-Cookie",
    setSessionCookie({
      name: STATE_COOKIE_NAME,
      value: state,
      maxAgeSec: STATE_COOKIE_MAX_AGE_SEC,
      domain: cfg.session.cookieDomain,
      secure: cfg.session.cookieSecure,
    }),
  );
  return new Response(null, { status: 302, headers });
}

/**
 * GET /auth/google/callback
 *
 * Validates the state cookie against the `state=` query param, exchanges
 * the `code=` for an ID token, calls `loginManager.completeOAuthLogin`,
 * sets the session cookie, redirects to `/`.
 */
export async function handleAuthGoogleCallback(app: AppContext, req: Request): Promise<Response> {
  const cfg = app.config.authSection;
  if (!cfg.google.clientId || !cfg.google.clientSecret || !cfg.google.redirectUri) {
    // Misconfiguration is an operator problem, not a probe-friendly oracle.
    // Returning 503 with a literal "google login not configured" body told
    // an attacker which env vars are missing on this deployment. Log loudly
    // server-side and respond with the same opaque 401 every other failure
    // path uses.
    logError(
      "auth",
      `auth/google/callback: misconfigured (clientId=${!!cfg.google.clientId}, clientSecret=${!!cfg.google.clientSecret}, redirectUri=${!!cfg.google.redirectUri})`,
    );
    return respondAuthFailure(cfg.session.cookieDomain, "config_missing");
  }

  const url = new URL(req.url);
  const presentedState = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    logError("auth", `auth/google/callback: google returned error '${oauthError}'`);
    return respondAuthFailure(cfg.session.cookieDomain, "oauth_error");
  }
  if (!presentedState || !code) {
    return respondAuthFailure(cfg.session.cookieDomain, "missing_params");
  }

  // Validate state cookie -- fail closed on duplicates per the
  // getSessionCookie contract.
  const expectedState = getSessionCookie(req, STATE_COOKIE_NAME);
  if (!validateState(presentedState, expectedState)) {
    logError("auth", "auth/google/callback: state mismatch");
    return respondAuthFailure(cfg.session.cookieDomain, "state_mismatch");
  }

  // Server-to-server token exchange. We use plain fetch -- standard
  // OAuth flow, no exotic options.
  let idToken: string | null = null;
  try {
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: cfg.google.clientId,
        client_secret: cfg.google.clientSecret,
        redirect_uri: cfg.google.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!tokenResp.ok) {
      logError("auth", `auth/google/callback: token exchange failed (${tokenResp.status})`);
      return respondAuthFailure(cfg.session.cookieDomain, "token_exchange_failed");
    }
    const body = (await tokenResp.json()) as { id_token?: string };
    idToken = body.id_token ?? null;
  } catch (e) {
    logError("auth", `auth/google/callback: token exchange threw ${(e as Error).message}`);
    return respondAuthFailure(cfg.session.cookieDomain, "token_exchange_threw");
  }
  if (!idToken) {
    return respondAuthFailure(cfg.session.cookieDomain, "no_id_token");
  }

  // Hand off to LoginManager. Any failure -> 401.
  let cookieValue: string;
  try {
    const result = await app.loginManager.completeOAuthLogin(idToken, {
      userAgent: req.headers.get("user-agent"),
      ip: req.headers.get("x-forwarded-for") ?? null,
    });
    cookieValue = result.cookieValue;
  } catch (e) {
    if (e instanceof LoginError) {
      logError("auth", `auth/google/callback: LoginError(${e.kind})`);
    } else {
      logError("auth", `auth/google/callback: unexpected error ${(e as Error).message}`);
    }
    return respondAuthFailure(cfg.session.cookieDomain, "login_failed");
  }

  // Success: set session cookie, clear state cookie, redirect to dashboard.
  // The dashboard URL is configurable so local dev (Vite on :5173) and prod
  // (dashboard SPA colocated with daemon at /) both work without code edits.
  // TODO: support a `?next=` return-to URL on top of this so deep-links
  // survive the login bounce.
  const headers = new Headers({ Location: cfg.session.dashboardUrl });
  headers.append(
    "Set-Cookie",
    setSessionCookie({
      name: cfg.session.cookieName,
      value: cookieValue,
      maxAgeSec: cfg.session.ttlSec,
      domain: cfg.session.cookieDomain,
      secure: cfg.session.cookieSecure,
    }),
  );
  headers.append("Set-Cookie", clearSessionCookie({ name: STATE_COOKIE_NAME, domain: cfg.session.cookieDomain }));
  return new Response(null, { status: 302, headers });
}

/**
 * POST /auth/logout
 *
 * Reads the session cookie via `getSessionCookie` (fail-closed on
 * duplicate), deletes the matching session row, clears the cookie.
 * Idempotent -- a missing or expired session still returns 200.
 *
 * Origin enforcement: cookie-authed POST is in scope for the
 * `allowedOrigins` allowlist. A cross-site `<form action>` POST to
 * /auth/logout would otherwise let `evil.com` log the user out.
 * Mismatch / missing Origin -> 401, cookie cleared (defense against
 * cookie-pinned variants).
 */
export async function handleAuthLogout(app: AppContext, req: Request): Promise<Response> {
  const cfg = app.config.authSection;

  if (!verifyOriginForCookieAuth(req, cfg.session.allowedOrigins)) {
    logDebug("auth", `auth/logout: origin check failed (origin=${req.headers.get("origin") ?? "<none>"})`);
    return respondInvalidOrigin(cfg.session.cookieName, cfg.session.cookieDomain);
  }

  const cookieValue = getSessionCookie(req, cfg.session.cookieName);
  if (cookieValue) {
    await app.loginManager.logout(cookieValue);
  }

  const headers = new Headers();
  headers.append("Set-Cookie", clearSessionCookie({ name: cfg.session.cookieName, domain: cfg.session.cookieDomain }));
  return new Response(null, { status: 200, headers });
}

/**
 * Respond to a callback failure: 401, clear the state cookie. The `reason`
 * is logged server-side via `logDebug("auth", ...)` so ops can correlate
 * incidents, but is NOT echoed in the response body -- a helpful error
 * message ("invalid hd" vs "expired token" vs "state_mismatch") would be
 * a fingerprinting oracle for an attacker probing the OAuth surface.
 */
function respondAuthFailure(cookieDomain: string | null, reason: string): Response {
  logDebug("auth", `auth/google/callback failure: ${reason}`);
  const headers = new Headers();
  headers.append("Set-Cookie", clearSessionCookie({ name: STATE_COOKIE_NAME, domain: cookieDomain }));
  return Response.json({ error: "authentication failed" }, { status: 401, headers });
}

/**
 * Respond to an Origin-allowlist failure on a cookie-authed state-changing
 * request: 401, clear the session cookie. Same opacity rules as
 * `respondAuthFailure` -- no `reason` in the body.
 */
function respondInvalidOrigin(cookieName: string, cookieDomain: string | null): Response {
  const headers = new Headers();
  headers.append("Set-Cookie", clearSessionCookie({ name: cookieName, domain: cookieDomain }));
  return Response.json({ error: "invalid origin" }, { status: 401, headers });
}
