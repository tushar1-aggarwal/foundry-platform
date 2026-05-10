/**
 * `apikey/*` self-service handler tests.
 *
 * Covers:
 *   - requireRealUser gate: anonymous, local-mode, api-key auth, and
 *     soft-deleted users all get FORBIDDEN.
 *   - Cross-user isolation: A's listForUser doesn't see B's; A can't
 *     revoke B's key.
 *   - NULL-owner (admin-minted) keys are not revocable via self-service.
 *   - Role ceiling: cannot mint role > own role.
 *   - Per-user cap: 11th create rejects.
 *   - Plaintext key returned exactly once.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerApiKeyHandlers } from "../apikey.js";
import { createRequest, ErrorCodes, type JsonRpcError, type JsonRpcResponse } from "../../../protocol/types.js";
import { anonymousContext, localAdminContext, type TenantContext } from "../../../core/auth/context.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerApiKeyHandlers(router, app);
});

function dispatchAs(method: string, params: Record<string, unknown>, ctx: TenantContext) {
  return router.dispatch(createRequest(1, method, params), undefined, ctx);
}

async function makeUserCtx(emailLocal: string, role: TenantContext["role"] = "member"): Promise<TenantContext> {
  const tenant = await app.tenants.create({ slug: `t-${emailLocal}`, name: `T ${emailLocal}` });
  const team = await app.teams.create({ tenant_id: tenant.id, slug: `team-${emailLocal}`, name: `Team ${emailLocal}` });
  const user = await app.users.create({ email: `${emailLocal}@paytm.com` });
  await app.teams.addMember(team.id, user.id, role);
  return { tenantId: tenant.id, userId: user.id, role, isAdmin: role === "admin" };
}

describe("apikey/* requireRealUser gate", () => {
  it("anonymous → FORBIDDEN on every method", async () => {
    const anon = anonymousContext();
    for (const [method, params] of [
      ["apikey/list", {}],
      ["apikey/create", { name: "x" }],
      ["apikey/revoke", { id: "ak-x" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const res = (await dispatchAs(method, params, anon)) as JsonRpcError;
      expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
      expect(res.error?.message).toMatch(/logged-in user session/);
    }
  });

  it("local-mode admin (userId='local') → FORBIDDEN", async () => {
    const local = localAdminContext("default");
    const res = (await dispatchAs("apikey/list", {}, local)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("api-key authenticated caller (ctx.userId='ak-xxxx') → FORBIDDEN (identity-loop guard)", async () => {
    const apiKeyCtx: TenantContext = {
      tenantId: "default",
      userId: "ak-fakekeyid",
      role: "admin",
      isAdmin: true,
    };
    const res = (await dispatchAs("apikey/create", { name: "would-clone" }, apiKeyCtx)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("soft-deleted user → FORBIDDEN", async () => {
    const ctx = await makeUserCtx("ghost");
    await app.users.delete(ctx.userId!);
    const res = (await dispatchAs("apikey/list", {}, ctx)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
  });
});

describe("apikey/create + list + revoke happy path", () => {
  it("creates a key, lists it, revokes it", async () => {
    const ctx = await makeUserCtx("alice");

    const createRes = (await dispatchAs("apikey/create", { name: "test-key" }, ctx)) as JsonRpcResponse;
    const created = createRes.result as { id: string; key: string };
    expect(created.id).toMatch(/^ak-/);
    expect(created.key).toMatch(new RegExp(`^ark_${ctx.tenantId}_`));

    const listRes = (await dispatchAs("apikey/list", {}, ctx)) as JsonRpcResponse;
    const keys = (listRes.result as { keys: Array<{ id: string; name: string }> }).keys;
    expect(keys).toHaveLength(1);
    expect(keys[0].id).toBe(created.id);
    expect(keys[0].name).toBe("test-key");

    const revokeRes = (await dispatchAs("apikey/revoke", { id: created.id }, ctx)) as JsonRpcResponse;
    expect((revokeRes.result as { ok: boolean }).ok).toBe(true);

    const listAfter = (await dispatchAs("apikey/list", {}, ctx)) as JsonRpcResponse;
    expect((listAfter.result as { keys: unknown[] }).keys).toHaveLength(0);
  });

  it("plaintext key is returned exactly once (subsequent list never has it)", async () => {
    const ctx = await makeUserCtx("plaintext-once");
    const createRes = (await dispatchAs("apikey/create", { name: "k" }, ctx)) as JsonRpcResponse;
    expect((createRes.result as { key: string }).key).toMatch(/^ark_/);

    const listRes = (await dispatchAs("apikey/list", {}, ctx)) as JsonRpcResponse;
    const keys = (listRes.result as { keys: Array<Record<string, unknown>> }).keys;
    expect(keys[0]).not.toHaveProperty("key");
  });
});

describe("apikey/* cross-user isolation", () => {
  it("listForUser only returns the caller's keys", async () => {
    const a = await makeUserCtx("isolation-a");
    const b = await makeUserCtx("isolation-b");

    await dispatchAs("apikey/create", { name: "a-key" }, a);
    await dispatchAs("apikey/create", { name: "b-key" }, b);

    const aList = ((await dispatchAs("apikey/list", {}, a)) as JsonRpcResponse).result as {
      keys: Array<{ name: string }>;
    };
    const bList = ((await dispatchAs("apikey/list", {}, b)) as JsonRpcResponse).result as {
      keys: Array<{ name: string }>;
    };

    expect(aList.keys.map((k) => k.name)).toEqual(["a-key"]);
    expect(bList.keys.map((k) => k.name)).toEqual(["b-key"]);
  });

  it("user A cannot revoke user B's key (FORBIDDEN, conflated with not-found)", async () => {
    const a = await makeUserCtx("revoke-a");
    const b = await makeUserCtx("revoke-b");
    const bCreate = ((await dispatchAs("apikey/create", { name: "b" }, b)) as JsonRpcResponse).result as {
      id: string;
    };

    const res = (await dispatchAs("apikey/revoke", { id: bCreate.id }, a)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
    // B's key should still be live.
    const bList = ((await dispatchAs("apikey/list", {}, b)) as JsonRpcResponse).result as {
      keys: Array<{ id: string }>;
    };
    expect(bList.keys.map((k) => k.id)).toContain(bCreate.id);
  });

  it("listForUser does not bleed across tenants (same user_id, different tenant_id)", async () => {
    // Set up: user A in tenant T1 with one key; user B in tenant T2 reusing
    // A's userId via direct DB insert (simulates a future id-generator change
    // that collapses uniqueness across tenants). Defense-in-depth check: A's
    // listForUser must NOT see the row in T2.
    const a = await makeUserCtx("tenant-leak-a");
    await dispatchAs("apikey/create", { name: "a-key" }, a);

    // Direct DB INSERT: a row in a DIFFERENT tenant with the SAME user_id.
    const otherTenant = await app.tenants.create({ slug: "tenant-leak-other", name: "Other" });
    await app.db
      .prepare(
        `INSERT INTO api_keys (id, tenant_id, key_hash, name, role, created_at, user_id)
         VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
      )
      .run("ak-leaked-other", otherTenant.id, "fake-hash-x", "leaked-other", "member", a.userId!);

    const list = ((await dispatchAs("apikey/list", {}, a)) as JsonRpcResponse).result as {
      keys: Array<{ id: string; tenantId: string; name: string }>;
    };
    expect(list.keys.map((k) => k.name)).toEqual(["a-key"]);
    expect(list.keys.find((k) => k.id === "ak-leaked-other")).toBeUndefined();
  });

  it("countLiveForUser does not bleed across tenants", async () => {
    const a = await makeUserCtx("count-leak-a");
    await dispatchAs("apikey/create", { name: "a-key" }, a);

    // Same construction: a row in a different tenant with A's user_id.
    const otherTenant = await app.tenants.create({ slug: "count-leak-other", name: "Other" });
    await app.db
      .prepare(
        `INSERT INTO api_keys (id, tenant_id, key_hash, name, role, created_at, user_id)
         VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
      )
      .run("ak-cross-cnt", otherTenant.id, "fake-hash-c", "cross-cnt", "member", a.userId!);

    // The cap should count only A's tenant; A still has room to create.
    expect(await app.apiKeys.countLiveForUser(a.userId!, a.tenantId)).toBe(1);
    expect(await app.apiKeys.countLiveForUser(a.userId!, otherTenant.id)).toBe(1);
  });

  it("revokeAsUser refuses to revoke a row whose tenant_id differs (cross-tenant defense)", async () => {
    const a = await makeUserCtx("revoke-leak-a");

    // A row in a different tenant with A's user_id. Direct INSERT.
    const otherTenant = await app.tenants.create({ slug: "revoke-leak-other", name: "Other" });
    await app.db
      .prepare(
        `INSERT INTO api_keys (id, tenant_id, key_hash, name, role, created_at, user_id)
         VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
      )
      .run("ak-cross-rev", otherTenant.id, "fake-hash-r", "cross-rev", "member", a.userId!);

    // A tries to revoke that row using its id -- should be refused
    // (FORBIDDEN, conflated with not-found) because tenant_id differs.
    const res = (await dispatchAs("apikey/revoke", { id: "ak-cross-rev" }, a)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);

    // The cross-tenant row must still be live.
    const otherRows = await app.apiKeys.list(otherTenant.id);
    expect(otherRows.find((k) => k.id === "ak-cross-rev" && !k.deletedAt)).toBeTruthy();
  });

  it("admin-minted (NULL-owner) keys are not revocable via self-service", async () => {
    const ctx = await makeUserCtx("admin-minted");
    // Mint an admin-minted key directly via the manager (no userId).
    const adminKey = await app.apiKeys.create(ctx.tenantId, "admin-minted-key", "admin");

    const res = (await dispatchAs("apikey/revoke", { id: adminKey.id }, ctx)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
    // Still live.
    const row = await app.apiKeys.list(ctx.tenantId);
    expect(row.find((k) => k.id === adminKey.id && !k.deletedAt)).toBeTruthy();
  });
});

describe("apikey/create role ceiling + per-user cap", () => {
  it("member-role user cannot mint admin-role key", async () => {
    const ctx = await makeUserCtx("member-role", "member");
    const res = (await dispatchAs("apikey/create", { name: "x", role: "admin" }, ctx)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(res.error?.message).toMatch(/cannot mint role 'admin'/);
  });

  it("admin-role user CAN mint admin-role key", async () => {
    const ctx = await makeUserCtx("admin-role", "admin");
    const res = (await dispatchAs("apikey/create", { name: "x", role: "admin" }, ctx)) as JsonRpcResponse;
    expect((res.result as { key: string }).key).toMatch(/^ark_/);
  });

  it("default role on create is the caller's own role", async () => {
    const ctx = await makeUserCtx("default-role", "member");
    const create = ((await dispatchAs("apikey/create", { name: "x" }, ctx)) as JsonRpcResponse).result as {
      id: string;
    };
    const list = ((await dispatchAs("apikey/list", {}, ctx)) as JsonRpcResponse).result as {
      keys: Array<{ id: string; role: string }>;
    };
    expect(list.keys.find((k) => k.id === create.id)?.role).toBe("member");
  });

  it("11th create exceeds per-user cap of 10", async () => {
    const ctx = await makeUserCtx("cap-test");
    for (let i = 0; i < 10; i++) {
      const r = (await dispatchAs("apikey/create", { name: `k${i}` }, ctx)) as JsonRpcResponse;
      expect((r.result as { key: string }).key).toBeTruthy();
    }
    const eleventh = (await dispatchAs("apikey/create", { name: "k11" }, ctx)) as JsonRpcError;
    expect(eleventh.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(eleventh.error?.message).toMatch(/maximum of 10/);
  });

  it("cap counts only LIVE keys -- revoked keys don't block new creates", async () => {
    const ctx = await makeUserCtx("cap-revoke");
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = ((await dispatchAs("apikey/create", { name: `k${i}` }, ctx)) as JsonRpcResponse).result as {
        id: string;
      };
      ids.push(r.id);
    }
    // revoke one
    await dispatchAs("apikey/revoke", { id: ids[0] }, ctx);
    // 11th create should now succeed
    const eleventh = (await dispatchAs("apikey/create", { name: "k-after-revoke" }, ctx)) as JsonRpcResponse;
    expect((eleventh.result as { key: string }).key).toMatch(/^ark_/);
  });

  it("name is required and trimmed", async () => {
    const ctx = await makeUserCtx("name-trim");
    const empty = (await dispatchAs("apikey/create", { name: "   " }, ctx)) as JsonRpcError;
    expect(empty.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});
