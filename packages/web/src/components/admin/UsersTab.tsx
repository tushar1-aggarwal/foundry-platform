import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button.js";
import { useAdminApi } from "./adminApi.js";
import { useOptionalAuth } from "../../auth/AuthContext.js";
import { UserMembershipsDrawer } from "./UserMembershipsDrawer.js";
import type { MembershipRole, Team, User } from "./types.js";

interface UsersTabProps {
  onToast?: (msg: string, type: string) => void;
}

const ROLES: MembershipRole[] = ["owner", "admin", "member", "viewer"];

export function UsersTab({ onToast }: UsersTabProps) {
  const adminApi = useAdminApi();
  const auth = useOptionalAuth();
  const callerTenantId = auth?.identity?.tenantId ?? "";

  const [users, setUsers] = useState<User[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  // Row-click opens the memberships drawer; null = no drawer open.
  const [drawerUser, setDrawerUser] = useState<User | null>(null);

  // Team + role are REQUIRED at create time. Under the tenant-admin
  // model the tenant is fixed to the caller's, so we don't pick it;
  // the form just loads teams in `callerTenantId`. Orphan users (no
  // membership) can't log in and don't serve any admin workflow, so
  // we refuse to mint them from this form. Schema-level orphans can
  // still arise from cascade soft-deletes or JIT-signup races --
  // those are handled by the Users-tab row "Add to team" action.
  const [teamsInTenant, setTeamsInTenant] = useState<Team[]>([]);
  const assignTenantId = callerTenantId;
  const [assignTeamId, setAssignTeamId] = useState<string>("");
  const [assignRole, setAssignRole] = useState<MembershipRole>("member");

  const refresh = useCallback(async () => {
    try {
      setUsers(await adminApi.listUsers());
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }, [adminApi, onToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Load teams in the caller's tenant when the form opens. The tenant
  // never changes within a session (tenant-admin model), so a single
  // load is sufficient.
  useEffect(() => {
    if (!showNew || !assignTenantId) return;
    adminApi
      .listTeams(assignTenantId)
      .then(setTeamsInTenant)
      .catch(() => setTeamsInTenant([]));
  }, [showNew, assignTenantId, adminApi]);

  // `assignTenantId` is `callerTenantId` (const), so it's always
  // truthy when an admin is signed in -- only `email` and `assignTeamId`
  // need to gate submit.
  const canSubmit = useMemo(() => Boolean(email.trim() && assignTeamId), [email, assignTeamId]);

  function resetForm() {
    setShowNew(false);
    setEmail("");
    setName("");
    setAssignTeamId("");
    setAssignRole("member");
  }

  async function handleCreate() {
    if (!canSubmit) return;
    try {
      // Server-side `admin/team/members/add` accepts an email and
      // internally upserts the user, but does NOT carry the `name`
      // field through -- so we always createUser first to capture
      // the name, then addMember to attach the membership.
      const u = await adminApi.createUser({ email: email.trim(), name: name.trim() || null });
      try {
        await adminApi.addMember(assignTeamId, email.trim(), assignRole);
        const team = teamsInTenant.find((t) => t.id === assignTeamId);
        onToast?.(`User '${u.email}' created and added to ${team?.name ?? assignTeamId} as ${assignRole}`, "success");
      } catch (memErr: any) {
        // Partial-failure: user row exists but membership add threw.
        // Leave the orphan in place so the admin can retry attachment
        // via the row "Add to team" action without re-typing the name.
        onToast?.(`User '${u.email}' created but failed to add to team: ${memErr?.message ?? memErr}`, "error");
        await refresh();
        return;
      }
      resetForm();
      await refresh();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  async function handleDelete(u: User) {
    if (!confirm(`Delete user '${u.email}'? This cascades their memberships.`)) return;
    try {
      await adminApi.deleteUser(u.id);
      onToast?.(`User '${u.email}' deleted`, "success");
      await refresh();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">Users</h2>
          <div className="text-[12px] text-[var(--fg-muted)]">Durable identities keyed by email.</div>
        </div>
        <Button size="sm" onClick={() => setShowNew(true)}>
          + New User
        </Button>
      </div>
      {showNew && (
        <div className="p-3 border border-[var(--border)] rounded mb-4 space-y-3 bg-[var(--bg-subtle)]">
          <input
            className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
            placeholder="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
            placeholder="name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <div className="border-t border-[var(--border)] pt-3 space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">Initial team assignment</div>
            {/* Tenant dropdown removed: the tenant-admin model fixes
                the tenant to the caller's. The form pre-selects
                `assignTenantId = callerTenantId` so the existing team
                dropdown loads correctly. */}
            <div className="grid grid-cols-2 gap-2">
              <select
                aria-label="Team"
                className="h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
                value={assignTeamId}
                onChange={(e) => setAssignTeamId(e.target.value)}
              >
                <option value="">-- team --</option>
                {teamsInTenant.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Role"
                className="h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
                value={assignRole}
                onChange={(e) => setAssignRole(e.target.value as MembershipRole)}
                disabled={!assignTeamId}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-2">
            <Button size="xs" onClick={handleCreate} disabled={!canSubmit}>
              Create
            </Button>
            <Button size="xs" variant="ghost" onClick={resetForm}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {users.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-[var(--fg-muted)] text-left border-b border-[var(--border)]">
              <th className="py-2">ID</th>
              <th className="py-2">Email</th>
              <th className="py-2">Name</th>
              <th className="py-2">Memberships</th>
              <th className="py-2">Created</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr
                key={u.id}
                className="border-b border-[var(--border)] cursor-pointer hover:bg-[var(--bg-subtle)]"
                onClick={() => setDrawerUser(u)}
              >
                <td className="py-2 text-[var(--fg-muted)]">{u.id}</td>
                <td className="py-2">{u.email}</td>
                <td className="py-2">{u.name ?? ""}</td>
                <td className="py-2 text-[12px]">
                  {/* `team_count === undefined` here means the server is
                      pre-enrichment (e.g. an older daemon). Render the
                      empty cell rather than the warning badge so we
                      don't alarm operators about a backward-compat gap. */}
                  {u.team_count === undefined ? (
                    ""
                  ) : u.team_count > 0 ? (
                    <span className="text-[var(--fg)]">
                      {u.team_count} {u.team_count === 1 ? "team" : "teams"}
                    </span>
                  ) : (
                    <span
                      className="rounded border border-[var(--border)] bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--fg-muted)]"
                      title="This user has no live memberships in this tenant. They may exist in other tenants you do not have visibility into."
                    >
                      ⚠ no memberships
                    </span>
                  )}
                </td>
                <td className="py-2 text-[var(--fg-muted)]">{u.created_at}</td>
                <td className="py-2 text-right">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={(e) => {
                      // Row has its own click handler that opens the
                      // drawer; stop propagation so clicking Delete
                      // doesn't also open the drawer for the row that
                      // is being deleted.
                      e.stopPropagation();
                      handleDelete(u);
                    }}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="text-[12px] text-[var(--fg-muted)]">No users yet.</div>
      )}
      <UserMembershipsDrawer user={drawerUser} onClose={() => setDrawerUser(null)} onToast={onToast} />
    </div>
  );
}
