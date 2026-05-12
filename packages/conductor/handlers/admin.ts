/**
 * Admin RPC handlers -- tenants, teams, users, memberships.
 *
 * Every method in this namespace requires the caller to be an admin.
 * The router materializes `ctx: TenantContext` on every request:
 *
 *   - Local / single-user profile (`requireToken: false`): ctx.isAdmin is
 *     true, so `requireAdmin(ctx)` is a no-op and these handlers behave
 *     identically to the rest of the surface.
 *   - Hosted / control-plane profile (`requireToken: true`): ctx.isAdmin
 *     reflects the bearer token's role. Non-admin tokens (or missing
 *     tokens) resolve to an anonymous context and every method below
 *     throws FORBIDDEN.
 *
 * Namespace contract:
 *   admin/tenant/*   CRUD + status
 *   admin/team/*     CRUD + member management
 *   admin/user/*     CRUD
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { requireAdmin, requireSameTenant } from "../../core/auth/context.js";
import type { MembershipRole, TenantStatus } from "../../core/auth/index.js";

export function registerAdminHandlers(router: Router, app: AppContext): void {
  // Auth managers are singletons in the DI container -- resolve via
  // the AppContext accessors instead of `new X(app.db)` on every request.
  const tenants = () => app.tenants;
  const teams = () => app.teams;
  const users = () => app.users;

  // ── Tenants ───────────────────────────────────────────────────────────

  // Tenant-admin model: a tenant admin only sees their own tenant.
  // The list returns at most one row (or empty if the caller's tenant
  // somehow doesn't exist -- which would only happen with a stale
  // bearer token after a tenant delete). System-admin tier deferred.
  router.handle("admin/tenant/list", async (_p, _notify, ctx) => {
    requireAdmin(ctx);
    const tenant = await tenants().get(ctx.tenantId);
    return { tenants: tenant ? [tenant] : [] };
  });

  router.handle("admin/tenant/get", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    requireSameTenant(ctx, id);
    const tenant = await tenants().get(id);
    if (!tenant) throw new RpcError(`Tenant '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { tenant };
  });

  // Tenant creation is a system-admin operation. No tenant admin can
  // mint a new tenant; we keep the route registered so older CLIs get
  // a useful FORBIDDEN instead of NOT_FOUND, but the operation is
  // unavailable until a system-admin role exists.
  router.handle("admin/tenant/create", async (_p, _notify, ctx) => {
    requireAdmin(ctx);
    throw new RpcError(
      "tenant creation requires system-admin role; unavailable in the tenant-admin model",
      ErrorCodes.FORBIDDEN,
    );
  });

  router.handle("admin/tenant/update", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id, slug, name, status } = extract<{
      id: string;
      slug?: string;
      name?: string;
      status?: TenantStatus;
    }>(p, ["id"]);
    requireSameTenant(ctx, id);
    const tenant = await tenants().update(id, { slug, name, status });
    if (!tenant) throw new RpcError(`Tenant '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { tenant };
  });

  router.handle("admin/tenant/set-status", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id, status } = extract<{ id: string; status: TenantStatus }>(p, ["id", "status"]);
    requireSameTenant(ctx, id);
    const tenant = await tenants().setStatus(id, status);
    if (!tenant) throw new RpcError(`Tenant '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { tenant };
  });

  router.handle("admin/tenant/delete", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    requireSameTenant(ctx, id);
    const ok = await tenants().delete(id, ctx.userId ?? null);
    return { ok };
  });

  // Tenant-anchored user roll-up for the TenantsTab. Read-only --
  // mutation surface stays on TeamsTab + UsersTab. Returns distinct
  // users with ≥1 live membership in any live team of the tenant.
  router.handle("admin/tenant/users", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id } = extract<{ tenant_id: string }>(p, ["tenant_id"]);
    // Tenant-admin model: an admin in tenant A cannot roll-up users in
    // tenant B. The check fires before the resource fetch so we don't
    // leak existence ("not found" vs "forbidden") of cross-tenant ids.
    requireSameTenant(ctx, tenant_id);
    const tenant = await tenants().get(tenant_id);
    if (!tenant) throw new RpcError(`Tenant '${tenant_id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { users: await users().listTenantUsers(tenant_id) };
  });

  // ── Teams ─────────────────────────────────────────────────────────────

  router.handle("admin/team/list", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id } = extract<{ tenant_id: string }>(p, ["tenant_id"]);
    requireSameTenant(ctx, tenant_id);
    return { teams: await teams().listByTenant(tenant_id) };
  });

  router.handle("admin/team/get", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const team = await teams().get(id);
    if (!team) throw new RpcError(`Team '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    requireSameTenant(ctx, team.tenant_id);
    return { team };
  });

  router.handle("admin/team/create", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id, slug, name, description } = extract<{
      tenant_id: string;
      slug: string;
      name: string;
      description?: string | null;
    }>(p, ["tenant_id", "slug", "name"]);
    requireSameTenant(ctx, tenant_id);
    const tenant = await tenants().get(tenant_id);
    if (!tenant) throw new RpcError(`Tenant '${tenant_id}' not found`, ErrorCodes.INVALID_PARAMS);
    try {
      const team = await teams().create({ tenant_id, slug, name, description });
      return { team };
    } catch (e: any) {
      throw new RpcError(e?.message ?? "Failed to create team", ErrorCodes.INVALID_PARAMS);
    }
  });

  router.handle("admin/team/update", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id, slug, name, description } = extract<{
      id: string;
      slug?: string;
      name?: string;
      description?: string | null;
    }>(p, ["id"]);
    const existing = await teams().get(id);
    if (!existing) throw new RpcError(`Team '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    requireSameTenant(ctx, existing.tenant_id);
    const team = await teams().update(id, { slug, name, description });
    if (!team) throw new RpcError(`Team '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { team };
  });

  router.handle("admin/team/delete", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const existing = await teams().get(id);
    if (!existing) throw new RpcError(`Team '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    requireSameTenant(ctx, existing.tenant_id);
    const ok = await teams().delete(id, ctx.userId ?? null);
    return { ok };
  });

  // ── Team members ─────────────────────────────────────────────────────

  router.handle("admin/team/members/list", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { team_id } = extract<{ team_id: string }>(p, ["team_id"]);
    const team = await teams().get(team_id);
    if (!team) throw new RpcError(`Team '${team_id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    requireSameTenant(ctx, team.tenant_id);
    return { members: await teams().listMembers(team_id) };
  });

  // Tenant-scoped autocomplete used by the TeamsTab "Add member" combobox.
  // The team_id anchors the search to a tenant (we resolve team -> tenant
  // here so the client doesn't have to track tenant_id separately) and the
  // result rows carry each user's existing role in this team (if any) so
  // the UI can tag "already member (admin)" and flip its Add/Update-role
  // button. Min-length (3 chars) and hard limit (50) are enforced in the
  // UserManager; the handler is a thin wrapper.
  router.handle("admin/team/members/search", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { team_id, q, limit } = extract<{ team_id: string; q: string; limit?: number }>(p, ["team_id", "q"]);
    const team = await teams().get(team_id);
    if (!team) throw new RpcError(`Team '${team_id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    // Tenant-admin model: the team being searched must belong to the
    // caller's tenant. This blocks an admin in tenant A from
    // autocompleting tenant B's user emails by guessing a team_id.
    requireSameTenant(ctx, team.tenant_id);
    const results = await users().searchByTenant(team.tenant_id, q, { contextTeamId: team_id, limit });
    return { results };
  });

  router.handle("admin/team/members/add", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { team_id, user_id, email, role } = extract<{
      team_id: string;
      user_id?: string;
      email?: string;
      role?: MembershipRole;
    }>(p, ["team_id"]);
    const team = await teams().get(team_id);
    if (!team) throw new RpcError(`Team '${team_id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    requireSameTenant(ctx, team.tenant_id);

    let resolvedUserId = user_id ?? null;
    if (!resolvedUserId) {
      if (!email) {
        throw new RpcError("admin/team/members/add requires user_id or email", ErrorCodes.INVALID_PARAMS);
      }
      const user = await users().upsertByEmail({ email });
      resolvedUserId = user.id;
    }

    const membership = await teams().addMember(team_id, resolvedUserId, role ?? "member");
    return { membership };
  });

  router.handle("admin/team/members/remove", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { team_id, user_id, email } = extract<{ team_id: string; user_id?: string; email?: string }>(p, ["team_id"]);
    const team = await teams().get(team_id);
    if (!team) throw new RpcError(`Team '${team_id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    requireSameTenant(ctx, team.tenant_id);
    let resolvedUserId = user_id ?? null;
    if (!resolvedUserId && email) {
      const user = await users().get(email);
      if (!user) return { ok: false };
      resolvedUserId = user.id;
    }
    if (!resolvedUserId) {
      throw new RpcError("admin/team/members/remove requires user_id or email", ErrorCodes.INVALID_PARAMS);
    }
    const ok = await teams().removeMember(team_id, resolvedUserId, ctx.userId ?? null);
    return { ok };
  });

  router.handle("admin/team/members/set-role", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { team_id, user_id, email, role } = extract<{
      team_id: string;
      user_id?: string;
      email?: string;
      role: MembershipRole;
    }>(p, ["team_id", "role"]);
    const team = await teams().get(team_id);
    if (!team) throw new RpcError(`Team '${team_id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    requireSameTenant(ctx, team.tenant_id);
    let resolvedUserId = user_id ?? null;
    if (!resolvedUserId && email) {
      const user = await users().get(email);
      if (!user) throw new RpcError(`User with email '${email}' not found`, ErrorCodes.SESSION_NOT_FOUND);
      resolvedUserId = user.id;
    }
    if (!resolvedUserId) {
      throw new RpcError("admin/team/members/set-role requires user_id or email", ErrorCodes.INVALID_PARAMS);
    }
    const membership = await teams().setRole(team_id, resolvedUserId, role);
    if (!membership) throw new RpcError("Membership not found", ErrorCodes.SESSION_NOT_FOUND);
    return { membership };
  });

  // ── Users ─────────────────────────────────────────────────────────────

  // Tenant-admin model: returns users in the caller's tenant + global
  // orphans (zero memberships anywhere). Each row carries `team_count`
  // scoped to ctx.tenantId. Users that live only in other tenants are
  // filtered out at the repo so the response never leaks their email
  // or id across tenants.
  router.handle("admin/user/list", async (_p, _notify, ctx) => {
    requireAdmin(ctx);
    return { users: await users().listInTenantOrOrphanWithTeamCount(ctx.tenantId) };
  });

  // Tenant-admin visibility rule: a user is visible iff (in caller's
  // tenant) OR (global orphan). Cross-tenant-only users 404 with the
  // same message as a missing user so existence does not leak.
  router.handle("admin/user/get", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const user = await users().get(id);
    if (!user) throw new RpcError(`User '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    const stats = await users().tenantMembershipStats(id, ctx.tenantId);
    const isOrphanGlobal = stats.in_tenant === 0 && stats.out_of_tenant === 0;
    if (stats.in_tenant === 0 && !isOrphanGlobal) {
      // Lives only in other tenants -- same 404 shape as missing user.
      throw new RpcError(`User '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    }
    return { user };
  });

  // Creates a global user identity. Intentionally NOT tenant-gated:
  // the resulting user has no cross-tenant access by themselves; any
  // tenant grant happens through admin/team/members/add which IS
  // gated. The dashboard requires team assignment when creating
  // through the UI, so the orphan-from-this-path case is rare.
  router.handle("admin/user/create", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { email, name } = extract<{ email: string; name?: string | null }>(p, ["email"]);
    try {
      const user = await users().create({ email, name });
      return { user };
    } catch (e: any) {
      throw new RpcError(e?.message ?? "Failed to create user", ErrorCodes.INVALID_PARAMS);
    }
  });

  // Per-user membership listing for the UsersTab memberships drawer.
  // Joins memberships with teams + tenants so the drawer can render the
  // full (tenant, team, role) shape in one round trip. Live rows only.
  //
  // Tenant-admin visibility rule (matches admin/user/get): a user is
  // visible iff they have ≥1 membership in caller's tenant OR are a
  // global orphan. Cross-tenant-only users 404 with the same message
  // as a missing user so the (404, 200+empty) oracle cannot be used
  // to distinguish "doesn't exist anywhere" from "exists in another
  // tenant". Results are filtered to ctx.tenantId so a multi-tenant
  // user's other-tenant rows stay invisible.
  router.handle("admin/user/memberships", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { user_id } = extract<{ user_id: string }>(p, ["user_id"]);
    const user = await users().get(user_id);
    if (!user) throw new RpcError(`User '${user_id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    const stats = await users().tenantMembershipStats(user_id, ctx.tenantId);
    if (stats.in_tenant === 0 && stats.out_of_tenant > 0) {
      throw new RpcError(`User '${user_id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    }
    return { memberships: await users().listMemberships(user_id, { tenantId: ctx.tenantId }) };
  });

  // Tenant-admin model: upsert is allowed for new identities and for
  // identities already visible to the caller (in-tenant + global
  // orphans). It is NOT allowed to update a cross-tenant-only user's
  // `name` -- that would graffiti the global identity column visible
  // to the other tenant's admin. Same 404 mirror as admin/user/get so
  // existence does not leak.
  router.handle("admin/user/upsert", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { email, name } = extract<{ email: string; name?: string | null }>(p, ["email"]);
    const existing = await users().get(email);
    if (existing) {
      const stats = await users().tenantMembershipStats(existing.id, ctx.tenantId);
      const isOrphanGlobal = stats.in_tenant === 0 && stats.out_of_tenant === 0;
      if (stats.in_tenant === 0 && !isOrphanGlobal) {
        throw new RpcError(`User with email '${email}' not found`, ErrorCodes.SESSION_NOT_FOUND);
      }
    }
    const user = await users().upsertByEmail({ email, name });
    return { user };
  });

  // Tenant-admin deletion rule: refuse if the user has memberships in
  // any tenant outside the caller's. Cascade-soft-delete touches every
  // membership of the user; letting tenant A's admin trigger that would
  // damage tenant B's audit trail. To remove a user from THIS tenant
  // only, the admin should use admin/team/members/remove on each team
  // membership instead.
  //
  // Known TOCTOU window: `tenantMembershipStats` reads at one moment,
  // `users().delete()` runs later. A tenant-B membership added by tenant-B's
  // admin in the window between the two would be cascade-soft-deleted by
  // tenant A's admin. The window is sub-second and requires concurrent
  // cross-tenant writes; acceptable risk for now. If this becomes a real
  // concern, gate the cascade on a per-user version column.
  router.handle("admin/user/delete", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const user = await users().get(id);
    if (!user) throw new RpcError(`User '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    const stats = await users().tenantMembershipStats(id, ctx.tenantId);
    const isOrphanGlobal = stats.in_tenant === 0 && stats.out_of_tenant === 0;
    if (stats.in_tenant === 0 && !isOrphanGlobal) {
      // Visibility check first: cross-tenant-only users 404, matching
      // admin/user/get so existence doesn't leak through the delete path.
      throw new RpcError(`User '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    }
    if (stats.out_of_tenant > 0) {
      throw new RpcError(
        "user has live memberships in other tenants; remove them from your tenant's teams via admin/team/members/remove instead",
        ErrorCodes.FORBIDDEN,
      );
    }
    const ok = await users().delete(id, ctx.userId ?? null);
    return { ok };
  });

  // admin/apikey/* handlers live in handlers/admin-apikey.ts -- the single
  // source of truth for API key CRUD + soft-delete. `register.ts` mounts it
  // separately via `registerAdminApiKeyHandlers`.
}
