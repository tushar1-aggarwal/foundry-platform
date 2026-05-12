import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button.js";
import { useAdminApi } from "./adminApi.js";
import { MemberPicker } from "./MemberPicker.js";
import type { Tenant, Team, Membership, MembershipRole } from "./types.js";

const ROLES: MembershipRole[] = ["owner", "admin", "member", "viewer"];

interface TeamsTabProps {
  onToast?: (msg: string, type: string) => void;
}

export function TeamsTab({ onToast }: TeamsTabProps) {
  const adminApi = useAdminApi();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState<string>("");
  const [teams, setTeams] = useState<Team[]>([]);
  const [selected, setSelected] = useState<Team | null>(null);
  const [members, setMembers] = useState<Membership[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [newTenantId, setNewTenantId] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  useEffect(() => {
    adminApi
      .listTenants()
      .then((ts) => {
        setTenants(ts);
        setTenantId((prev) => (prev ? prev : (ts[0]?.id ?? "")));
      })
      .catch((e) => onToast?.(`Failed: ${e?.message}`, "error"));
  }, [adminApi, onToast]);

  const refreshTeams = useCallback(
    async (tid: string) => {
      if (!tid) {
        setTeams([]);
        return;
      }
      try {
        const rows = await adminApi.listTeams(tid);
        setTeams(rows);
      } catch (e: any) {
        onToast?.(`Failed: ${e?.message}`, "error");
      }
    },
    [adminApi, onToast],
  );

  // Data-only effect. Earlier this also did `setSelected(null)`,
  // which fired whenever `refreshTeams`'s identity changed -- and
  // that identity tracks `onToast`, which flips on every App
  // re-render (daemon poll, theme toggle, etc.). The result was the
  // detail panel closing mid-click. Selection clearing now happens
  // explicitly on the user-action paths.
  useEffect(() => {
    refreshTeams(tenantId);
  }, [tenantId, refreshTeams]);

  const selectedId = selected?.id;
  const refreshMembers = useCallback(async () => {
    if (!selectedId) {
      setMembers([]);
      return;
    }
    try {
      setMembers(await adminApi.listMembers(selectedId));
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }, [adminApi, selectedId, onToast]);

  useEffect(() => {
    refreshMembers();
  }, [refreshMembers]);

  async function handleCreate() {
    // Under the tenant-admin model the form's tenant is fixed to the
    // caller's tenant (the dropdown collapsed to a static row), so
    // `newTenantId === tenantId` always. No cross-tenant-targeted
    // create path remains; we just refresh the team list in place.
    if (!tenantId || !newSlug.trim() || !newName.trim()) return;
    try {
      const team = await adminApi.createTeam({
        tenant_id: tenantId,
        slug: newSlug.trim(),
        name: newName.trim(),
        description: newDesc.trim() || null,
      });
      onToast?.(`Team '${team.slug}' created`, "success");
      setShowNew(false);
      setNewTenantId("");
      setNewSlug("");
      setNewName("");
      setNewDesc("");
      await refreshTeams(tenantId);
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  async function handleDelete(t: Team) {
    if (!confirm(`Delete team '${t.slug}'? This cascades memberships.`)) return;
    try {
      await adminApi.deleteTeam(t.id);
      onToast?.(`Team '${t.slug}' deleted`, "success");
      setSelected(null);
      await refreshTeams(tenantId);
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  async function handleRemove(m: Membership) {
    if (!selected) return;
    if (!confirm(`Remove '${m.email}' from team '${selected.slug}'?`)) return;
    try {
      await adminApi.removeMember(selected.id, m.email);
      onToast?.(`Removed '${m.email}'`, "success");
      await refreshMembers();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  async function handleRoleChange(m: Membership, role: MembershipRole) {
    if (!selected) return;
    try {
      await adminApi.setMemberRole(selected.id, m.email, role);
      onToast?.(`Role updated`, "success");
      await refreshMembers();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message}`, "error");
    }
  }

  return (
    <div className="flex h-full">
      <div className="w-80 border-r border-[var(--border)] overflow-y-auto">
        <div className="p-3 border-b border-[var(--border)] space-y-2">
          {/* Under the tenant-admin model the admin only sees their
              own tenant, so the previous tenant dropdown collapses to
              a static label showing which tenant the rail is anchored
              on. The selected `tenantId` still drives the team query. */}
          <label className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">Tenant</label>
          <div className="h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg-subtle)] flex items-center">
            {tenants.find((t) => t.id === tenantId)?.name ?? <span className="text-[var(--fg-muted)]">Loading...</span>}
          </div>
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">Teams ({teams.length})</div>
            <Button
              size="xs"
              onClick={() => {
                setNewTenantId(tenantId);
                setShowNew(true);
              }}
              disabled={!tenants.length}
            >
              + New
            </Button>
          </div>
        </div>
        {showNew && (
          <div className="p-3 border-b border-[var(--border)] space-y-2 bg-[var(--bg-subtle)]">
            {/* `newTenantId` is set when the form opens (defaults to the
                caller's tenant). We render a static row instead of a
                dropdown since under the tenant-admin model there is only
                one tenant to pick. */}
            <label className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">Tenant</label>
            <div className="h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)] flex items-center">
              {tenants.find((t) => t.id === newTenantId)?.name ?? newTenantId}
            </div>
            <input
              className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
              placeholder="slug"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
            />
            <input
              className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
              placeholder="name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <input
              className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
              placeholder="description (optional)"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="xs" onClick={handleCreate}>
                Create
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setShowNew(false);
                  setNewTenantId("");
                  setNewSlug("");
                  setNewName("");
                  setNewDesc("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        <div>
          {teams.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t)}
              className={
                "w-full text-left p-3 border-b border-[var(--border)] hover:bg-[var(--bg-subtle)]" +
                (selected?.id === t.id ? " bg-[var(--bg-subtle)]" : "")
              }
            >
              <div className="flex items-center gap-1.5">
                <div className="text-sm font-medium">{t.name}</div>
                {t.id === "default-team" && (
                  <span
                    title="System team -- protected from rename and delete because new sign-ups land here."
                    className="rounded border border-[var(--border)] bg-[var(--bg-subtle)] px-1 py-0.5 text-[9px] uppercase tracking-wider text-[var(--fg-muted)]"
                  >
                    🔒
                  </span>
                )}
              </div>
              <div className="text-[11px] text-[var(--fg-muted)]">{t.slug}</div>
            </button>
          ))}
          {!teams.length && <div className="p-4 text-[12px] text-[var(--fg-muted)]">No teams in this tenant.</div>}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {!selected ? (
          <div className="text-[var(--fg-muted)] text-sm">Select a team to manage members.</div>
        ) : (
          <div className="space-y-6">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">Team</div>
              <div className="flex items-center gap-2 mt-1">
                <h2 className="text-xl font-semibold">{selected.name}</h2>
                {selected.id === "default-team" && (
                  <span
                    title="System team -- protected from rename and delete because new sign-ups land here."
                    className="rounded border border-[var(--border)] bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--fg-muted)]"
                  >
                    🔒 system
                  </span>
                )}
              </div>
              <div className="text-sm text-[var(--fg-muted)]">slug: {selected.slug}</div>
              <div className="text-sm text-[var(--fg-muted)]">id: {selected.id}</div>
              {selected.description && <div className="text-sm mt-1">{selected.description}</div>}
            </div>
            {selected.id === "default-team" ? (
              <p className="text-[12px] text-[var(--fg-muted)]">
                Delete is disabled on the <code className="font-mono">default-team</code> team - it is the seeded
                landing destination for new sign-ups and is protected at the server.
              </p>
            ) : (
              <div>
                <Button size="sm" variant="destructive" onClick={() => handleDelete(selected)}>
                  Delete team
                </Button>
              </div>
            )}
            <div>
              <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)] mb-2">
                Members ({members.length})
              </div>
              <MemberPicker teamId={selected.id} onAdded={refreshMembers} onToast={onToast} />
              {members.length ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-[var(--fg-muted)] text-left">
                      <th className="py-1">Email</th>
                      <th className="py-1">Role</th>
                      <th className="py-1">Added</th>
                      <th className="py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.id} className="border-t border-[var(--border)]">
                        <td className="py-2">{m.email}</td>
                        <td className="py-2">
                          <select
                            className="h-7 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
                            value={m.role}
                            onChange={(e) => handleRoleChange(m, e.target.value as MembershipRole)}
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 text-[var(--fg-muted)]">{m.created_at}</td>
                        <td className="py-2 text-right">
                          <Button size="xs" variant="ghost" onClick={() => handleRemove(m)}>
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-[12px] text-[var(--fg-muted)]">No members.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
