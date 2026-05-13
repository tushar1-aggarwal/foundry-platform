/**
 * Scoping Overrides admin tab -- read path.
 *
 * Lists `scoping_overrides` rows for the calling tenant with chip-group
 * filters (scope_kind, key) plus an "include deleted" toggle. Mirrors
 * the data shape of `admin/scoping/list` and the safety cap behaviour
 * surfaced by the server's `truncated` flag.
 *
 * This step deliberately ships read-only: no `+ New` modal, no row
 * `[Delete]`, no row-click drawer. Those land in the subsequent steps
 * of the dashboard UI plan; the surface is structured so they slot in
 * without rewriting the data path.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAdminApi } from "./adminApi.js";
import { ScopingAuditDrawer } from "./ScopingAuditDrawer.js";
import { ScopingEditModal, type ScopingEditMode } from "./ScopingEditModal.js";
import type { ScopeKind, ScopingOverrideRow } from "./types.js";

const SCOPE_KINDS: ScopeKind[] = ["user", "team", "tenant"];
const KNOWN_KEYS = ["flow.allowlist", "runtime", "model", "compute.default"] as const;

interface ScopingTabProps {
  onToast?: (msg: string, type: string) => void;
}

interface Filters {
  scope_kind: ScopeKind | null;
  scope_id: string;
  key: string | null;
  includeDeleted: boolean;
}

const EMPTY_FILTERS: Filters = {
  scope_kind: null,
  scope_id: "",
  key: null,
  includeDeleted: false,
};

export type ScopingFetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "data"; rows: ScopingOverrideRow[]; truncated: boolean };

export function ScopingTab({ onToast }: ScopingTabProps) {
  const adminApi = useAdminApi();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [state, setState] = useState<ScopingFetchState>({ kind: "idle" });
  const [selectedRow, setSelectedRow] = useState<ScopingOverrideRow | null>(null);
  const [editing, setEditing] = useState<ScopingEditMode | null>(null);
  // Monotonic request token guards against the standard fetch-on-deps
  // race: when filter chips are flipped faster than the response
  // round-trip, an older response could otherwise land on top of a
  // newer one and the table would show the wrong filter's rows.
  // Every fired refresh captures its token; the response is only
  // committed if the token is still the latest at resolution time.
  const reqRef = useRef(0);

  const refresh = useCallback(async () => {
    const myToken = ++reqRef.current;
    setState({ kind: "loading" });
    try {
      const page = await adminApi.scopingListPage({
        ...(filters.scope_kind ? { scope_kind: filters.scope_kind } : {}),
        ...(filters.scope_id.trim() ? { scope_id: filters.scope_id.trim() } : {}),
        ...(filters.key ? { key: filters.key } : {}),
        ...(filters.includeDeleted ? { includeDeleted: true } : {}),
      });
      if (myToken !== reqRef.current) return; // stale: a newer refresh has fired
      setState({ kind: "data", rows: page.rows, truncated: page.truncated });
    } catch (e: any) {
      if (myToken !== reqRef.current) return;
      const message = e?.message ?? String(e);
      setState({ kind: "error", message });
      onToast?.(`Failed to load scoping overrides: ${message}`, "error");
    }
  }, [adminApi, filters, onToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSaved = useCallback(() => {
    // After a successful set, drop the local selection (it may now be
    // stale) and refresh the list from the server. The toast was already
    // emitted from inside the modal.
    setSelectedRow(null);
    void refresh();
  }, [refresh]);

  const onDelete = useCallback(
    async (row: ScopingOverrideRow) => {
      // window.confirm matches the pattern in TenantsTab / TeamsTab /
      // UsersTab. Keep destructive-action UX consistent across the admin
      // tabs; if the design system grows a confirm-dialog primitive,
      // swap all four sites at once.
      const verb = `${row.scope_kind} / ${row.scope_id} / ${row.key}`;
      if (!window.confirm(`Delete scoping override '${verb}'? Tombstone is kept for audit.`)) return;
      try {
        const ok = await adminApi.scopingDelete({ id: row.id });
        if (ok) {
          onToast?.(`Override '${verb}' deleted.`, "success");
        } else {
          // ok=false from the server means "no live row matched" -- usually a
          // race against a concurrent delete from another admin. Surface
          // gently rather than as an error.
          onToast?.(`Override '${verb}' was already deleted.`, "info");
        }
        setSelectedRow(null);
        await refresh();
      } catch (e: any) {
        onToast?.(`Failed to delete: ${e?.message ?? String(e)}`, "error");
      }
    },
    [adminApi, onToast, refresh],
  );

  return (
    <div className="flex h-full flex-col">
      <ScopingTabHeader filters={filters} onChange={setFilters} onNewOverride={() => setEditing({ kind: "create" })} />
      <ScopingTabBody
        state={state}
        onRetry={refresh}
        hasFilters={hasActiveFilters(filters)}
        onRowClick={setSelectedRow}
      />
      <ScopingAuditDrawer
        row={selectedRow}
        onClose={() => setSelectedRow(null)}
        onEdit={(row) => {
          setSelectedRow(null);
          setEditing({ kind: "edit", row });
        }}
        onDelete={onDelete}
      />
      {/* `key` forces a remount whenever the modal's mode shifts identity
          (create vs edit on a specific row). Parent currently always
          flips editing through null first, so this is defensive against
          a future in-place swap (e.g. a "Save & next" workflow) that
          would otherwise tear the form state between modes. */}
      <ScopingEditModal
        key={editing ? (editing.kind === "edit" ? `edit-${editing.row.id}` : "create") : "closed"}
        mode={editing}
        onClose={() => setEditing(null)}
        onSaved={onSaved}
        onToast={onToast}
      />
    </div>
  );
}

