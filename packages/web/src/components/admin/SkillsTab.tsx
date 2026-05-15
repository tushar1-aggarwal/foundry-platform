/**
 * Skill Hub admin tab.
 *
 * Read-only listing of every team-scope + tenant-scope skill in the
 * caller's tenant (user-scope skills follow the user across tenants
 * and are excluded by admin/skillhub/list - see server-side handler).
 * Row click opens the audit drawer showing skill metadata + version
 * history from skill_versions (with merge_input_json provenance for
 * client-side LLM-merged versions per RFC §7).
 *
 * Delete is supported (admin gate enforced server-side); edit + create
 * go through the CLI's `ark skills put` rather than landing a dashboard
 * form for v1's optional scope.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminApi } from "./adminApi.js";
import { SkillsAuditDrawer } from "./SkillsAuditDrawer.js";
import type { SkillhubSkillRow, SkillhubVisibility } from "./types.js";

interface SkillsTabProps {
  onToast?: (msg: string, type: string) => void;
}

export type SkillsFetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "data"; rows: SkillhubSkillRow[] };

export function SkillsTab({ onToast }: SkillsTabProps) {
  const adminApi = useAdminApi();
  const [state, setState] = useState<SkillsFetchState>({ kind: "idle" });
  const [selected, setSelected] = useState<SkillhubSkillRow | null>(null);
  // Tracks the currently active fetch so unmount / re-fetch can discard
  // late-arriving responses (parity with SkillsAuditDrawerPanel).
  const cancelledRef = useRef<{ cancelled: boolean } | null>(null);

  const refresh = useCallback(async () => {
    if (cancelledRef.current) cancelledRef.current.cancelled = true;
    const token = { cancelled: false };
    cancelledRef.current = token;
    setState({ kind: "loading" });
    try {
      const rows = await adminApi.skillhubListAll();
      if (token.cancelled) return;
      // Newest first reads naturally for an audit-shaped view.
      // Copy before sort so we don't mutate the array returned from the API.
      const sorted = [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      setState({ kind: "data", rows: sorted });
    } catch (err: unknown) {
      if (token.cancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message });
    }
  }, [adminApi]);

  useEffect(() => {
    void refresh();
    return () => {
      if (cancelledRef.current) cancelledRef.current.cancelled = true;
    };
  }, [refresh]);

  const handleDelete = useCallback(
    async (row: SkillhubSkillRow) => {
      const yes = window.confirm(
        `Delete skill "${row.name}" (${row.id})?\n\nServer-side record is soft-deleted; version history is preserved for audit.`,
      );
      if (!yes) return;
      try {
        await adminApi.skillhubDelete(row.id);
        onToast?.(`Deleted ${row.name}`, "success");
        setSelected(null);
        await refresh();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        onToast?.(`Delete failed: ${message}`, "error");
      }
    },
    [adminApi, onToast, refresh],
  );

  return (
    <div className="flex h-full flex-col">
      <SkillsTabBody state={state} onRetry={refresh} onRowClick={setSelected} />
      <SkillsAuditDrawer row={selected} onClose={() => setSelected(null)} onDelete={handleDelete} />
    </div>
  );
}

// ── body (loading / error / empty / data) ─────────────────────────────────

export function SkillsTabBody({
  state,
  onRetry,
  onRowClick,
}: {
  state: SkillsFetchState;
  onRetry: () => void;
  onRowClick?: (row: SkillhubSkillRow) => void;
}) {
  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <div className="flex-1 overflow-y-auto p-4">
        <div className="text-[12px] text-[var(--fg-muted)]" role="status">
          Loading skills...
        </div>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex-1 overflow-y-auto p-4">
        <div role="alert" className="rounded border border-red-700/40 bg-red-900/10 p-3 text-[12px] text-red-200">
          <div className="mb-2">Failed to load skills: {state.message}</div>
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-red-700/40 px-2 py-0.5 text-[11px] text-red-100 hover:bg-red-900/20"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (state.rows.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="text-[12px] text-[var(--fg-muted)]">
          No skills in this tenant yet. Create one via the CLI: <code>ark skills put .claude/skills/&lt;name&gt;</code>.
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="overflow-x-auto">
        <SkillsTable rows={state.rows} onRowClick={onRowClick} />
      </div>
    </div>
  );
}

function SkillsTable({ rows, onRowClick }: { rows: SkillhubSkillRow[]; onRowClick?: (row: SkillhubSkillRow) => void }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">
          <th className="px-2 py-1">Name</th>
          <th className="px-2 py-1">Visibility</th>
          <th className="px-2 py-1">Team</th>
          <th className="px-2 py-1">Hash</th>
          <th className="px-2 py-1">Updated</th>
          <th className="px-2 py-1">Updated by</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            className={
              "border-t border-[var(--border)] " + (onRowClick ? "cursor-pointer hover:bg-[var(--bg-subtle)]" : "")
            }
            onClick={() => onRowClick?.(row)}
          >
            <td className="px-2 py-1">
              <div className="font-mono text-[12px]">{row.name}</div>
              <div className="text-[11px] text-[var(--fg-muted)]">{row.description}</div>
            </td>
            <td className="px-2 py-1">
              <VisibilityBadge value={row.visibility} />
            </td>
            <td className="px-2 py-1 font-mono text-[11px] text-[var(--fg-muted)]">{row.team_id ?? "-"}</td>
            <td className="px-2 py-1 font-mono text-[11px] text-[var(--fg-muted)]" title={row.current_hash}>
              {row.current_hash.slice(0, 12)}...
            </td>
            <td className="px-2 py-1 text-[11px] text-[var(--fg-muted)]">{formatTimestamp(row.updated_at)}</td>
            <td className="px-2 py-1 font-mono text-[11px] text-[var(--fg-muted)]">{row.updated_by ?? "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VisibilityBadge({ value }: { value: SkillhubVisibility }) {
  const styles: Record<SkillhubVisibility, string> = {
    user: "bg-cyan-900/30 text-cyan-300",
    team: "bg-blue-900/30 text-blue-300",
    tenant: "bg-purple-900/30 text-purple-300",
    cross_tenant: "bg-yellow-900/30 text-yellow-300",
  };
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] uppercase ${styles[value]}`}>{value}</span>;
}

function formatTimestamp(iso: string): string {
  // Match the Scoping audit drawer's stable slice-based formatting -
  // SSR-safe + tooling-deterministic. (No `new Date()` so test
  // fixtures don't diverge from production rendering across TZs.)
  return iso.slice(0, 19).replace("T", " ");
}
