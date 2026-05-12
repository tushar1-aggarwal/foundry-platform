/**
 * Per-user memberships drawer for the UsersTab.
 *
 * Opens when an admin clicks a user row. Shows every live membership
 * the user holds, joined with team + tenant identity, and lets the
 * admin mutate them in place:
 *
 *   - Per-row role dropdown (calls `admin/team/members/set-role`)
 *   - Per-row Remove button (calls `admin/team/members/remove`)
 *   - "Add to team" inline form: tenant -> team -> role -> Add
 *     (calls `admin/team/members/add`)
 *
 * Both views (this drawer + the TeamsTab member list) mutate the same
 * `memberships` table -- this is the user-centric lens.
 *
 * A11y: mirrors `ScopingAuditDrawer` -- role="dialog" aria-modal="true",
 * focus trap, Escape closes, backdrop click closes, body scroll locked
 * while open. The component renders into a portal; an inner Panel is
 * exported separately so SSR tests can inspect the markup.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/button.js";
import { useFocusTrap } from "../../hooks/useFocusTrap.js";
import { useAdminApi } from "./adminApi.js";
import type { MembershipRole, MembershipWithTeamTenant, Team, Tenant, User } from "./types.js";

const ROLES: MembershipRole[] = ["owner", "admin", "member", "viewer"];

interface UserMembershipsDrawerProps {
  /** When non-null, the drawer is open and shows this user. */
  user: User | null;
  onClose: () => void;
  onToast?: (msg: string, type: string) => void;
}

export function UserMembershipsDrawer({ user, onClose, onToast }: UserMembershipsDrawerProps) {
  if (!user) return null;
  if (typeof document === "undefined") return null;
  return createPortal(<UserMembershipsDrawerPanel user={user} onClose={onClose} onToast={onToast} />, document.body);
}