function hasActiveFilters(f: Filters): boolean {
  return Boolean(f.scope_kind || f.scope_id.trim() || f.key || f.includeDeleted);
}

// ── header (filters + future "+ New") ─────────────────────────────────────

interface HeaderProps {
  filters: Filters;
  onChange: (next: Filters) => void;
  onNewOverride?: () => void;
}

function ScopingTabHeader({ filters, onChange, onNewOverride }: HeaderProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-3">
      <FilterChipGroup<ScopeKind>
        label="Scope"
        options={SCOPE_KINDS}
        value={filters.scope_kind}
        onChange={(v) => onChange({ ...filters, scope_kind: v })}
      />
      <FilterChipGroup<string>
        label="Key"
        options={KNOWN_KEYS as readonly string[] as string[]}
        value={filters.key}
        onChange={(v) => onChange({ ...filters, key: v })}
      />
      <label className="ml-auto flex items-center gap-1.5 text-[12px] text-[var(--fg-muted)]">
        <input
          type="checkbox"
          checked={filters.includeDeleted}
          onChange={(e) => onChange({ ...filters, includeDeleted: e.target.checked })}
          className="h-3.5 w-3.5 rounded border-[var(--border)]"
        />
        Show deleted
      </label>
      {onNewOverride && (
        <button
          type="button"
          onClick={onNewOverride}
          className="rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-1 text-[12px] hover:bg-[var(--bg-subtle)]"
        >
          + New override
        </button>
      )}
    </div>
  );
}

interface FilterChipGroupProps<T extends string> {
  label: string;
  options: T[];
  value: T | null;
  onChange: (next: T | null) => void;
}

function FilterChipGroup<T extends string>({ label, options, value, onChange }: FilterChipGroupProps<T>) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">{label}</span>
      <FilterChip label="All" pressed={value === null} onClick={() => onChange(null)} />
      {options.map((opt) => (
        <FilterChip key={opt} label={opt} pressed={value === opt} onClick={() => onChange(opt)} />
      ))}
    </div>
  );
}

function FilterChip({ label, pressed, onClick }: { label: string; pressed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={
        "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors " +
        (pressed
          ? "border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
          : "border-transparent text-[var(--fg-muted)] hover:bg-[var(--bg)]")
      }
    >
      {label}
    </button>
  );
}

// ── body (loading / error / empty / data) ─────────────────────────────────

export interface ScopingTabBodyProps {
  state: ScopingFetchState;
  onRetry: () => void;
  hasFilters: boolean;
  /** Optional row-click handler (drawer wiring). Omitted -> rows are
   *  not interactive (used by SSR tests that don't need the click path). */
  onRowClick?: (row: ScopingOverrideRow) => void;
}

export function ScopingTabBody({ state, onRetry, hasFilters, onRowClick }: ScopingTabBodyProps) {
  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <div className="flex-1 overflow-y-auto p-4">
        <div className="text-[12px] text-[var(--fg-muted)]" role="status">
          Loading scoping overrides...
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex-1 overflow-y-auto p-4">
        <div role="alert" className="rounded border border-red-700/40 bg-red-900/10 p-3 text-[12px] text-red-200">
          <div className="mb-2">Failed to load scoping overrides: {state.message}</div>
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
          {hasFilters ? "No scoping overrides match the current filters." : "No scoping overrides yet."}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {/* `overflow-x-auto` wraps the table so narrow viewports scroll the
          table itself rather than clipping or shoving the rail. */}
      <div className="overflow-x-auto">
        <ScopingTable rows={state.rows} onRowClick={onRowClick} />
      </div>
      {state.truncated && <TruncationBanner shown={state.rows.length} />}
    </div>
  );
}

