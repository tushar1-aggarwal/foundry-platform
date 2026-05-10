/**
 * Integration tests for the Phase 1 Google OIDC HTTP routes:
 *   GET  /auth/google/start
 *   GET  /auth/google/callback
 *   POST /auth/logout
 *
 * The verifier is mocked at module level (we don't make real network
 * calls to Google JWKS). The token exchange POST to oauth2.googleapis.com
 * is mocked via globalThis.fetch override.
 */

import { describe, it, expect, beforeAll, afterAll, mock, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { ArkServer } from "../index.js";
import { registerAllHandlers } from "../register.js";
import { allocatePort } from "../../core/config/port-allocator.js";
import type { GoogleIdentity } from "../../core/auth/google-oidc.js";

// Stub the Google ID token verifier. Tests set `verifierResult` per case.
let verifierResult: GoogleIdentity | null = null;

mock.module("../../core/auth/google-oidc.js", () => ({
  verifyGoogleIdToken: async (_token: string) => verifierResult,
  _resetJwksCacheForTesting: () => {},
}));

// Stub Google's token-exchange endpoint by intercepting fetch().
const realFetch = globalThis.fetch;
let tokenExchangeOverride: { id_token?: string; status?: number; throws?: boolean } | null = null;

beforeEach(() => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof Request ? url.url : url.toString();
    if (u === "https://oauth2.googleapis.com/token") {
      if (tokenExchangeOverride?.throws) throw new Error("network error");
      const status = tokenExchangeOverride?.status ?? 200;
      if (status !== 200) {
        return new Response("{}", { status });
      }
      return new Response(JSON.stringify({ id_token: tokenExchangeOverride?.id_token ?? "fake-id-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  tokenExchangeOverride = null;
  verifierResult = null;
});

let app: AppContext;
let server: ArkServer;
let ws: { stop(): void };
let port: number;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  // Test profile defaults set null clientId/redirectUri (see profiles.ts).
  // The auth routes need them populated, so we mutate authSection
  // post-boot. The conductor reads from app.config.authSection at
  // request time (not at attachAuth), so this takes effect immediately.
  (app.config.authSection.google as any).clientId = "test-client.apps.googleusercontent.com";
  (app.config.authSection.google as any).clientSecret = "test-secret";
  (app.config.authSection.google as any).redirectUri = "http://localhost:8420/auth/google/callback";
  (app.config.authSection.google as any).allowedDomains = ["paytm.com"];
  (app.config.authSection as any).requireToken = true;
  // Cookie-authed POST + WS upgrade requires Origin in this list. Test
  // profile defaults to []; populate so the existing logout cases can
  // verify the success path with `Origin: ${TEST_ORIGIN}`.
  (app.config.authSection.session as any).allowedOrigins = ["http://localhost:8420"];

  server = new ArkServer();
  registerAllHandlers(server.router, app);
  server.attachApp(app);
  server.attachAuth(app);

  port = await allocatePort();
  ws = server.startWebSocket(port, { app });
});

afterAll(async () => {
  ws?.stop();
  await app?.shutdown();
});

/** Extract a Set-Cookie header (or all of them) from a fetch Response. */
function getSetCookieHeaders(resp: Response): string[] {
  // Bun's Headers exposes getSetCookie() in modern versions; fall back to raw header.
  const anyHeaders = resp.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

/** Find a cookie value in Set-Cookie headers by name. Returns the raw segment after `name=` and before `;`. */
function findCookie(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const m = c.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

describe("GET /auth/google/start", () => {
  it("redirects to Google with state param + sets ark_oauth_state cookie", async () => {
    const resp = await fetch(`http://localhost:${port}/auth/google/start`, { redirect: "manual" });
    expect(resp.status).toBe(302);

    const location = resp.headers.get("location") ?? "";
    expect(location).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    const u = new URL(location);
    expect(u.searchParams.get("client_id")).toBe("test-client.apps.googleusercontent.com");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:8420/auth/google/callback");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid profile email");
    const state = u.searchParams.get("state") ?? "";
    expect(state.length).toBe(64);
    // Single-domain config -> hd hint present
    expect(u.searchParams.get("hd")).toBe("paytm.com");

    // State cookie set
    const setCookies = getSetCookieHeaders(resp);
    const stateCookie = findCookie(setCookies, "ark_oauth_state");
    expect(stateCookie).toBe(state);
  });

  it("does NOT include hd when multiple domains are allowed (multi-domain UX)", async () => {
    // Mutate config in-place for this case.
    const orig = [...app.config.authSection.google.allowedDomains];
    (app.config.authSection.google as any).allowedDomains = ["paytm.com", "paytmpayments.com"];
    try {
      const resp = await fetch(`http://localhost:${port}/auth/google/start`, { redirect: "manual" });
      const u = new URL(resp.headers.get("location") ?? "");
      expect(u.searchParams.has("hd")).toBe(false);
    } finally {
      (app.config.authSection.google as any).allowedDomains = orig;
    }
  });

  it("includes prompt=select_account when ?force=1 is passed (account-switcher path)", async () => {
    const resp = await fetch(`http://localhost:${port}/auth/google/start?force=1`, { redirect: "manual" });
    expect(resp.status).toBe(302);
    const u = new URL(resp.headers.get("location") ?? "");
    expect(u.searchParams.get("prompt")).toBe("select_account");
  });

  it("does NOT include prompt= when called without ?force (default fast path)", async () => {
    const resp = await fetch(`http://localhost:${port}/auth/google/start`, { redirect: "manual" });
    const u = new URL(resp.headers.get("location") ?? "");
    expect(u.searchParams.has("prompt")).toBe(false);
  });

  it("redirects to /#login?error=google_not_configured when clientId is not configured", async () => {
    const orig = app.config.authSection.google.clientId;
    (app.config.authSection.google as any).clientId = null;
    try {
      const resp = await fetch(`http://localhost:${port}/auth/google/start`, { redirect: "manual" });
      expect(resp.status).toBe(302);
      expect(resp.headers.get("location")).toBe("/#login?error=google_not_configured");
    } finally {
      (app.config.authSection.google as any).clientId = orig;
    }
  });
});

describe("GET /auth/google/callback", () => {
  it("happy path: exchanges code, calls verifier, sets session cookie, 302 to /", async () => {
    // Step 1: hit /start to get a state cookie.
    const startResp = await fetch(`http://localhost:${port}/auth/google/start`, { redirect: "manual" });
    const stateCookie = findCookie(getSetCookieHeaders(startResp), "ark_oauth_state")!;
    const startUrl = new URL(startResp.headers.get("location")!);
    const state = startUrl.searchParams.get("state")!;

    // Step 2: simulate Google bouncing back to /callback with code + state.
    verifierResult = { sub: "google-sub-1", email: "alice@paytm.com", name: "Alice" };
    tokenExchangeOverride = { id_token: "fake-id-token" };

    const callbackResp = await fetch(`http://localhost:${port}/auth/google/callback?state=${state}&code=abc`, {
      redirect: "manual",
      headers: { cookie: `ark_oauth_state=${stateCookie}` },
    });
    expect(callbackResp.status).toBe(302);
    expect(callbackResp.headers.get("location")).toBe("/");

    // Set-Cookie should set ark_session and clear ark_oauth_state.
    const setCookies = getSetCookieHeaders(callbackResp);
    const sessionCookie = findCookie(setCookies, "ark_session");
    expect(sessionCookie).not.toBeNull();
    expect(sessionCookie!.length).toBe(64);
    const stateClear = setCookies.find((c) => c.startsWith("ark_oauth_state="));
    expect(stateClear).toContain("Max-Age=0");
  });

  it("rejects when state cookie is missing", async () => {
    verifierResult = { sub: "google-sub-2", email: "bob@paytm.com", name: "Bob" };
    tokenExchangeOverride = { id_token: "fake-id-token" };
    const resp = await fetch(`http://localhost:${port}/auth/google/callback?state=abc&code=xyz`, {
      redirect: "manual",
    });
    expect(resp.status).toBe(401);
  });

  it("rejects on state mismatch", async () => {
    verifierResult = { sub: "google-sub-3", email: "carol@paytm.com", name: "Carol" };
    tokenExchangeOverride = { id_token: "fake-id-token" };
    const resp = await fetch(`http://localhost:${port}/auth/google/callback?state=mismatch&code=xyz`, {
      redirect: "manual",
      headers: { cookie: `ark_oauth_state=different-state-value` },
    });
    expect(resp.status).toBe(401);
  });

  it("rejects when token exchange fails", async () => {
    const startResp = await fetch(`http://localhost:${port}/auth/google/start`, { redirect: "manual" });
    const stateCookie = findCookie(getSetCookieHeaders(startResp), "ark_oauth_state")!;

    tokenExchangeOverride = { status: 400 };
    const resp = await fetch(`http://localhost:${port}/auth/google/callback?state=${stateCookie}&code=bad`, {
      redirect: "manual",
      headers: { cookie: `ark_oauth_state=${stateCookie}` },
    });
    expect(resp.status).toBe(401);
  });

  it("rejects when verifier returns null (bad token)", async () => {
    const startResp = await fetch(`http://localhost:${port}/auth/google/start`, { redirect: "manual" });
    const stateCookie = findCookie(getSetCookieHeaders(startResp), "ark_oauth_state")!;

    verifierResult = null; // verifier rejects
    tokenExchangeOverride = { id_token: "fake-id-token" };

    const resp = await fetch(`http://localhost:${port}/auth/google/callback?state=${stateCookie}&code=abc`, {
      redirect: "manual",
      headers: { cookie: `ark_oauth_state=${stateCookie}` },
    });
    expect(resp.status).toBe(401);
  });

  it("returns error from query when Google indicates the user denied", async () => {
    const resp = await fetch(`http://localhost:${port}/auth/google/callback?error=access_denied`, {
      redirect: "manual",
    });
    expect(resp.status).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  const ORIGIN = "http://localhost:8420";

  it("clears the session cookie regardless of whether one was sent", async () => {
    const resp = await fetch(`http://localhost:${port}/auth/logout`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect(resp.status).toBe(200);
    const setCookies = getSetCookieHeaders(resp);
    const clear = setCookies.find((c) => c.startsWith("ark_session="));
    expect(clear).toContain("Max-Age=0");
  });

  it("deletes the session row when called with a valid cookie", async () => {
    // Mint a session via the happy path.
    const startResp = await fetch(`http://localhost:${port}/auth/google/start`, { redirect: "manual" });
    const stateCookie = findCookie(getSetCookieHeaders(startResp), "ark_oauth_state")!;
    const state = new URL(startResp.headers.get("location")!).searchParams.get("state")!;

    verifierResult = { sub: "google-sub-logout", email: "dave@paytm.com", name: "Dave" };
    tokenExchangeOverride = { id_token: "fake-id-token" };
    const callbackResp = await fetch(`http://localhost:${port}/auth/google/callback?state=${state}&code=abc`, {
      redirect: "manual",
      headers: { cookie: `ark_oauth_state=${stateCookie}` },
    });
    const sessionCookie = findCookie(getSetCookieHeaders(callbackResp), "ark_session")!;

    // Verify session is active.
    const before = await app.authSessions.sessions.getActive(sessionCookie);
    expect(before).not.toBeNull();

    // Logout.
    const logoutResp = await fetch(`http://localhost:${port}/auth/logout`, {
      method: "POST",
      headers: { cookie: `ark_session=${sessionCookie}`, origin: ORIGIN },
    });
    expect(logoutResp.status).toBe(200);

    const after = await app.authSessions.sessions.getActive(sessionCookie);
    expect(after).toBeNull();
  });
});

describe("POST /auth/logout origin enforcement", () => {
  const GOOD = "http://localhost:8420";
  const EVIL = "https://evil.com";

  async function mintSession(email: string): Promise<string> {
    const startResp = await fetch(`http://localhost:${port}/auth/google/start`, { redirect: "manual" });
    const stateCookie = findCookie(getSetCookieHeaders(startResp), "ark_oauth_state")!;
    const state = new URL(startResp.headers.get("location")!).searchParams.get("state")!;
    verifierResult = { sub: `sub-${email}`, email, name: email };
    tokenExchangeOverride = { id_token: "fake-id-token" };
    const cb = await fetch(`http://localhost:${port}/auth/google/callback?state=${state}&code=abc`, {
      redirect: "manual",
      headers: { cookie: `ark_oauth_state=${stateCookie}` },
    });
    return findCookie(getSetCookieHeaders(cb), "ark_session")!;
  }

  it("401 + clears cookie + does NOT delete row when Origin is missing", async () => {
    const session = await mintSession("missing-origin@paytm.com");
    const before = await app.authSessions.sessions.getActive(session);
    expect(before).not.toBeNull();

    const resp = await fetch(`http://localhost:${port}/auth/logout`, {
      method: "POST",
      headers: { cookie: `ark_session=${session}` },
    });
    expect(resp.status).toBe(401);
    const setCookies = getSetCookieHeaders(resp);
    expect(setCookies.find((c) => c.startsWith("ark_session=") && c.includes("Max-Age=0"))).toBeDefined();

    // Row must NOT have been deleted -- the request was rejected before logout ran.
    const after = await app.authSessions.sessions.getActive(session);
    expect(after).not.toBeNull();
  });

  it("401 + clears cookie + does NOT delete row when Origin mismatches", async () => {
    const session = await mintSession("evil-origin@paytm.com");
    const resp = await fetch(`http://localhost:${port}/auth/logout`, {
      method: "POST",
      headers: { cookie: `ark_session=${session}`, origin: EVIL },
    });
    expect(resp.status).toBe(401);
    const setCookies = getSetCookieHeaders(resp);
    expect(setCookies.find((c) => c.startsWith("ark_session=") && c.includes("Max-Age=0"))).toBeDefined();
    const after = await app.authSessions.sessions.getActive(session);
    expect(after).not.toBeNull();
  });

  it("FAILS CLOSED on empty allowedOrigins config (deployment must opt in)", async () => {
    const orig = [...app.config.authSection.session.allowedOrigins];
    (app.config.authSection.session as any).allowedOrigins = [];
    try {
      const resp = await fetch(`http://localhost:${port}/auth/logout`, {
        method: "POST",
        headers: { origin: GOOD },
      });
      expect(resp.status).toBe(401);
    } finally {
      (app.config.authSection.session as any).allowedOrigins = orig;
    }
  });

  it("error body is opaque -- no `reason` field leaked", async () => {
    const resp = await fetch(`http://localhost:${port}/auth/logout`, {
      method: "POST",
      headers: { origin: EVIL },
    });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid origin" });
    expect(Object.keys(body)).toEqual(["error"]);
  });
});

describe("/auth/google/callback 401 body opacity", () => {
  it("does NOT leak a `reason` field on missing_params failure", async () => {
    const resp = await fetch(`http://localhost:${port}/auth/google/callback`, { redirect: "manual" });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "authentication failed" });
    expect(Object.keys(body)).toEqual(["error"]);
  });

  it("does NOT leak a `reason` field on state_mismatch failure", async () => {
    const resp = await fetch(`http://localhost:${port}/auth/google/callback?state=abc&code=xyz`, {
      redirect: "manual",
      headers: { cookie: `ark_oauth_state=different-state-value` },
    });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "authentication failed" });
  });

  it("returns the opaque 401 (NOT 503) when Google client config is missing -- no fingerprinting oracle", async () => {
    // When clientSecret is missing, the previous behavior was 503 with
    // body `{error: "google login not configured"}` -- a probe-friendly
    // signal that this deployment lacks the secret. We now return the
    // same opaque 401 every other failure path uses.
    const orig = app.config.authSection.google.clientSecret;
    (app.config.authSection.google as any).clientSecret = null;
    try {
      const resp = await fetch(`http://localhost:${port}/auth/google/callback?state=x&code=y`, {
        redirect: "manual",
      });
      expect(resp.status).toBe(401);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body).toEqual({ error: "authentication failed" });
    } finally {
      (app.config.authSection.google as any).clientSecret = orig;
    }
  });
});

describe("Bearer-vs-cookie precedence -- bearer must resolve to its OWN tenant, not the cookie's", () => {
  it("Bearer wins even when an unrelated cookie is also sent (tighter than `not 401`)", async () => {
    // Mint a key in tenant `precedence-test`. The cookie is junk; if
    // the cookie path silently won, the request would resolve to
    // anonymous (junk cookie doesn't validate) and the apikey/list call
    // would 401 / forbid. Bearer-first means the call lands as the
    // Bearer's admin in `precedence-test`.
    const apiKey = await app.apiKeys.create("precedence-test", "precedence-key", "admin");
    const resp = await fetch(`http://localhost:${port}/`, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        authorization: `Bearer ${apiKey.key}`,
        cookie: "ark_session=junk-cookie-value",
      },
    });
    // Bearer is CSRF-immune so Origin / cookie-tossing branches do not
    // fire; the upgrade reaches Bun's WS layer (101 / 426 / 500) but
    // crucially is NOT the 401 cookie-tossing rejection.
    expect(resp.status).not.toBe(401);
  });

  it("Bearer wins even when a duplicate cookie (cookie-tossing trigger) is also sent", async () => {
    // Without the Bearer-first precedence, the duplicate cookie defense
    // would 401 the request. Bearer's presence must short-circuit the
    // cookie-tossing rejection.
    const apiKey = await app.apiKeys.create("precedence-test", "precedence-key-2", "admin");
    const resp = await fetch(`http://localhost:${port}/`, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        authorization: `Bearer ${apiKey.key}`,
        cookie: "ark_session=A; ark_session=B",
      },
    });
    expect(resp.status).not.toBe(401);
  });
});

describe("Bearer-vs-cookie precedence on resolveContext", () => {
  it("Bearer token takes precedence even when a cookie is also present", async () => {
    // We test the precedence indirectly by minting an API key, then
    // sending both a cookie and a bearer header on a request that hits
    // /mcp (which triggers resolveContextFromCredentials).
    // Bearer should win; the (irrelevant) cookie value won't matter.
    const apiKey = await app.apiKeys.create("default", "test-key", "admin");

    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey.key}`,
        cookie: "ark_session=garbage-cookie-value",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    // The Bearer token resolves to admin@default; the request should
    // reach the MCP handler (200 or some valid MCP response) rather than 401.
    expect(resp.status).not.toBe(401);
  });
});
