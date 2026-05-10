/**
 * materializeContext tests, focused on the cookie path.
 *
 * Verifies:
 *   - Local mode (requireToken=false) returns local-admin regardless of
 *     credentials supplied (existing behaviour, regression-guarded).
 *   - Cookie path takes precedence over bearer when both present.
 *   - Cookie path falls through to bearer when the cookie is invalid.
 *   - Bearer path still works when no cookie supplied.
 *   - Anonymous when nothing matches.
 */

import { describe, it, expect } from "bun:test";
import { materializeContext } from "../context.js";
import type { TenantContext } from "../../../types/index.js";

function fakeApiKeys(map: Record<string, TenantContext>) {
  return {
    validate: async (token: string) => map[token] ?? null,
  } as any;
}

function fakeAuthSessions(map: Record<string, TenantContext>) {
  return {
    validate: async (cookieValue: string) => map[cookieValue] ?? null,
  } as any;
}

const COOKIE_CTX: TenantContext = { tenantId: "t-cookie", userId: "u-cookie", role: "member" };
const BEARER_CTX: TenantContext = { tenantId: "t-bearer", userId: "u-bearer", role: "admin" };

describe("materializeContext", () => {
  it("returns local-admin when requireToken is false (local mode)", async () => {
    const ctx = await materializeContext({
      requireToken: false,
      defaultTenant: null,
    });
    expect(ctx.tenantId).toBe("default");
    expect(ctx.role).toBe("admin");
    expect(ctx.isAdmin).toBe(true);
  });

  it("local mode honours config.defaultTenant", async () => {
    const ctx = await materializeContext({
      requireToken: false,
      defaultTenant: "acme",
    });
    expect(ctx.tenantId).toBe("acme");
  });

  it("returns anonymous when requireToken is true and nothing supplied", async () => {
    const ctx = await materializeContext({
      requireToken: true,
      defaultTenant: null,
    });
    expect(ctx.tenantId).toBe("anonymous");
    expect(ctx.role).toBe("viewer");
    expect(ctx.isAdmin).toBe(false);
  });

  it("cookie path resolves a wire context when authSessions returns one", async () => {
    const ctx = await materializeContext({
      requireToken: true,
      defaultTenant: null,
      cookieValue: "good-cookie",
      authSessions: fakeAuthSessions({ "good-cookie": COOKIE_CTX }),
    });
    expect(ctx.tenantId).toBe("t-cookie");
    expect(ctx.userId).toBe("u-cookie");
    expect(ctx.role).toBe("member");
    expect(ctx.isAdmin).toBe(false);
  });

  it("cookie path takes precedence over bearer when both are valid", async () => {
    const ctx = await materializeContext({
      requireToken: true,
      defaultTenant: null,
      cookieValue: "good-cookie",
      authSessions: fakeAuthSessions({ "good-cookie": COOKIE_CTX }),
      authorizationHeader: "Bearer good-bearer",
      apiKeys: fakeApiKeys({ "good-bearer": BEARER_CTX }),
    });
    expect(ctx.tenantId).toBe("t-cookie");
    expect(ctx.userId).toBe("u-cookie");
  });

  it("invalid cookie falls through to a valid bearer token (mixed-client scenario)", async () => {
    const ctx = await materializeContext({
      requireToken: true,
      defaultTenant: null,
      cookieValue: "stale-cookie",
      authSessions: fakeAuthSessions({}), // returns null
      authorizationHeader: "Bearer good-bearer",
      apiKeys: fakeApiKeys({ "good-bearer": BEARER_CTX }),
    });
    expect(ctx.tenantId).toBe("t-bearer");
    expect(ctx.role).toBe("admin");
  });

  it("bearer path still works when no cookie supplied (CLI / MCP)", async () => {
    const ctx = await materializeContext({
      requireToken: true,
      defaultTenant: null,
      authorizationHeader: "Bearer good-bearer",
      apiKeys: fakeApiKeys({ "good-bearer": BEARER_CTX }),
    });
    expect(ctx.tenantId).toBe("t-bearer");
    expect(ctx.userId).toBe("u-bearer");
  });

  it("falls back to anonymous when both cookie and bearer fail", async () => {
    const ctx = await materializeContext({
      requireToken: true,
      defaultTenant: null,
      cookieValue: "bad-cookie",
      authSessions: fakeAuthSessions({}),
      authorizationHeader: "Bearer bad-bearer",
      apiKeys: fakeApiKeys({}),
    });
    expect(ctx.tenantId).toBe("anonymous");
    expect(ctx.isAdmin).toBe(false);
  });

  it("query token works when authorization header absent (backward compat)", async () => {
    const ctx = await materializeContext({
      requireToken: true,
      defaultTenant: null,
      queryToken: "good-bearer",
      apiKeys: fakeApiKeys({ "good-bearer": BEARER_CTX }),
    });
    expect(ctx.tenantId).toBe("t-bearer");
  });

  it("explicit bearerToken arg trumps both header and query (stdio caller)", async () => {
    const ctx = await materializeContext({
      requireToken: true,
      defaultTenant: null,
      bearerToken: "good-bearer",
      authorizationHeader: "Bearer wrong",
      queryToken: "wrong",
      apiKeys: fakeApiKeys({ "good-bearer": BEARER_CTX }),
    });
    expect(ctx.tenantId).toBe("t-bearer");
  });
});