export function UserMembershipsDrawerPanel({
  user,
  onClose,
  onToast,
}: Required<Pick<UserMembershipsDrawerProps, "user" | "onClose">> & Pick<UserMembershipsDrawerProps, "onToast">) {
  const adminApi = useAdminApi();
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(true, panelRef, onClose);

  const [memberships, setMemberships] = useState<MembershipWithTeamTenant[]>([]);
  const [loading, setLoading] = useState(true);

  // "Add to team" inline form state. Kept local to the drawer so closing
  // and reopening on a different user starts the form clean.
  const [showAdd, setShowAdd] = useState(false);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [teamsInTenant, setTeamsInTenant] = useState<Team[]>([]);
  const [addTenantId, setAddTenantId] = useState("");
  const [addTeamId, setAddTeamId] = useState("");
  const [addRole, setAddRole] = useState<MembershipRole>("member");
  const [busy, setBusy] = useState(false);

  // Lock body scroll while drawer is open; restore on unmount.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setMemberships(await adminApi.listUserMemberships(user.id));
    } catch (e: any) {
      onToast?.(`Failed to load memberships: ${e?.message ?? e}`, "error");
    } finally {
      setLoading(false);
    }
  }, [adminApi, user.id, onToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Load tenants only when the inline form opens.
  useEffect(() => {
    if (!showAdd) return;
    adminApi
      .listTenants()
      .then(setTenants)
      .catch(() => setTenants([]));
  }, [showAdd, adminApi]);

  // When the tenant selection in the inline form changes, reload its
  // teams and reset the team selection.
  useEffect(() => {
    if (!addTenantId) {
      setTeamsInTenant([]);
      setAddTeamId("");
      return;
    }
    adminApi
      .listTeams(addTenantId)
      .then(setTeamsInTenant)
      .catch(() => setTeamsInTenant([]));
    setAddTeamId("");
  }, [addTenantId, adminApi]);

  async function handleRoleChange(m: MembershipWithTeamTenant, role: MembershipRole) {
    setBusy(true);
    try {
      await adminApi.setMemberRole(m.team_id, user.email, role);
      onToast?.(`Role updated to '${role}' in ${m.team_name}`, "success");
      await refresh();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message ?? e}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(m: MembershipWithTeamTenant) {
    if (!confirm(`Remove '${user.email}' from '${m.team_name}' (${m.tenant_name})?`)) return;
    setBusy(true);
    try {
      await adminApi.removeMember(m.team_id, user.email);
      onToast?.(`Removed from ${m.team_name}`, "success");
      await refresh();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message ?? e}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    if (!addTenantId || !addTeamId) return;
    setBusy(true);
    try {
      await adminApi.addMember(addTeamId, user.email, addRole);
      const team = teamsInTenant.find((t) => t.id === addTeamId);
      onToast?.(`Added to ${team?.name ?? addTeamId} as ${addRole}`, "success");
      setShowAdd(false);
      setAddTenantId("");
      setAddTeamId("");
      setAddRole("member");
      await refresh();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message ?? e}`, "error");
    } finally {
      setBusy(false);
    }
  }

  const titleId = `user-memberships-drawer-title-${user.id}`;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-30" onClick={onClose} aria-hidden="true" />
      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed right-0 top-0 bottom-0 w-[480px] max-w-[100vw] bg-[var(--bg)] border-l border-[var(--border)] z-40 flex flex-col"
      >
        <div className="px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">User memberships</div>
              <h2 id={titleId} className="text-base font-semibold truncate">
                {user.email}
              </h2>
              {user.name && <div className="text-[12px] text-[var(--fg-muted)]">{user.name}</div>}
            </div>
            <Button size="xs" variant="ghost" onClick={onClose} aria-label="Close drawer">
              Close
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading ? (
            <div className="text-[12px] text-[var(--fg-muted)]">Loading memberships...</div>
          ) : memberships.length === 0 ? (
            // The drawer is tenant-scoped (server filters memberships
            // to ctx.tenantId). An empty list does NOT mean the user
            // is a global orphan -- they may exist in other tenants
            // we deliberately hide. The copy matches the UsersTab
            // count tooltip so the two surfaces stay consistent.
            <div className="text-[12px] text-[var(--fg-muted)]">
              No memberships in this tenant. This user may exist in other tenants you do not have visibility into.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-[var(--fg-muted)] text-left border-b border-[var(--border)]">
                  <th className="py-2">Tenant</th>
                  <th className="py-2">Team</th>
                  <th className="py-2">Role</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {memberships.map((m) => (
                  <tr key={m.id} className="border-b border-[var(--border)]">
                    <td className="py-2">
                      <div>{m.tenant_name}</div>
                      <div className="text-[11px] text-[var(--fg-muted)]">{m.tenant_slug}</div>
                    </td>
                    <td className="py-2">
                      <div>{m.team_name}</div>
                      <div className="text-[11px] text-[var(--fg-muted)]">{m.team_slug}</div>
                    </td>
                    <td className="py-2">
                      <select
                        aria-label={`Role in ${m.team_name}`}
                        className="h-7 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
                        value={m.role}
                        onChange={(e) => handleRoleChange(m, e.target.value as MembershipRole)}
                        disabled={busy}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 text-right">
                      <Button size="xs" variant="ghost" onClick={() => handleRemove(m)} disabled={busy}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-4 border-t border-[var(--border)]">
          {showAdd ? (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">Add to team</div>
              <div className="grid grid-cols-3 gap-2">
                <select
                  aria-label="Tenant"
                  className="h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
                  value={addTenantId}
                  onChange={(e) => setAddTenantId(e.target.value)}
                >
                  <option value="">-- tenant --</option>
                  {tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Team"
                  className="h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
                  value={addTeamId}
                  onChange={(e) => setAddTeamId(e.target.value)}
                  disabled={!addTenantId}
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
                  value={addRole}
                  onChange={(e) => setAddRole(e.target.value as MembershipRole)}
                  disabled={!addTeamId}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <Button size="xs" onClick={handleAdd} disabled={busy || !addTeamId}>
                  Add
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setShowAdd(false);
                    setAddTenantId("");
                    setAddTeamId("");
                    setAddRole("member");
                  }}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" onClick={() => setShowAdd(true)}>
              + Add to team
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
