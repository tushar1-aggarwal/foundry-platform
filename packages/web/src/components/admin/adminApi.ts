/**
 * Typed wrappers for the `admin/*` JSON-RPC methods.
 *
 * Kept separate from `useApi.ts` so adding admin RPCs doesn't churn the main
 * API surface. Exposed as a `useAdminApi()` hook that reads the transport
 * from context -- identical pattern to `useApi()` so tests can swap the
 * underlying transport per render scope.
 */

import { useMemo } from "react";
import { useTransport } from "../../transport/TransportContext.js";
import type { WebTransport } from "../../transport/types.js";
import type {
  Tenant,
  Team,
  User,
  Membership,
  MembershipRole,
  MembershipWithTeamTenant,
  ScopingOverrideRow,
  ScopeKind,
  SkillhubSkillRow,
  SkillhubVersionRow,
  TenantSearchUser,
  TenantUserRow,
} from "./types.js";

/**
 * Build an admin-API client over an arbitrary transport. Exposed for unit
 * tests; production callers use the `useAdminApi()` hook below, which
 * memoises the client against the React context's transport instance.
 */
export function makeAdminApi(transport: WebTransport) {
  const rpc = <T>(method: string, params?: Record<string, unknown>): Promise<T> => transport.rpc<T>(method, params);

  return {
    // Tenants
    listTenants: () => rpc<{ tenants: Tenant[] }>("admin/tenant/list").then((r) => r.tenants),
    createTenant: (body: { slug: string; name: string }) =>
      rpc<{ tenant: Tenant }>("admin/tenant/create", body).then((r) => r.tenant),
    updateTenant: (id: string, patch: Partial<Pick<Tenant, "slug" | "name" | "status">>) =>
      rpc<{ tenant: Tenant }>("admin/tenant/update", { id, ...patch }).then((r) => r.tenant),
    deleteTenant: (id: string) => rpc<{ ok: boolean }>("admin/tenant/delete", { id }).then((r) => r.ok),
    setTenantStatus: (id: string, status: Tenant["status"]) =>
      rpc<{ tenant: Tenant }>("admin/tenant/set-status", { id, status }).then((r) => r.tenant),

    /**
     * Tenant-anchored user roll-up. Returns distinct users with ≥1 live
     * membership in any live team of the tenant; each row carries their
     * per-team memberships within this tenant. Read-only view.
     */
    listTenantUsers: (tenantId: string) =>
      rpc<{ users: TenantUserRow[] }>("admin/tenant/users", { tenant_id: tenantId }).then((r) => r.users),

    // Teams
    listTeams: (tenantId: string) =>
      rpc<{ teams: Team[] }>("admin/team/list", { tenant_id: tenantId }).then((r) => r.teams),
    createTeam: (body: { tenant_id: string; slug: string; name: string; description?: string | null }) =>
      rpc<{ team: Team }>("admin/team/create", body).then((r) => r.team),
    updateTeam: (id: string, patch: Partial<Pick<Team, "slug" | "name" | "description">>) =>
      rpc<{ team: Team }>("admin/team/update", { id, ...patch }).then((r) => r.team),
    deleteTeam: (id: string) => rpc<{ ok: boolean }>("admin/team/delete", { id }).then((r) => r.ok),

    // Team members
    listMembers: (teamId: string) =>
      rpc<{ members: Membership[] }>("admin/team/members/list", { team_id: teamId }).then((r) => r.members),

    /**
     * Tenant-scoped autocomplete for the TeamsTab "Add member" combobox.
     * Pass `team_id` (resolved to tenant server-side) and a query string;
     * the server enforces a 3-char minimum and returns up to `limit`
     * results (default 20, server hard cap 50). Each row carries the
     * user's existing role in the context team or `null`.
     */
    searchTeamCandidates: (teamId: string, q: string, limit?: number) =>
      rpc<{ results: TenantSearchUser[] }>("admin/team/members/search", {
        team_id: teamId,
        q,
        ...(limit !== undefined ? { limit } : {}),
      }).then((r) => r.results),
    addMember: (teamId: string, email: string, role: MembershipRole) =>
      rpc<{ membership: Membership }>("admin/team/members/add", {
        team_id: teamId,
        email,
        role,
      }).then((r) => r.membership),
    removeMember: (teamId: string, email: string) =>
      rpc<{ ok: boolean }>("admin/team/members/remove", { team_id: teamId, email }).then((r) => r.ok),
    setMemberRole: (teamId: string, email: string, role: MembershipRole) =>
      rpc<{ membership: Membership }>("admin/team/members/set-role", {
        team_id: teamId,
        email,
        role,
      }).then((r) => r.membership),

    // Users
    listUsers: () => rpc<{ users: User[] }>("admin/user/list").then((r) => r.users),
    createUser: (body: { email: string; name?: string | null }) =>
      rpc<{ user: User }>("admin/user/create", body).then((r) => r.user),
    deleteUser: (id: string) => rpc<{ ok: boolean }>("admin/user/delete", { id }).then((r) => r.ok),

    /**
     * Per-user membership listing for the UsersTab memberships drawer.
     * Returns live memberships joined with team + tenant identity, in
     * one round trip. Throws if the user does not exist.
     */
    listUserMemberships: (userId: string) =>
      rpc<{ memberships: MembershipWithTeamTenant[] }>("admin/user/memberships", { user_id: userId }).then(
        (r) => r.memberships,
      ),

    // Scoping overrides (admin/scoping/*)
    //
    // Read path returns `{ rows, truncated }` -- the safety cap on the
    // server is 1000 rows, surfaced via a probe-limit-plus-one pattern,
    // and the truncated flag drives the "narrow your filter" banner in
    // the UI. There is no plain `scopingList` here on purpose: every
    // current consumer wants the truncation signal.
    scopingListPage: (
      filters: { scope_kind?: ScopeKind; scope_id?: string; key?: string; includeDeleted?: boolean } = {},
    ) =>
      rpc<{ rows: ScopingOverrideRow[]; truncated: boolean }>("admin/scoping/list", filters as Record<string, unknown>),

    scopingGet: (id: string) => rpc<{ row: ScopingOverrideRow }>("admin/scoping/get", { id }).then((r) => r.row),

    scopingSet: (opts: { scope_kind: ScopeKind; scope_id: string; key: string; value: unknown }) =>
      rpc<{ row: ScopingOverrideRow }>("admin/scoping/set", opts as unknown as Record<string, unknown>).then(
        (r) => r.row,
      ),

    // Soft-delete. Accepts EITHER `{ id }` (preferred from the UI) OR the
    // full composite `(scope_kind, scope_id, key)`; the server rejects
    // ambiguous combinations (both, or partial composite).
    scopingDelete: (opts: { id: string } | { scope_kind: ScopeKind; scope_id: string; key: string }) =>
      rpc<{ ok: boolean }>("admin/scoping/delete", opts as Record<string, unknown>).then((r) => r.ok),

    // Skill Hub (admin/skillhub/*)
    //
    // The dashboard's SkillsTab is read-only in v1: cross-team list +
    // audit drawer reading version_history. Delete reuses the
    // non-admin `skillhub/delete` since that handler is already
    // visibility-aware (admins pass the team/tenant-scope gates).
    // Edit / create flows go through the CLI (`ark skills put`) - too
    // complex a UI surface for v1's optional dashboard scope.
    skillhubListAll: () => rpc<{ skills: SkillhubSkillRow[] }>("admin/skillhub/list").then((r) => r.skills),

    skillhubVersionHistory: (skillId: string) =>
      rpc<{ versions: SkillhubVersionRow[] }>("admin/skillhub/version_history", { skill_id: skillId }).then(
        (r) => r.versions,
      ),

    skillhubDelete: (id: string) => rpc<{ ok: boolean }>("skillhub/delete", { id }).then((r) => r.ok),
  };
}

export type AdminApiClient = ReturnType<typeof makeAdminApi>;

/**
 * React hook returning the admin-API client bound to the current transport.
 * Memoised on transport identity -- a swap (production -> test) returns a
 * fresh instance so cached queries observe the correct routing.
 */
export function useAdminApi(): AdminApiClient {
  const transport = useTransport();
  return useMemo(() => makeAdminApi(transport), [transport]);
}
