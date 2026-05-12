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

  router.handle("admin/tenant/list", async (_p, _notify, ctx) => {
    requireAdmin(ctx);
    return { tenants: await tenants().list() };
  });

  router.handle("admin/tenant/get", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const tenant = await tenants().get(id);
    if (!tenant) throw new RpcError(`Tenant '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { tenant };
  });

  router.handle("admin/tenant/create", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { slug, name, status } = extract<{ slug: string; name: string; status?: TenantStatus }>(p, ["slug", "name"]);
    try {
      const tenant = await tenants().create({ slug, name, status });
      return { tenant };
    } catch (e: any) {
      throw new RpcError(e?.message ?? "Failed to create tenant", ErrorCodes.INVALID_PARAMS);
    }
  });

  router.handle("admin/tenant/update", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id, slug, name, status } = extract<{
      id: string;
      slug?: string;
      name?: string;
      status?: TenantStatus;
    }>(p, ["id"]);
    const tenant = await tenants().update(id, { slug, name, status });
    if (!tenant) throw new RpcError(`Tenant '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { tenant };
  });

  router.handle("admin/tenant/set-status", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id, status } = extract<{ id: string; status: TenantStatus }>(p, ["id", "status"]);
    const tenant = await tenants().setStatus(id, status);
    if (!tenant) throw new RpcError(`Tenant '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { tenant };
  });

  router.handle("admin/tenant/delete", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
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
    return { teams: await teams().listByTenant(tenant_id) };
  });

  router.handle("admin/team/get", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const team = await teams().get(id);
    if (!team) throw new RpcError(`Team '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
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
    const team = await teams().update(id, { slug, name, description });
    if (!team) throw new RpcError(`Team '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { team };
  });

  router.handle("admin/team/delete", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const ok = await teams().delete(id, ctx.userId ?? null);
    return { ok };
  });

  // ── Team members ─────────────────────────────────────────────────────

  router.handle("admin/team/members/list", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { team_id } = extract<{ team_id: string }>(p, ["team_id"]);
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

  // Returns every user with a `team_count` annotated against the
  // caller's tenant. The count is "live teams in ctx.tenantId the
  // user belongs to". 0 means "no membership in this tenant" -- the
  // UI surfaces that as the orphan / cross-tenant badge.
  router.handle("admin/user/list", async (_p, _notify, ctx) => {
    requireAdmin(ctx);
    return { users: await users().listWithTenantTeamCount(ctx.tenantId) };
  });

  router.handle("admin/user/get", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const user = await users().get(id);
    if (!user) throw new RpcError(`User '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { user };
  });

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
  // Tenant-admin model: results are filtered to ctx.tenantId so an
  // admin in tenant A never sees tenant-B memberships of the same user
  // (preserves the consultant pattern at the data layer while keeping
  // each admin's view scoped to their own tenant). Returning [] for a
  // user with no membership in the caller's tenant is the safe default;
  // it does NOT leak whether the user exists elsewhere.
  router.handle("admin/user/memberships", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { user_id } = extract<{ user_id: string }>(p, ["user_id"]);
    const user = await users().get(user_id);
    if (!user) throw new RpcError(`User '${user_id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { memberships: await users().listMemberships(user_id, { tenantId: ctx.tenantId }) };
  });

  router.handle("admin/user/upsert", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { email, name } = extract<{ email: string; name?: string | null }>(p, ["email"]);
    const user = await users().upsertByEmail({ email, name });
    return { user };
  });

  router.handle("admin/user/delete", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const ok = await users().delete(id, ctx.userId ?? null);
    return { ok };
  });

  // admin/apikey/* handlers live in handlers/admin-apikey.ts -- the single
  // source of truth for API key CRUD + soft-delete. `register.ts` mounts it
  // separately via `registerAdminApiKeyHandlers`.
}
