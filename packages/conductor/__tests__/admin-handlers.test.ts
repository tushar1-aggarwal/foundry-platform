/**
 * Admin JSON-RPC handler gate tests.
 *
 * Every `admin/*` route must reject non-admin TenantContexts with FORBIDDEN
 * and accept admin contexts. Local / single-user dispatches (no explicit
 * ctx) fall back to the router's local-admin default and should succeed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { Router } from "../router.js";
import { registerAdminHandlers } from "../handlers/admin.js";
import { registerAdminApiKeyHandlers } from "../handlers/admin-apikey.js";
import { createRequest, ErrorCodes, type JsonRpcError, type JsonRpcResponse } from "../../protocol/types.js";
import { anonymousContext, localAdminContext, type TenantContext } from "../../core/auth/context.js";

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
  registerAdminHandlers(router, app);
  // admin/apikey/* lives in its own module now (consolidation of the
  // previously-split handlers). Register it here too so the existing
  // apikey gate tests keep exercising the full surface.
  registerAdminApiKeyHandlers(router, app);
});

function dispatchAs(method: string, params: Record<string, unknown>, ctx: TenantContext) {
  return router.dispatch(createRequest(1, method, params), undefined, ctx);
}

describe("admin/* handler gate", () => {
  it("returns FORBIDDEN for every admin method when ctx is anonymous / non-admin", async () => {
    const anon = anonymousContext();
    const methods: Array<[string, Record<string, unknown>]> = [
      ["admin/tenant/list", {}],
      ["admin/tenant/get", { id: "t-x" }],
      ["admin/tenant/create", { slug: "x", name: "X" }],
      ["admin/tenant/update", { id: "t-x" }],
      ["admin/tenant/set-status", { id: "t-x", status: "active" }],
      ["admin/tenant/delete", { id: "t-x" }],
      ["admin/tenant/users", { tenant_id: "t-x" }],
      ["admin/team/list", { tenant_id: "t-x" }],
      ["admin/team/get", { id: "tm-x" }],
      ["admin/team/create", { tenant_id: "t-x", slug: "s", name: "N" }],
      ["admin/team/update", { id: "tm-x" }],
      ["admin/team/delete", { id: "tm-x" }],
      ["admin/team/members/list", { team_id: "tm-x" }],
      ["admin/team/members/search", { team_id: "tm-x", q: "abc" }],
      ["admin/team/members/add", { team_id: "tm-x", email: "a@b.c" }],
      ["admin/team/members/remove", { team_id: "tm-x", email: "a@b.c" }],
      ["admin/team/members/set-role", { team_id: "tm-x", email: "a@b.c", role: "member" }],
      ["admin/user/list", {}],
      ["admin/user/get", { id: "u-x" }],
      ["admin/user/memberships", { user_id: "u-x" }],
      ["admin/user/create", { email: "a@b.c" }],
      ["admin/user/upsert", { email: "a@b.c" }],
      ["admin/user/delete", { id: "u-x" }],
      ["admin/apikey/list", { tenant_id: "t-x" }],
      ["admin/apikey/delete", { id: "ak-x" }],
      ["admin/apikey/restore", { id: "ak-x" }],
    ];

    for (const [method, params] of methods) {
      const res = (await dispatchAs(method, params, anon)) as JsonRpcError;
      expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
      expect(res.error?.message).toMatch(/admin/i);
    }
  });

  it("admin ctx passes the gate and admin/tenant/list resolves", async () => {
    const admin = localAdminContext(null);
    const res = (await dispatchAs("admin/tenant/list", {}, admin)) as JsonRpcResponse;
    expect(res.result).toBeDefined();
    expect((res.result as Record<string, unknown>).tenants).toBeDefined();
  });

  it("default dispatch (no explicit ctx) uses local-admin and succeeds", async () => {
    // The Router's default ctx falls back to a local-admin context when
    // callers don't thread one through (matches the single-user CLI flow).
    const res = (await router.dispatch(createRequest(1, "admin/tenant/list", {}))) as JsonRpcResponse;
    expect(res.result).toBeDefined();
    expect((res.result as Record<string, unknown>).tenants).toBeDefined();
  });

  it("admin/tenant/delete threads ctx.userId into the deleted_by audit column", async () => {
    // Acceptance test for the ctx-plumbing wave: every admin delete path
    // must capture the caller's user id. We dispatch as an admin context
    // with a specific userId and then peek into the DB to confirm the
    // tombstone carries that id. Restoring the tenant clears both fields.
    const adminAsUser: TenantContext = {
      tenantId: "default",
      userId: "u-auditor-007",
      role: "admin",
      isAdmin: true,
    };

    const create = (await dispatchAs(
      "admin/tenant/create",
      { slug: "audit-plumb-" + Math.random().toString(36).slice(2, 8), name: "Plumb" },
      adminAsUser,
    )) as JsonRpcResponse;
    const tenant = (create.result as any).tenant;

    const del = (await dispatchAs("admin/tenant/delete", { id: tenant.id }, adminAsUser)) as JsonRpcResponse;
    expect((del.result as any).ok).toBe(true);

    const row = (await app.db.prepare("SELECT deleted_at, deleted_by FROM tenants WHERE id = ?").get(tenant.id)) as
      | { deleted_at: string | null; deleted_by: string | null }
      | undefined;
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.deleted_by).toBe("u-auditor-007");
  });

  it("admin/apikey/delete soft-deletes the key and records ctx.userId", async () => {
    // The key row should survive (soft-delete), validate() should no
    // longer match it, and the deleted_by column should hold the admin's
    // user id. Restore should reverse both.
    const adminAsUser: TenantContext = {
      tenantId: "tenant-ak",
      userId: "u-admin-ak",
      role: "admin",
      isAdmin: true,
    };

    const { key, id } = await app.apiKeys.create("tenant-ak", "to-soft-delete", "member");
    expect(await app.apiKeys.validate(key)).not.toBeNull();

    const res = (await dispatchAs(
      "admin/apikey/delete",
      { id, tenant_id: "tenant-ak" },
      adminAsUser,
    )) as JsonRpcResponse;
    expect((res.result as any).ok).toBe(true);

    expect(await app.apiKeys.validate(key)).toBeNull();

    const row = (await app.db.prepare("SELECT deleted_at, deleted_by FROM api_keys WHERE id = ?").get(id)) as
      | { deleted_at: string | null; deleted_by: string | null }
      | undefined;
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.deleted_by).toBe("u-admin-ak");

    // Restore un-soft-deletes and clears both fields.
    const restored = (await dispatchAs(
      "admin/apikey/restore",
      { id, tenant_id: "tenant-ak" },
      adminAsUser,
    )) as JsonRpcResponse;
    expect((restored.result as any).ok).toBe(true);
    const after = (await app.db.prepare("SELECT deleted_at, deleted_by FROM api_keys WHERE id = ?").get(id)) as
      | { deleted_at: string | null; deleted_by: string | null }
      | undefined;
    expect(after?.deleted_at).toBeNull();
    expect(after?.deleted_by).toBeNull();
  });

  it("admin/tenant/create with a member-role ctx returns FORBIDDEN", async () => {
    const memberCtx: TenantContext = {
      tenantId: "t-member",
      userId: "u-member",
      role: "member",
      isAdmin: false,
    };
    const res = (await dispatchAs("admin/tenant/create", { slug: "abc", name: "Acme" }, memberCtx)) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
  });

  describe("admin/team/members/search", () => {
    // Fixture exercises every branch the UI cares about:
    //   - tenant-scoping hides the outsider (lives only in another tenant)
    //   - LIKE pattern matches across email and name
    //   - existing_role is annotated for the context team
    //   - other_memberships lists OTHER teams in same tenant (not context team)
    //   - orphan users (no memberships anywhere) are surfaced with orphan=true
    //   - 3-char minimum is enforced
    //   - cross-tenant access is rejected (requireSameTenant guard)
    const sfx = Math.random().toString(36).slice(2, 8);
    let tenantId: string;
    let outsideTenantId: string;
    let team1Id: string;
    let team2Id: string;
    let outsideTeamId: string;
    // Per-tenant admin contexts. The endpoint now enforces
    // requireSameTenant(ctx, team.tenant_id), so happy-path tests must
    // dispatch as an admin in the team's own tenant.
    let adminInTenant: TenantContext;
    let adminInOutside: TenantContext;

    beforeAll(async () => {
      const t1 = await app.tenants.create({ slug: `srch-${sfx}`, name: "Search Co" });
      tenantId = t1.id;
      const t2 = await app.tenants.create({ slug: `out-${sfx}`, name: "Outside Co" });
      outsideTenantId = t2.id;
      const tm1 = await app.teams.create({ tenant_id: tenantId, slug: "alpha", name: "Alpha" });
      team1Id = tm1.id;
      const tm2 = await app.teams.create({ tenant_id: tenantId, slug: "beta", name: "Beta" });
      team2Id = tm2.id;
      const tm3 = await app.teams.create({ tenant_id: outsideTenantId, slug: "gamma", name: "Gamma" });
      outsideTeamId = tm3.id;

      const both = await app.users.upsertByEmail({ email: `bothmember-${sfx}@example.com`, name: "Both Member" });
      const onlyOne = await app.users.upsertByEmail({ email: `onlyone-${sfx}@example.com`, name: "Only One" });
      const outsider = await app.users.upsertByEmail({ email: `outsider-${sfx}@example.com`, name: "Outsider" });
      // An orphan user matching the suffix -- should still surface in
      // search with orphan=true, so admins can re-attach.
      await app.users.upsertByEmail({ email: `orphanone-${sfx}@example.com`, name: "Orphan One" });

      await app.teams.addMember(team1Id, both.id, "admin");
      await app.teams.addMember(team2Id, both.id, "member");
      await app.teams.addMember(team1Id, onlyOne.id, "viewer");
      await app.teams.addMember(tm3.id, outsider.id, "member");

      adminInTenant = localAdminContext(tenantId);
      adminInOutside = localAdminContext(outsideTenantId);
    });

    it("returns members of the team's tenant + orphans, annotated with existing_role for the context team", async () => {
      const res = (await dispatchAs(
        "admin/team/members/search",
        { team_id: team1Id, q: sfx },
        adminInTenant,
      )) as JsonRpcResponse;
      const results = (res.result as any).results as Array<{
        id: string;
        email: string;
        name: string | null;
        existing_role: string | null;
        other_memberships: Array<{ team_id: string; team_name: string; role: string }>;
        orphan: boolean;
      }>;

      // Both team-1 members + the orphan come back; the outsider does NOT.
      const emails = results.map((r) => r.email).sort();
      expect(emails).toEqual([
        `bothmember-${sfx}@example.com`,
        `onlyone-${sfx}@example.com`,
        `orphanone-${sfx}@example.com`,
      ]);

      const both = results.find((r) => r.email === `bothmember-${sfx}@example.com`)!;
      const onlyOne = results.find((r) => r.email === `onlyone-${sfx}@example.com`)!;
      const orphan = results.find((r) => r.email === `orphanone-${sfx}@example.com`)!;
      expect(both.existing_role).toBe("admin");
      expect(both.orphan).toBe(false);
      // `both` is also in team-2 (same tenant) -- that should appear in
      // other_memberships, NOT in existing_role.
      expect(both.other_memberships.map((om) => om.team_name)).toEqual(["Beta"]);
      expect(both.other_memberships[0].role).toBe("member");

      expect(onlyOne.existing_role).toBe("viewer");
      expect(onlyOne.other_memberships).toEqual([]);

      expect(orphan.existing_role).toBeNull();
      expect(orphan.other_memberships).toEqual([]);
      expect(orphan.orphan).toBe(true);
    });

    it("uses the context team's tenant -- searching from team-2 also surfaces both team-1 and team-2 members", async () => {
      const res = (await dispatchAs(
        "admin/team/members/search",
        { team_id: team2Id, q: sfx },
        adminInTenant,
      )) as JsonRpcResponse;
      const results = (res.result as any).results as Array<{
        email: string;
        existing_role: string | null;
        other_memberships: Array<{ team_name: string; role: string }>;
      }>;
      const both = results.find((r) => r.email === `bothmember-${sfx}@example.com`)!;
      const onlyOne = results.find((r) => r.email === `onlyone-${sfx}@example.com`)!;
      expect(both.existing_role).toBe("member");
      // From team-2's vantage, team-1 membership lives in other_memberships.
      expect(both.other_memberships.map((om) => om.team_name)).toEqual(["Alpha"]);
      expect(onlyOne.existing_role).toBeNull();
      expect(onlyOne.other_memberships.map((om) => om.team_name)).toEqual(["Alpha"]);
    });

    it("returns [] for queries shorter than 3 chars (enforced server-side)", async () => {
      const res = (await dispatchAs(
        "admin/team/members/search",
        { team_id: team1Id, q: "ab" },
        adminInTenant,
      )) as JsonRpcResponse;
      expect((res.result as any).results).toEqual([]);
    });

    it("matches against the name column too (not just email)", async () => {
      const res = (await dispatchAs(
        "admin/team/members/search",
        { team_id: team1Id, q: "Both Mem" },
        adminInTenant,
      )) as JsonRpcResponse;
      const results = (res.result as any).results as Array<{ email: string }>;
      expect(results.some((r) => r.email === `bothmember-${sfx}@example.com`)).toBe(true);
    });

    it("404s when the team_id does not exist", async () => {
      // The team lookup fires before requireSameTenant, so a missing
      // id surfaces as SESSION_NOT_FOUND regardless of ctx tenant.
      const res = (await dispatchAs(
        "admin/team/members/search",
        { team_id: "tm-nonexistent", q: "abc" },
        adminInTenant,
      )) as JsonRpcError;
      expect(res.error?.code).toBe(ErrorCodes.SESSION_NOT_FOUND);
    });

    it("FORBIDDEN when the team belongs to a different tenant (tenant-admin guard)", async () => {
      // Admin authenticated in tenantId tries to search team-3 (which
      // lives in outsideTenantId). Under the tenant-admin model this
      // must be rejected -- admins must not autocomplete user data
      // outside their own tenant.
      const res = (await dispatchAs(
        "admin/team/members/search",
        { team_id: outsideTeamId, q: sfx },
        adminInTenant,
      )) as JsonRpcError;
      expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
      expect(res.error?.message).toMatch(/different tenant/i);
    });

    it("admin in the resource's tenant sees the same team via the search path", async () => {
      // Symmetry check: an admin in outsideTenantId CAN search team-3.
      // Pairs with the FORBIDDEN test to confirm the guard is direction-aware,
      // not a blanket reject.
      const res = (await dispatchAs(
        "admin/team/members/search",
        { team_id: outsideTeamId, q: sfx },
        adminInOutside,
      )) as JsonRpcResponse;
      const results = (res.result as any).results as Array<{ email: string }>;
      expect(results.some((r) => r.email === `outsider-${sfx}@example.com`)).toBe(true);
    });
  });

  describe("admin/user/memberships", () => {
    // The drawer needs the user's memberships joined with team + tenant
    // identity, with live rows only. The endpoint filters results to
    // ctx.tenantId so an admin in tenant A never sees the user's
    // memberships in tenant B (preserves the multi-tenant consultant
    // pattern at the data layer while keeping each admin's view tight).
    const sfx = Math.random().toString(36).slice(2, 8);
    let memTenantId: string;
    let otherTenantId: string;
    let userBoth: string;
    let userOrphan: string;
    let userCrossTenant: string;
    let adminInMem: TenantContext;
    let adminInOther: TenantContext;

    beforeAll(async () => {
      const t = await app.tenants.create({ slug: `mem-${sfx}`, name: "Mem Co" });
      memTenantId = t.id;
      const other = await app.tenants.create({ slug: `memother-${sfx}`, name: "Mem Other" });
      otherTenantId = other.id;
      const tm1 = await app.teams.create({ tenant_id: memTenantId, slug: "eng", name: "Engineering" });
      const tm2 = await app.teams.create({ tenant_id: memTenantId, slug: "data", name: "Data" });
      const tm3 = await app.teams.create({ tenant_id: otherTenantId, slug: "engother", name: "Eng Other" });
      const u1 = await app.users.upsertByEmail({ email: `multi-${sfx}@x.com`, name: "Multi" });
      const u2 = await app.users.upsertByEmail({ email: `orphan-${sfx}@x.com`, name: "Orphan" });
      // Cross-tenant user: memberships in BOTH tenants. The filter must
      // hide one tenant's membership from the other tenant's admin.
      const u3 = await app.users.upsertByEmail({ email: `consultant-${sfx}@x.com`, name: "Consultant" });
      userBoth = u1.id;
      userOrphan = u2.id;
      userCrossTenant = u3.id;
      await app.teams.addMember(tm1.id, userBoth, "admin");
      await app.teams.addMember(tm2.id, userBoth, "member");
      await app.teams.addMember(tm1.id, userCrossTenant, "viewer");
      await app.teams.addMember(tm3.id, userCrossTenant, "owner");
      adminInMem = localAdminContext(memTenantId);
      adminInOther = localAdminContext(otherTenantId);
    });

    it("returns live memberships joined with team + tenant identity, filtered to ctx.tenantId", async () => {
      const res = (await dispatchAs("admin/user/memberships", { user_id: userBoth }, adminInMem)) as JsonRpcResponse;
      const memberships = (res.result as any).memberships as Array<{
        team_name: string;
        tenant_name: string;
        role: string;
      }>;
      expect(memberships.length).toBe(2);
      const teamNames = memberships.map((m) => m.team_name).sort();
      expect(teamNames).toEqual(["Data", "Engineering"]);
      // Tenant join: same tenant for both rows.
      expect(new Set(memberships.map((m) => m.tenant_name))).toEqual(new Set(["Mem Co"]));
    });

    it("hides cross-tenant memberships -- admin in tenant A sees only the user's tenant-A rows", async () => {
      // Consultant has memberships in both memTenant (viewer) and
      // otherTenant (owner). Each admin sees only their own tenant's row.
      const resMem = (await dispatchAs(
        "admin/user/memberships",
        { user_id: userCrossTenant },
        adminInMem,
      )) as JsonRpcResponse;
      const fromMem = (resMem.result as any).memberships as Array<{ tenant_name: string; role: string }>;
      expect(fromMem.length).toBe(1);
      expect(fromMem[0]).toMatchObject({ tenant_name: "Mem Co", role: "viewer" });

      const resOther = (await dispatchAs(
        "admin/user/memberships",
        { user_id: userCrossTenant },
        adminInOther,
      )) as JsonRpcResponse;
      const fromOther = (resOther.result as any).memberships as Array<{ tenant_name: string; role: string }>;
      expect(fromOther.length).toBe(1);
      expect(fromOther[0]).toMatchObject({ tenant_name: "Mem Other", role: "owner" });
    });

    it("returns [] for an orphan user (no memberships)", async () => {
      const res = (await dispatchAs("admin/user/memberships", { user_id: userOrphan }, adminInMem)) as JsonRpcResponse;
      expect((res.result as any).memberships).toEqual([]);
    });

    it("returns [] when the user exists but has no memberships in the caller's tenant", async () => {
      // userBoth is fully in memTenant; an admin in otherTenant calling
      // memberships for them sees an empty list -- NOT a 404 (the user
      // really does exist; the endpoint is tenant-scoped, not
      // existence-scoped).
      const res = (await dispatchAs("admin/user/memberships", { user_id: userBoth }, adminInOther)) as JsonRpcResponse;
      expect((res.result as any).memberships).toEqual([]);
    });

    it("404s when the user_id does not exist", async () => {
      const res = (await dispatchAs(
        "admin/user/memberships",
        { user_id: "u-nonexistent" },
        adminInMem,
      )) as JsonRpcError;
      expect(res.error?.code).toBe(ErrorCodes.SESSION_NOT_FOUND);
    });
  });

  describe("admin/tenant/users", () => {
    // Tenant roll-up: distinct users with ≥1 live membership in any
    // live team of the tenant. Orphans and cross-tenant users are
    // intentionally excluded (this is a directory of "who's in this
    // tenant", not a search). Endpoint enforces requireSameTenant so
    // an admin in tenant A cannot enumerate tenant B's users.
    const sfx = Math.random().toString(36).slice(2, 8);
    let tenantId: string;
    let otherTenantId: string;
    let adminInTenant: TenantContext;

    beforeAll(async () => {
      const t = await app.tenants.create({ slug: `tu-${sfx}`, name: "Tu Co" });
      tenantId = t.id;
      const otherT = await app.tenants.create({ slug: `tuother-${sfx}`, name: "Other Co" });
      otherTenantId = otherT.id;
      const tm1 = await app.teams.create({ tenant_id: tenantId, slug: "eng", name: "Eng" });
      const tm2 = await app.teams.create({ tenant_id: tenantId, slug: "ops", name: "Ops" });
      const tm3 = await app.teams.create({ tenant_id: otherT.id, slug: "out", name: "Out" });

      const dual = await app.users.upsertByEmail({ email: `dual-${sfx}@x.com`, name: "Dual" });
      const single = await app.users.upsertByEmail({ email: `single-${sfx}@x.com`, name: "Single" });
      const elsewhere = await app.users.upsertByEmail({ email: `elsewhere-${sfx}@x.com`, name: "Elsewhere" });
      await app.users.upsertByEmail({ email: `orphtu-${sfx}@x.com`, name: "Orphan" });

      await app.teams.addMember(tm1.id, dual.id, "admin");
      await app.teams.addMember(tm2.id, dual.id, "member");
      await app.teams.addMember(tm1.id, single.id, "viewer");
      await app.teams.addMember(tm3.id, elsewhere.id, "member");
      // orphan: deliberately no addMember

      adminInTenant = localAdminContext(tenantId);
    });

    it("returns distinct users in the tenant with their per-team memberships", async () => {
      const res = (await dispatchAs("admin/tenant/users", { tenant_id: tenantId }, adminInTenant)) as JsonRpcResponse;
      const result = (res.result as any).users as Array<{
        email: string;
        memberships: Array<{ team_name: string; role: string }>;
      }>;
      const ours = result.filter((u) => u.email.endsWith(`${sfx}@x.com`));
      const emails = ours.map((u) => u.email).sort();
      // Dual + single are in this tenant; elsewhere lives in another
      // tenant; orphan has no memberships. Only the first two appear.
      expect(emails).toEqual([`dual-${sfx}@x.com`, `single-${sfx}@x.com`]);
      const dual = ours.find((u) => u.email === `dual-${sfx}@x.com`)!;
      // Dual has TWO memberships in this tenant -- both rows should be
      // grouped under the single dual row.
      expect(dual.memberships.map((m) => m.team_name).sort()).toEqual(["Eng", "Ops"]);
    });

    it("FORBIDDEN when tenant_id mismatches ctx.tenantId (tenant-admin guard)", async () => {
      // requireSameTenant fires before the resource lookup, so a
      // mismatched tenant_id never reaches the .get() call. This is
      // intentional -- existence of a tenant must not leak across
      // admins. An admin in `tenantId` asking for `otherTenantId`
      // (which DOES exist) gets FORBIDDEN; one asking for a fake id
      // also gets FORBIDDEN. Both paths return the same message, so
      // the response itself doesn't leak existence either.
      const resReal = (await dispatchAs(
        "admin/tenant/users",
        { tenant_id: otherTenantId },
        adminInTenant,
      )) as JsonRpcError;
      expect(resReal.error?.code).toBe(ErrorCodes.FORBIDDEN);
      const resFake = (await dispatchAs(
        "admin/tenant/users",
        { tenant_id: "t-nonexistent" },
        adminInTenant,
      )) as JsonRpcError;
      expect(resFake.error?.code).toBe(ErrorCodes.FORBIDDEN);
    });
  });

  describe("admin/user/list (team_count enrichment)", () => {
    // The Memberships column on UsersTab depends on the list endpoint
    // returning `team_count` per user, scoped to ctx.tenantId. A user
    // who's only in another tenant should show team_count=0 from this
    // tenant's perspective, NOT a 404 -- they exist, they just aren't
    // here.
    const sfx = Math.random().toString(36).slice(2, 8);
    let listTenantId: string;
    let elsewhereTenantId: string;
    let userInTenantId: string;
    let userElsewhereId: string;
    let userMultiId: string;
    let userOrphanId: string;
    let adminInListTenant: TenantContext;

    beforeAll(async () => {
      const t = await app.tenants.create({ slug: `ul-${sfx}`, name: "List Co" });
      listTenantId = t.id;
      const other = await app.tenants.create({ slug: `ulother-${sfx}`, name: "List Other" });
      elsewhereTenantId = other.id;
      const tm1 = await app.teams.create({ tenant_id: listTenantId, slug: "tm1", name: "T1" });
      const tm2 = await app.teams.create({ tenant_id: listTenantId, slug: "tm2", name: "T2" });
      const tm3 = await app.teams.create({ tenant_id: elsewhereTenantId, slug: "tm3", name: "T3" });

      const inT = await app.users.upsertByEmail({ email: `inlist-${sfx}@x.com`, name: "In" });
      const elsewhere = await app.users.upsertByEmail({ email: `elsewhere-list-${sfx}@x.com`, name: "Elsewhere" });
      const multi = await app.users.upsertByEmail({ email: `multilist-${sfx}@x.com`, name: "Multi" });
      const orphan = await app.users.upsertByEmail({ email: `orphlist-${sfx}@x.com`, name: "Orphan" });
      userInTenantId = inT.id;
      userElsewhereId = elsewhere.id;
      userMultiId = multi.id;
      userOrphanId = orphan.id;

      // In-tenant user: one team in listTenant.
      await app.teams.addMember(tm1.id, inT.id, "admin");
      // Elsewhere user: one team in elsewhereTenant only.
      await app.teams.addMember(tm3.id, elsewhere.id, "member");
      // Multi user: two teams in listTenant + one in elsewhereTenant.
      await app.teams.addMember(tm1.id, multi.id, "member");
      await app.teams.addMember(tm2.id, multi.id, "viewer");
      await app.teams.addMember(tm3.id, multi.id, "owner");
      // Orphan: zero memberships.

      adminInListTenant = localAdminContext(listTenantId);
    });

    it("annotates each user with team_count scoped to ctx.tenantId", async () => {
      const res = (await dispatchAs("admin/user/list", {}, adminInListTenant)) as JsonRpcResponse;
      const all = (res.result as any).users as Array<{ id: string; team_count: number }>;
      const byId = new Map(all.map((u) => [u.id, u.team_count]));

      // In-tenant user: one team in this tenant.
      expect(byId.get(userInTenantId)).toBe(1);
      // Multi user: two teams in this tenant (third is in elsewhere,
      // must NOT be counted from this tenant's vantage).
      expect(byId.get(userMultiId)).toBe(2);
      // Elsewhere-only user: zero in this tenant.
      expect(byId.get(userElsewhereId)).toBe(0);
      // Orphan: zero everywhere.
      expect(byId.get(userOrphanId)).toBe(0);
    });

    it("same user yields a different team_count when listed from another tenant's vantage", async () => {
      const adminElsewhere = localAdminContext(elsewhereTenantId);
      const res = (await dispatchAs("admin/user/list", {}, adminElsewhere)) as JsonRpcResponse;
      const all = (res.result as any).users as Array<{ id: string; team_count: number }>;
      const byId = new Map(all.map((u) => [u.id, u.team_count]));
      // From elsewhere's vantage: multi has 1 team here (was 2 from list-tenant);
      // elsewhere user has 1 (was 0 from list-tenant); inT has 0 (was 1).
      expect(byId.get(userMultiId)).toBe(1);
      expect(byId.get(userElsewhereId)).toBe(1);
      expect(byId.get(userInTenantId)).toBe(0);
    });
  });
});
