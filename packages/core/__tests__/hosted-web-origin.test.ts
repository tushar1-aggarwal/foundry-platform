/**
 * Regression tests for the hosted web server's CSRF + CORS posture:
 *
 *   - Cookie-authed write methods on `/api/rpc` MUST be Origin-checked.
 *     Bearer-only callers bypass entirely (CSRF-immune).
 *   - CORS `Access-Control-Allow-Origin: *` is incompatible with
 *     `credentials: "include"`. The browser rejects the response. We
 *     echo the request's Origin only when allowlisted, omit otherwise.
 *
 * These were Critical findings (#2 + #5) on PR #534 review.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { startWebServer } from "../hosted/web.js";
import { allocatePort } from "../config/port-allocator.js";
import { hashCookieValue } from "../repositories/sessions-auth.js";

let app: AppContext;
let server: { stop: () => void; url: string } | null = null;
let port: number;
const ALLOWED_ORIGIN = "http://localhost:8420";
const EVIL_ORIGIN = "https://evil.com";

beforeAll(async () => {
  app = await AppContext.forTestAsync({
    auth: { enabled: true, apiKeyEnabled: true },
  } as any);
  await app.boot();
  // Cookie path needs requireToken + a populated allowedOrigins.
  (app.config.authSection as any).requireToken = true;
  (app.config.authSection.session as any).allowedOrigins = [ALLOWED_ORIGIN];

  port = await allocatePort();
  server = startWebServer(app, { port });
});

afterAll(async () => {
  server?.stop();
  server = null;
  await app?.shutdown();
});

let counter = 0;
async function mintLiveSessionForUser(): Promise<{ cookieValue: string; userId: string }> {
  // Drive a cookie-authed request without going through Google OAuth.
  const slug = `origin-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await app.tenants.create({ slug, name: slug });
  const team = await app.teams.create({ tenant_id: tenant.id, slug: `${slug}-team`, name: `${slug}-team` });
  const user = await app.users.upsertByEmail({ email: `${slug}@example.com` });
  await app.teams.addMember(team.id, user.id, "member");

  const session = await app.authSessions.sessions.create({
    userId: user.id,
    ttlSec: 3600,
    teamChain: [team.id],
  });
  return { cookieValue: session.cookieValue, userId: user.id };
}

async function rpcWithCookie(method: string, params: unknown, opts: { cookie: string; origin?: string | null }) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers["Cookie"] = `ark_session=${opts.cookie}`;
  if (opts.origin) headers["Origin"] = opts.origin;
  return fetch(`http://localhost:${port}/api/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function rpcWithBearer(method: string, params: unknown, opts: { token: string; origin?: string | null }) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.token}`,
  };
  if (opts.origin) headers["Origin"] = opts.origin;
  return fetch(`http://localhost:${port}/api/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("/api/rpc: Origin enforcement on cookie-authed writes", () => {
  it("rejects a cookie-authed WRITE method with no Origin (401 + clears cookie)", async () => {
    const { cookieValue } = await mintLiveSessionForUser();
    // Sanity: the session row is live before the call.
    const before = await app.authSessions.sessions.getById(hashCookieValue(cookieValue));
    expect(before).not.toBeNull();

    const resp = await rpcWithCookie("session/start", { foo: "bar" }, { cookie: cookieValue });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe("invalid origin");
    const setCookie = resp.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/ark_session=/);
    expect(setCookie).toMatch(/Max-Age=0/i);

    // The DB row is still live -- this was a CSRF defense, not a logout.
    const after = await app.authSessions.sessions.getById(hashCookieValue(cookieValue));
    expect(after).not.toBeNull();
  });

  it("rejects a cookie-authed WRITE method with non-allowlisted Origin", async () => {
    const { cookieValue } = await mintLiveSessionForUser();
    const resp = await rpcWithCookie("session/start", { foo: "bar" }, { cookie: cookieValue, origin: EVIL_ORIGIN });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe("invalid origin");
  });

  it("does NOT enforce Origin on a cookie-authed READ method", async () => {
    const { cookieValue } = await mintLiveSessionForUser();
    // Reads don't need CSRF protection (no state mutation). Without
    // Origin the call should reach the handler instead of 401.
    const resp = await rpcWithCookie("session/list", {}, { cookie: cookieValue });
    expect(resp.status).not.toBe(401);
  });

  it("does NOT enforce Origin on a Bearer-authed WRITE method (CLI path)", async () => {
    // CLI clients don't (and shouldn't) attach Origin. Bearer is
    // CSRF-immune: browsers don't auto-attach Authorization headers
    // cross-origin like they do cookies.
    const created = await app.apiKeys.create("default", "csrf-test-key", "admin");
    const resp = await rpcWithBearer("session/start", { foo: "bar" }, { token: created.key });
    // The handler may still error for other reasons (missing required
    // params) but the request must NOT be rejected with the Origin 401.
    if (resp.status === 401) {
      const body = (await resp.json()) as { error?: { message?: string } };
      expect(body.error?.message).not.toBe("invalid origin");
    }
  });

  it("permits a cookie-authed WRITE when Origin is in the allowlist", async () => {
    const { cookieValue } = await mintLiveSessionForUser();
    const resp = await rpcWithCookie("session/start", { foo: "bar" }, { cookie: cookieValue, origin: ALLOWED_ORIGIN });
    if (resp.status === 401) {
      const body = (await resp.json()) as { error?: { message?: string } };
      expect(body.error?.message).not.toBe("invalid origin");
    }
  });

  it("FAILS CLOSED on empty allowedOrigins config (deployment must opt in)", async () => {
    const orig = [...app.config.authSection.session.allowedOrigins];
    (app.config.authSection.session as any).allowedOrigins = [];
    try {
      const { cookieValue } = await mintLiveSessionForUser();
      const resp = await rpcWithCookie("session/start", {}, { cookie: cookieValue, origin: ALLOWED_ORIGIN });
      // server captured allowedOrigins at startWebServer time, so we
      // can't actually flip live config. Spawn a fresh server with
      // empty allowedOrigins to exercise this path.
      void resp;
    } finally {
      (app.config.authSection.session as any).allowedOrigins = orig;
    }

    // Spin up a fresh server with empty allowedOrigins to test fail-closed.
    (app.config.authSection.session as any).allowedOrigins = [];
    const isolatedPort = await allocatePort();
    const isolatedServer = startWebServer(app, { port: isolatedPort });
    try {
      const { cookieValue } = await mintLiveSessionForUser();
      const resp = await fetch(`http://localhost:${isolatedPort}/api/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `ark_session=${cookieValue}`,
          Origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/start", params: {} }),
      });
      expect(resp.status).toBe(401);
      const body = (await resp.json()) as { error?: { message?: string } };
      expect(body.error?.message).toBe("invalid origin");
    } finally {
      isolatedServer.stop();
      (app.config.authSection.session as any).allowedOrigins = orig;
    }
  });
});

describe("/api/rpc: CORS posture vs credentialed fetch", () => {
  it("does NOT emit `Access-Control-Allow-Origin: *` (incompatible with credentials)", async () => {
    const resp = await fetch(`http://localhost:${port}/api/health`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(resp.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("echoes a known-allowlisted Origin back as `Access-Control-Allow-Origin`", async () => {
    const resp = await fetch(`http://localhost:${port}/api/health`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(resp.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    // Vary: Origin signals to caches that the response varies per Origin.
    expect((resp.headers.get("vary") ?? "").toLowerCase()).toContain("origin");
  });

  it("omits `Access-Control-Allow-Origin` for non-allowlisted Origins (browser will block)", async () => {
    const resp = await fetch(`http://localhost:${port}/api/health`, {
      headers: { Origin: EVIL_ORIGIN },
    });
    expect(resp.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("emits `Access-Control-Allow-Credentials: true` so credentialed fetches work cross-origin", async () => {
    const resp = await fetch(`http://localhost:${port}/api/health`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(resp.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
