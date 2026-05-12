/**
 * Type contracts for the dashboard's admin tabs.
 *
 * Two flavours of types live here:
 *
 * 1. Server-side row shapes that the `admin/*` JSON-RPC methods return.
 *    These are intentionally redeclared in the web (rather than imported
 *    from `@ark/core`) so the web bundle never pulls server code through
 *    its dependency graph. The shapes mirror `packages/core/repositories/{tenants,
 *    teams,users,memberships}.ts` and must stay in sync if the server-side
 *    rows evolve. There is no automated cross-package check today; a
 *    future hygiene PR can move these into `packages/protocol` if the
 *    drift risk gets real.
 *
 * 2. Wire-typed shapes from `@ark/protocol/clients/admin-team` that the
 *    server already exports authoritatively (`ScopingOverrideRow`). These
 *    are re-exported so the rest of the web admin code imports everything
 *    from one place.
 *
 * Until this file existed, all four admin tabs imported from `./types.js`
 * with no matching file on disk; Vite + esbuild stripped the `import type`
 * lines at build, so the bundle worked but IDE TS support was broken
 * across `TenantsTab.tsx`, `TeamsTab.tsx`, `UsersTab.tsx`, `adminApi.ts`,
 * and any tooling-driven refactor had no anchor.
 */

// ── Re-exports from the protocol wire contract ─────────────────────────────

export type { ScopingOverrideRow } from "../../../../protocol/clients/admin-team.js";

// ── Tenant ─────────────────────────────────────────────────────────────────

export type TenantStatus = "active" | "suspended" | "archived";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

// ── Team ───────────────────────────────────────────────────────────────────

export interface Team {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

// ── User ───────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  /**
   * Server-enriched on `admin/user/list`: the number of distinct live
   * teams the user belongs to within the caller's tenant. `0` is shown
   * as "no memberships in this tenant" -- the UI deliberately does not
   * distinguish between a global orphan and a member of another tenant.
   */
  team_count?: number;
}

// ── Membership ─────────────────────────────────────────────────────────────

export type MembershipRole = "owner" | "admin" | "member" | "viewer";

export interface Membership {
  id: string;
  user_id: string;
  team_id: string;
  role: MembershipRole;
  /** Joined from `users` -- present on `admin/team/members/list` rows. */
  email: string;
  /** Joined from `users` -- present on `admin/team/members/list` rows. */
  name: string | null;
  created_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

// ── Per-user membership view ───────────────────────────────────────────────

/**
 * One row in the UsersTab memberships drawer: a membership joined with
 * its team's slug+name and the tenant the team belongs to. Live rows
 * only (membership, team, and tenant all live). The user is implicit
 * (the drawer is anchored on one user), so email/name are NOT carried
 * here -- the wire shape mirrors `MembershipWithTeamTenant` on the
 * server, which extends `MembershipRow` (no joined user columns).
 */
export interface MembershipWithTeamTenant {
  id: string;
  user_id: string;
  team_id: string;
  role: MembershipRole;
  team_slug: string;
  team_name: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  created_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

// ── Tenant users roll-up ───────────────────────────────────────────────────

/**
 * One row in the TenantsTab "Users in this tenant" section. Distinct
 * users with ≥1 live membership in any live team of the tenant; each
 * row carries the user's per-team memberships within this tenant.
 */
export interface TenantUserRow {
  id: string;
  email: string;
  name: string | null;
  memberships: Array<{ team_id: string; team_slug: string; team_name: string; role: MembershipRole }>;
}

// ── Tenant-scoped user search ──────────────────────────────────────────────

/**
 * One row returned by `admin/team/members/search`.
 *
 * - `existing_role` is the user's live role in the context team (`null`
 *   if not in that team).
 * - `other_memberships` lists their live memberships in the SAME tenant
 *   excluding the context team. Memberships in other tenants are NOT
 *   exposed.
 * - `orphan` is true iff the user has zero live memberships anywhere;
 *   orphans are still surfaced in search results so admins can re-attach.
 */
export interface TenantSearchUser {
  id: string;
  email: string;
  name: string | null;
  existing_role: MembershipRole | null;
  other_memberships: Array<{ team_id: string; team_name: string; role: MembershipRole }>;
  orphan: boolean;
}

// ── Scoping override scope kind ────────────────────────────────────────────

/**
 * Mirrors the server's `ScopeKind` (declared inline on each protocol
 * `admin-team` method signature). String-literal union: kept here so the
 * web's scoping UI can switch on the kind without dragging `@ark/core`
 * into the web's import graph.
 */
export type ScopeKind = "user" | "team" | "tenant";
