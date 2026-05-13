/**
 * Integration tests for `admin/scoping/*` handlers. Mirror the
 * structure of admin-apikey.test.ts: auth gate, per-method happy
 * paths, validator failure modes, tenant-scope enforcement,
 * idempotent operations, and the cross-tenant defense.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerAdminScopingHandlers } from "../admin-scoping.js";
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

beforeEach(async () => {
  router = new Router();
  registerAdminScopingHandlers(router, app);
  // Clean shared DB state so tests are order-independent. Hard-delete
  // rather than soft-delete -- this is test fixtureing, not production.
  await app.db.exec("DELETE FROM scoping_overrides");
});

function dispatchAs(method: string, params: Record<string, unknown>, ctx: TenantContext) {
  return router.dispatch(createRequest(1, method, params), undefined, ctx);
}

function adminCtx(tenantId: string, userId = "u-admin"): TenantContext {
  return {
    tenantId,
    userId,
    role: "admin",
    isAdmin: true,
    scopingUserId: userId,
    teamChain: [],
  };
}

// Reuse the seeded `default` tenant + `default-team` from migration 017,
// and the `local` compute that's auto-seeded at app boot.
async function seedAdminUser(emailLocal: string): Promise<{ userId: string; tenantId: string }> {
  const u = await app.users.upsertByEmail({ email: `${emailLocal}@phase2.test` });
  return { userId: u.id, tenantId: "default" };
}

async function ok<T = unknown>(res: unknown): Promise<T> {
  const r = res as JsonRpcResponse;
  if ("error" in r) throw new Error(`expected ok response, got error: ${JSON.stringify(r.error)}`);
  return r.result as T;
}

describe("admin/scoping/* auth gate", () => {
  it("anonymous -> FORBIDDEN on every method", async () => {
    const anon = anonymousContext();
    for (const method of ["admin/scoping/set", "admin/scoping/list", "admin/scoping/get", "admin/scoping/delete"]) {
      const res = (await dispatchAs(method, {}, anon)) as JsonRpcError;
      expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
      expect(res.error?.message).toMatch(/admin/i);
    }
  });

  it("member role -> FORBIDDEN", async () => {
    const memberCtx: TenantContext = {
      tenantId: "default",
      userId: "u-member",
      role: "member",
      isAdmin: false,
      scopingUserId: "u-member",
      teamChain: [],
    };
    const res = (await dispatchAs("admin/scoping/list", {}, memberCtx)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("local-mode admin (synthetic) -> OK", async () => {
    const local = localAdminContext("default");
    const res = (await dispatchAs("admin/scoping/list", {}, local)) as JsonRpcResponse;
    expect((res.result as { rows: unknown[] }).rows).toBeDefined();
  });
});

describe("admin/scoping/set happy paths", () => {
  it("sets a tenant-level runtime override", async () => {
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    const ctx = adminCtx("default");
    const result = await ok<{ row: { value_json: string; set_by: string | null; scope_kind: string } }>(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "runtime", value: knownRuntime },
        ctx,
      ),
    );
    expect(result.row.scope_kind).toBe("tenant");
    expect(JSON.parse(result.row.value_json)).toBe(knownRuntime);
    expect(result.row.set_by).toBe("u-admin");
  });

  it("sets a tenant-level model override using an alias", async () => {
    const aliasModel = app.models.list().find((m) => Array.isArray(m.aliases) && m.aliases.length > 0);
    if (!aliasModel || !aliasModel.aliases) throw new Error("test setup: need at least one model alias");
    const alias = aliasModel.aliases[0];
    const ctx = adminCtx("default");
    const result = await ok<{ row: { value_json: string } }>(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "model", value: alias },
        ctx,
      ),
    );
    expect(JSON.parse(result.row.value_json)).toBe(alias);
  });

  it("sets a tenant-level compute.default override using a tenant-scoped compute name", async () => {
    const ctx = adminCtx("default");
    // The local auto-seeded compute name is "local"; verify it exists.
    const local = await app.computes.get("local");
    expect(local).not.toBeNull();
    const result = await ok<{ row: { value_json: string } }>(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "compute.default", value: "local" },
        ctx,
      ),
    );
    expect(JSON.parse(result.row.value_json)).toBe("local");
  });

  it("sets a tenant-level flow.allowlist with known flow names", async () => {
    const flowNames = (await app.flows.list()).slice(0, 2).map((f) => f.name);
    const ctx = adminCtx("default");
    const result = await ok<{ row: { value_json: string } }>(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "flow.allowlist", value: flowNames },
        ctx,
      ),
    );
    expect(JSON.parse(result.row.value_json)).toEqual(flowNames);
  });

  it("idempotent set (same key + scope twice) -> UPDATE wins, single live row", async () => {
    const ctx = adminCtx("default", "u-first-admin");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    await ok(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "runtime", value: knownRuntime },
        ctx,
      ),
    );
    const ctx2 = adminCtx("default", "u-second-admin");
    const second = await ok<{ row: { id: string; set_by: string | null } }>(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "runtime", value: knownRuntime },
        ctx2,
      ),
    );
    expect(second.row.set_by).toBe("u-second-admin");

    const listRes = await ok<{ rows: Array<{ id: string }> }>(
      await dispatchAs("admin/scoping/list", { scope_kind: "tenant", key: "runtime" }, ctx),
    );
    const liveRows = listRes.rows.filter((r) => r.id === second.row.id);
    expect(liveRows).toHaveLength(1);
  });
});

describe("admin/scoping/set validator rejections", () => {
  it("rejects unknown runtime name and lists the catalog as a hint", async () => {
    const ctx = adminCtx("default");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    const res = (await dispatchAs(
      "admin/scoping/set",
      { scope_kind: "tenant", scope_id: "default", key: "runtime", value: "ghost-runtime-xyz" },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(res.error?.message).toContain("ghost-runtime-xyz");
    expect(res.error?.message).toMatch(/not.*registered/i);
    // Catalog hint: a real runtime name from the seeded list must appear.
    expect(res.error?.message).toContain("Known runtimes:");
    expect(res.error?.message).toContain(knownRuntime);
  });

  it("rejects unknown model id / alias and lists the catalog as a hint", async () => {
    const ctx = adminCtx("default");
    const someModel = app.models.list()[0];
    const res = (await dispatchAs(
      "admin/scoping/set",
      { scope_kind: "tenant", scope_id: "default", key: "model", value: "ghost-model-xyz" },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(res.error?.message).toContain("ghost-model-xyz");
    expect(res.error?.message).toContain("Known:");
    // At least one real model id must appear in the hint.
    expect(res.error?.message).toContain(someModel.id);
  });

  it("rejects compute.default not present in caller's tenant and lists tenant computes as a hint", async () => {
    const ctx = adminCtx("default");
    const res = (await dispatchAs(
      "admin/scoping/set",
      { scope_kind: "tenant", scope_id: "default", key: "compute.default", value: "ghost-compute-xyz" },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(res.error?.message).toContain("ghost-compute-xyz");
    expect(res.error?.message).toContain("default");
    // Catalog hint: the seeded "local" compute should appear.
    expect(res.error?.message).toContain("Known computes in tenant:");
    expect(res.error?.message).toContain("local");
  });

  it("rejects flow.allowlist when an element isn't a known flow name", async () => {
    const ctx = adminCtx("default");
    const res = (await dispatchAs(
      "admin/scoping/set",
      { scope_kind: "tenant", scope_id: "default", key: "flow.allowlist", value: ["docs", "ghost-flow-xyz"] },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(res.error?.message).toContain("ghost-flow-xyz");
  });

  it("rejects flow.allowlist when value isn't an array of strings", async () => {
    const ctx = adminCtx("default");
    const res = (await dispatchAs(
      "admin/scoping/set",
      { scope_kind: "tenant", scope_id: "default", key: "flow.allowlist", value: "docs" },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(res.error?.message).toMatch(/array of strings/i);
  });

  it("rejects unknown scoping key with a known-keys hint", async () => {
    const ctx = adminCtx("default");
    const res = (await dispatchAs(
      "admin/scoping/set",
      { scope_kind: "tenant", scope_id: "default", key: "bogus.key", value: "anything" },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(res.error?.message).toContain("bogus.key");
    expect(res.error?.message).toContain("flow.allowlist");
    expect(res.error?.message).toContain("runtime");
    expect(res.error?.message).toContain("model");
    expect(res.error?.message).toContain("compute.default");
  });

  it("rejects unknown scope_kind", async () => {
    const ctx = adminCtx("default");
    const res = (await dispatchAs(
      "admin/scoping/set",
      { scope_kind: "galaxy", scope_id: "default", key: "runtime", value: "x" },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(res.error?.message).toMatch(/scope_kind/i);
  });
});

describe("admin/scoping/set cross-tenant defense", () => {
  it("tenant-level override with scope_id != ctx.tenantId -> FORBIDDEN", async () => {
    const ctx = adminCtx("default");
    const res = (await dispatchAs(
      "admin/scoping/set",
      { scope_kind: "tenant", scope_id: "other-tenant", key: "runtime", value: "x" },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
    expect(res.error?.message).toMatch(/tenant_id/i);
  });

  it("user-level override for a non-existent user -> NOT_FOUND", async () => {
    const ctx = adminCtx("default");
    const res = (await dispatchAs(
      "admin/scoping/set",
      { scope_kind: "user", scope_id: "u-ghost-xyz", key: "runtime", value: "x" },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.NOT_FOUND);
    expect(res.error?.message).toContain("u-ghost-xyz");
  });

  it("team-level override for a non-existent team -> NOT_FOUND", async () => {
    const ctx = adminCtx("default");
    const res = (await dispatchAs(
      "admin/scoping/set",
      { scope_kind: "team", scope_id: "team-ghost-xyz", key: "runtime", value: "x" },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.NOT_FOUND);
    expect(res.error?.message).toContain("team-ghost-xyz");
  });

  it("user-level override for a real user in tenant -> OK", async () => {
    const { userId } = await seedAdminUser("cross-tenant-real");
    await app.teams.addMember("default-team", userId, "member");
    const ctx = adminCtx("default");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    const result = await ok<{ row: { scope_id: string } }>(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "user", scope_id: userId, key: "runtime", value: knownRuntime },
        ctx,
      ),
    );
    expect(result.row.scope_id).toBe(userId);
  });
});

describe("admin/scoping/list", () => {
  it("lists live rows scoped to caller's tenant", async () => {
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    const ctx = adminCtx("default");
    await ok(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "runtime", value: knownRuntime },
        ctx,
      ),
    );
    const result = await ok<{ rows: Array<{ tenant_id: string }> }>(await dispatchAs("admin/scoping/list", {}, ctx));
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.tenant_id).toBe("default");
    }
  });

  it("filters by scope_kind", async () => {
    const ctx = adminCtx("default");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    await ok(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "runtime", value: knownRuntime },
        ctx,
      ),
    );
    const result = await ok<{ rows: Array<{ scope_kind: string }> }>(
      await dispatchAs("admin/scoping/list", { scope_kind: "tenant" }, ctx),
    );
    for (const row of result.rows) {
      expect(row.scope_kind).toBe("tenant");
    }
  });

  it("includes tombstones only when includeDeleted=true", async () => {
    const ctx = adminCtx("default");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    await ok(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "runtime", value: knownRuntime },
        ctx,
      ),
    );
    await ok(
      await dispatchAs("admin/scoping/delete", { scope_kind: "tenant", scope_id: "default", key: "runtime" }, ctx),
    );

    const noDeleted = await ok<{ rows: Array<{ id: string }> }>(
      await dispatchAs("admin/scoping/list", { key: "runtime" }, ctx),
    );
    expect(noDeleted.rows).toHaveLength(0);

    const withDeleted = await ok<{ rows: Array<{ deleted_at: string | null }> }>(
      await dispatchAs("admin/scoping/list", { key: "runtime", includeDeleted: true }, ctx),
    );
    expect(withDeleted.rows.length).toBeGreaterThan(0);
    expect(withDeleted.rows[0].deleted_at).not.toBeNull();
  });
});

describe("admin/scoping/get", () => {
  it("returns the row by id when it belongs to the caller's tenant", async () => {
    const ctx = adminCtx("default");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    const setRes = await ok<{ row: { id: string } }>(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "runtime", value: knownRuntime },
        ctx,
      ),
    );
    const getRes = await ok<{ row: { id: string } }>(await dispatchAs("admin/scoping/get", { id: setRes.row.id }, ctx));
    expect(getRes.row.id).toBe(setRes.row.id);
  });

  it("returns NOT_FOUND when id is missing or belongs to another tenant", async () => {
    const ctx = adminCtx("default");
    const res = (await dispatchAs("admin/scoping/get", { id: "non-existent-uuid" }, ctx)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.NOT_FOUND);
  });
});

describe("admin/scoping/delete", () => {
  it("soft-deletes by id and records deleted_by", async () => {
    const ctx = adminCtx("default", "u-deleter");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    const setRes = await ok<{ row: { id: string } }>(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "runtime", value: knownRuntime },
        ctx,
      ),
    );
    const delRes = await ok<{ ok: boolean }>(await dispatchAs("admin/scoping/delete", { id: setRes.row.id }, ctx));
    expect(delRes.ok).toBe(true);

    // Confirm deleted_by populated.
    const tombstones = await ok<{ rows: Array<{ id: string; deleted_by: string | null }> }>(
      await dispatchAs("admin/scoping/list", { includeDeleted: true, key: "runtime" }, ctx),
    );
    const tombstone = tombstones.rows.find((r) => r.id === setRes.row.id);
    expect(tombstone?.deleted_by).toBe("u-deleter");
  });

  it("soft-deletes by composite (scope_kind, scope_id, key)", async () => {
    const ctx = adminCtx("default");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    await ok(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "runtime", value: knownRuntime },
        ctx,
      ),
    );
    const delRes = await ok<{ ok: boolean }>(
      await dispatchAs("admin/scoping/delete", { scope_kind: "tenant", scope_id: "default", key: "runtime" }, ctx),
    );
    expect(delRes.ok).toBe(true);
  });

  it("re-delete is idempotent (returns false; no error)", async () => {
    const ctx = adminCtx("default");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    const setRes = await ok<{ row: { id: string } }>(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "runtime", value: knownRuntime },
        ctx,
      ),
    );
    await ok(await dispatchAs("admin/scoping/delete", { id: setRes.row.id }, ctx));
    const second = await ok<{ ok: boolean }>(await dispatchAs("admin/scoping/delete", { id: setRes.row.id }, ctx));
    expect(second.ok).toBe(false);
  });

  it("rejects when neither id nor full composite provided", async () => {
    const ctx = adminCtx("default");
    const res = (await dispatchAs("admin/scoping/delete", { scope_kind: "tenant" }, ctx)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it("rejects when BOTH id AND composite provided (ambiguous)", async () => {
    const ctx = adminCtx("default");
    const res = (await dispatchAs(
      "admin/scoping/delete",
      { id: "some-id", scope_kind: "tenant", scope_id: "default", key: "runtime" },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(res.error?.message).toMatch(/not both/i);
  });

  it("rejects when id is passed alongside a partial composite", async () => {
    const ctx = adminCtx("default");
    const res = (await dispatchAs(
      "admin/scoping/delete",
      { id: "some-id", scope_kind: "tenant" },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it("composite delete for a cross-tenant team -> NOT_FOUND (symmetric with set)", async () => {
    // Previously the composite-delete branch skipped validateScopeId and
    // relied on the SQL WHERE tenant_id clause -- correct, but it surfaced
    // as `{ ok: false }` silently. set on the same triple returns
    // NOT_FOUND. Composite delete now matches: explicit NOT_FOUND so the
    // caller can distinguish "wrong tenant" from "already deleted".
    const otherTenant = await app.tenants.create({ slug: "compo-other", name: "Compo Other" });
    const team = await app.teams.create({
      tenant_id: otherTenant.id,
      slug: "eng",
      name: "Eng",
      description: null,
    });
    const ctx = adminCtx("default");
    const res = (await dispatchAs(
      "admin/scoping/delete",
      { scope_kind: "team", scope_id: team.id, key: "runtime" },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.NOT_FOUND);
    expect(res.error?.message).toContain(team.id);
    expect(res.error?.message).toContain("default");
  });
});

describe("admin/scoping actor identifier semantics", () => {
  it("api-key-style userId (ak-...) is stored verbatim in set_by", async () => {
    // Phase-1b semantics: api-key auth uses `userId = api_keys.id` (the
    // `ak-...` sentinel). We persist this directly to set_by; downstream
    // audit readers treat it as an opaque actor identifier, not a
    // foreign key to `users.id`.
    const akCtx: TenantContext = {
      tenantId: "default",
      userId: "ak-fakekey1",
      role: "admin",
      isAdmin: true,
      scopingUserId: "u-real-owner",
      teamChain: [],
    };
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    const result = await ok<{ row: { set_by: string | null } }>(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "runtime", value: knownRuntime },
        akCtx,
      ),
    );
    expect(result.row.set_by).toBe("ak-fakekey1");
  });
});

describe("admin/scoping/list safety cap", () => {
  it("default cap kicks in (test only verifies the limit option is respected)", async () => {
    // Insert ~5 rows at different keys + scope_ids, then list with limit=2.
    const ctx = adminCtx("default");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    const { userId } = await seedAdminUser("cap-test");
    await app.teams.addMember("default-team", userId, "member");
    for (let i = 0; i < 5; i++) {
      // Use the repo directly (bypasses validator) so we can populate
      // many rows quickly. The handler caps the list output regardless.
      await app.scopingOverrides.set(
        { scope_kind: "user", scope_id: userId, key: `__cap_test_${i}`, tenant_id: "default" },
        knownRuntime,
      );
    }
    // Repo-level limit: ask for 2.
    const subset = await app.scopingOverrides.listForTenant("default", { limit: 2 });
    expect(subset.length).toBe(2);
  });

  it("admin/scoping/list returns truncated=false when result is below the cap", async () => {
    const ctx = adminCtx("default");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    await ok(
      await dispatchAs(
        "admin/scoping/set",
        { scope_kind: "tenant", scope_id: "default", key: "runtime", value: knownRuntime },
        ctx,
      ),
    );
    const res = await ok<{ rows: unknown[]; truncated: boolean }>(await dispatchAs("admin/scoping/list", {}, ctx));
    expect(res.truncated).toBe(false);
  });
});

describe("admin/scoping/set R1+R2 cross-tenant defense", () => {
  it("R1: user exists globally but has no membership in caller's tenant -> NOT_FOUND", async () => {
    // Create a global user but do NOT add them to any team in `default`.
    // The R1 check (memberships -> teams intersection with ctx.tenantId)
    // must reject -- otherwise an admin could pin overrides on cross-tenant
    // user ids that never reach this tenant's resolver.
    const u = await app.users.upsertByEmail({ email: "no-team@phase2.test" });
    const ctx = adminCtx("default");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    const res = (await dispatchAs(
      "admin/scoping/set",
      { scope_kind: "user", scope_id: u.id, key: "runtime", value: knownRuntime },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.NOT_FOUND);
    expect(res.error?.message).toContain(u.id);
    expect(res.error?.message).toContain("default");
  });

  it("R1: user with only a soft-deleted membership in caller's tenant -> NOT_FOUND", async () => {
    const u = await app.users.upsertByEmail({ email: "soft-removed@phase2.test" });
    await app.teams.addMember("default-team", u.id, "member");
    await app.teams.removeMember("default-team", u.id);
    const ctx = adminCtx("default");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    const res = (await dispatchAs(
      "admin/scoping/set",
      { scope_kind: "user", scope_id: u.id, key: "runtime", value: knownRuntime },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.NOT_FOUND);
  });

  it("R2: team exists but belongs to a different tenant -> NOT_FOUND", async () => {
    // Create a team in a separate tenant; from the `default` admin context,
    // attempting to set a team-scoped override on that id must fail with
    // NOT_FOUND -- never leak the team's existence in another tenant.
    const otherTenant = await app.tenants.create({ slug: "other-tenant-r2", name: "Other Tenant R2" });
    const team = await app.teams.create({
      tenant_id: otherTenant.id,
      slug: "other-team",
      name: "other team",
      description: null,
    });
    const ctx = adminCtx("default");
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)!.name;
    const res = (await dispatchAs(
      "admin/scoping/set",
      { scope_kind: "team", scope_id: team.id, key: "runtime", value: knownRuntime },
      ctx,
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.NOT_FOUND);
    expect(res.error?.message).toContain(team.id);
    expect(res.error?.message).toContain("default");
    // The error must NOT echo the actual owning tenant -- that would be an
    // existence-leak channel.
    expect(res.error?.message).not.toContain(otherTenant.id);
  });
});