function TruncationBanner({ shown }: { shown: number }) {
  return (
    <div
      role="status"
      className="mt-3 rounded border border-yellow-700/40 bg-yellow-900/10 p-2.5 text-[11px] text-yellow-200"
    >
      Result hit the server's safety cap ({shown} rows shown). Some matches were omitted -- narrow the filter (scope,
      key, or scope-id) to see them.
    </div>
  );
}

// ── table ─────────────────────────────────────────────────────────────────

export function ScopingTable({
  rows,
  onRowClick,
}: {
  rows: ScopingOverrideRow[];
  onRowClick?: (row: ScopingOverrideRow) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">
          <th className="py-1.5 pr-3 font-medium">Scope</th>
          <th className="py-1.5 pr-3 font-medium">Scope ID</th>
          <th className="py-1.5 pr-3 font-medium">Key</th>
          <th className="py-1.5 pr-3 font-medium">Value</th>
          <th className="py-1.5 pr-3 font-medium">Set by</th>
          <th className="py-1.5 pr-3 font-medium">Updated</th>
          <th className="py-1.5 pr-3 text-right font-medium">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <ScopingTableRow key={row.id} row={row} onClick={onRowClick} />
        ))}
      </tbody>
    </table>
  );
}

function ScopingTableRow({ row, onClick }: { row: ScopingOverrideRow; onClick?: (row: ScopingOverrideRow) => void }) {
  const isDeleted = Boolean(row.deleted_at);
  // Row stays semantic: a plain `<tr>` keeps its implicit row role
  // inside the table grid so screen readers walk Scope -> Scope ID ->
  // Key -> Value -> Set by -> Updated -> Inspect cleanly. The
  // interactive affordance lives in a dedicated trailing button cell,
  // matching TeamsTab's inline-action pattern. Hover styling on the
  // row provides the sighted-mouse discoverability without claiming a
  // button role on the row itself.
  return (
    <tr
      className={
        "border-t border-[var(--border)] " +
        (isDeleted ? "opacity-60 [&>td]:line-through " : "hover:bg-[var(--bg-subtle)]")
      }
    >
      <td className="py-2 pr-3">
        <ScopeKindBadge kind={row.scope_kind} />
      </td>
      <td className="py-2 pr-3 font-mono text-[12px]">{row.scope_id}</td>
      <td className="py-2 pr-3 font-mono text-[12px]">{row.key}</td>
      <td className="py-2 pr-3 font-mono text-[12px]" title={row.value_json}>
        <ValueCell raw={row.value_json} />
      </td>
      <td className="py-2 pr-3 font-mono text-[11px] text-[var(--fg-muted)]">{row.set_by ?? "(unknown)"}</td>
      <td className="py-2 pr-3 text-[11px] text-[var(--fg-muted)]">
        {row.updated_at.slice(0, 19).replace("T", " ")}
        {isDeleted && <DeletedBadge />}
      </td>
      <td className="py-2 pr-3 text-right">
        {onClick && (
          <button
            type="button"
            onClick={() => onClick(row)}
            aria-label={`Inspect ${row.scope_kind} / ${row.scope_id} / ${row.key}`}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--bg)]"
          >
            Inspect
          </button>
        )}
      </td>
    </tr>
  );
}

function ScopeKindBadge({ kind }: { kind: ScopeKind }) {
  return (
    <span className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">
      {kind}
    </span>
  );
}

function DeletedBadge() {
  return <span className="ml-2 rounded bg-red-900/30 px-1.5 py-0.5 text-[10px] uppercase text-red-300">deleted</span>;
}

/**
 * Renders the value column. JSON arrays/objects collapse to a compact
 * one-line form (`[a, b, c]` / `{key:..., ...}`) so the row stays scannable;
 * the full JSON is on the cell's `title` for hover-reveal. Strings are
 * shown unquoted for readability.
 */
function ValueCell({ raw }: { raw: string }) {
  const display = useMemo(() => {
    try {
      const v = JSON.parse(raw);
      if (typeof v === "string") return v;
      if (Array.isArray(v)) {
        const inner = v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");
        return `[${inner}]`;
      }
      // Object or other -- defer to JSON.stringify but trim aggressively.
      const s = JSON.stringify(v);
      return s.length > 60 ? s.slice(0, 57) + "..." : s;
    } catch {
      return raw;
    }
  }, [raw]);
  return <span>{display}</span>;
}
