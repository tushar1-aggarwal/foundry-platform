/**
 * WebSocket upgrade Origin enforcement.
 *
 * The conductor's WS-upgrade path is the most critical CSRF surface in
 * Phase 1: a malicious page could open a WS to our listener and ride
 * the user's session cookie for JSON-RPC dispatches. These tests verify
 * the Origin allowlist runs at upgrade time before any frame is exchanged.
 *
 * We test by sending a raw HTTP upgrade request (not a real WebSocket
 * client) so we can inspect the response status + Set-Cookie. A
 * real-browser WS client wouldn't surface either signal cleanly.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../core/app.js";
import { ArkServer } from "../index.js";
import { registerAllHandlers } from "../register.js";
import { allocatePort } from "../../core/config/port-allocator.js";

let app: AppContext;
let server: ArkServer;
let ws: { stop(): void };
let port: number;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  // Cookie-auth path requires `requireToken: true` AND a non-empty
  // `allowedOrigins` (else the check fails closed by design).
  (app.config.authSection as any).requireToken = true;
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

/**
 * Issue a raw HTTP upgrade request. Real WS clients wouldn't surface a
 * 401 cleanly; raw fetch with `Upgrade: websocket` headers does.
 */
async function rawUpgrade(opts: { cookie?: string; bearer?: string; origin?: string | null }): Promise<Response> {
  const headers: Record<string, string> = {
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
  };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  if (opts.origin) headers["origin"] = opts.origin;
  return fetch(`http://localhost:${port}/`, { method: "GET", headers });
}

function getSetCookieHeaders(resp: Response): string[] {
  const anyHeaders = resp.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

describe("WS upgrade Origin enforcement", () => {
  it("rejects cookie-authed upgrade with mismatched Origin (401 + clears cookie)", async () => {
    const resp = await rawUpgrade({ cookie: "ark_session=any-value", origin: "https://evil.com" });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid origin" });
    const clears = getSetCookieHeaders(resp).find((c) => c.startsWith("ark_session=") && c.includes("Max-Age=0"));
    expect(clears).toBeDefined();
  });

  it("rejects cookie-authed upgrade with NO Origin (fail closed)", async () => {
    const resp = await rawUpgrade({ cookie: "ark_session=any-value" });
    expect(resp.status).toBe(401);
  });

  it("does NOT enforce Origin on Bearer-authed upgrade (CLI / programmatic bypass)", async () => {
    // Bearer path should reach the Bun WS upgrade attempt. Bun returns
    // 101 on a successful WS upgrade or 426/500 if the upgrade fails
    // (e.g. raw fetch can't complete the WS dance). The crucial
    // assertion is "NOT 401 with invalid-origin" -- meaning the Origin
    // check did NOT fire.
    const resp = await rawUpgrade({ bearer: "any-bearer", origin: "https://evil.com" });
    expect(resp.status).not.toBe(401);
  });

  it("does NOT enforce Origin when no auth credentials are present (anonymous WS)", async () => {
    // No cookie, no bearer -- the JSON-RPC handlers will fail-closed on
    // their own (anonymous context), but the upgrade itself doesn't
    // need Origin enforcement.
    const resp = await rawUpgrade({ origin: "https://evil.com" });
    expect(resp.status).not.toBe(401);
  });

  it("FAILS CLOSED when allowedOrigins is empty even with a matching-shape Origin", async () => {
    const orig = [...app.config.authSection.session.allowedOrigins];
    (app.config.authSection.session as any).allowedOrigins = [];
    server.attachAuth(app); // re-read config
    try {
      const resp = await rawUpgrade({ cookie: "ark_session=v", origin: "http://localhost:8420" });
      expect(resp.status).toBe(401);
    } finally {
      (app.config.authSection.session as any).allowedOrigins = orig;
      server.attachAuth(app);
    }
  });
});

describe("WS upgrade Origin enforcement -- requireToken=false (local mode)", () => {
  it("does NOT enforce Origin in local mode (single-user / trust the host)", async () => {
    const orig = app.config.authSection.requireToken;
    (app.config.authSection as any).requireToken = false;
    server.attachAuth(app);
    try {
      const resp = await rawUpgrade({ cookie: "ark_session=v", origin: "https://evil.com" });
      expect(resp.status).not.toBe(401);
    } finally {
      (app.config.authSection as any).requireToken = orig;
      server.attachAuth(app);
    }
  });
});

describe("WS upgrade duplicate-cookie defense (cookie-tossing fallthrough)", () => {
  // The Cookie-tossing pattern: an attacker on a sibling subdomain (or
  // via XSS) causes the browser to attach two cookies named `ark_session`.
  // `getSessionCookie()` fails closed and returns null; the previous
  // upgrade code then dispatched JSON-RPC with `sessionCookieValue: null`,
  // landing on `materializeContext`'s "fall through to bearer path"
  // branch -> anonymous context. Read-only handlers ran as anonymous and
  // the user's session protection silently degraded. The fix: when the
  // cookie header DOES name our session cookie but `getSessionCookie`
  // refused to parse, reject the upgrade (matching the browser's intent
  // to send the cookie).
  it("rejects WS upgrade when ark_session appears more than once in Cookie header", async () => {
    const resp = await rawUpgrade({
      cookie: "ark_session=A; ark_session=B",
      origin: "http://localhost:8420",
    });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid session cookie");
    const clears = getSetCookieHeaders(resp).find((c) => c.startsWith("ark_session=") && c.includes("Max-Age=0"));
    expect(clears).toBeDefined();
  });

  it("does NOT reject when a Bearer token is also present (Bearer-first precedence)", async () => {
    // Mixed-client scenario: a CLI hop sends Bearer + a leftover stale
    // cookie. The duplicate-cookie defense applies to cookie-only
    // callers; Bearer wins and the cookie ambiguity is irrelevant.
    const resp = await rawUpgrade({
      cookie: "ark_session=A; ark_session=B",
      bearer: "any-bearer",
      origin: "http://localhost:8420",
    });
    expect(resp.status).not.toBe(401);
  });

  it("does NOT reject when cookie header is present but does not name ark_session", async () => {
    const resp = await rawUpgrade({ cookie: "theme=dark; locale=en", origin: "http://localhost:8420" });
    // No session cookie present at all -> the existing anonymous
    // fallthrough is correct (read-only handlers will gate themselves).
    expect(resp.status).not.toBe(401);
  });
});
