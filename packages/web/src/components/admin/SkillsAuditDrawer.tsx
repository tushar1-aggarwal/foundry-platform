/**
 * Audit drawer for a single Skill Hub row.
 *
 * Shows the skill's metadata + its full version history (lazily
 * fetched on open via admin/skillhub/version_history). For each
 * historical version, surfaces the merge_input_json provenance blob -
 * the load-bearing audit data for client-side LLM-merged versions
 * (RFC §7 LLM contract). Per-file strategies show up inside the
 * pretty-printed JSON so an admin can answer "which LLM produced
 * this version" + "did the .py supporting files go through manual
 * resolution or LLM merge?"
 *
 * Mirrors the ScopingAuditDrawer SSR + portal + focus-trap pattern.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap.js";
import { useAdminApi } from "./adminApi.js";
import type { SkillhubSkillRow, SkillhubVersionRow, SkillhubVisibility } from "./types.js";

interface SkillsAuditDrawerProps {
  /** When non-null, the drawer is open and shows this row. */
  row: SkillhubSkillRow | null;
  onClose: () => void;
  /** Soft-delete action; admin gate enforced server-side. */
  onDelete?: (row: SkillhubSkillRow) => void;
}

export function SkillsAuditDrawer({ row, onClose, onDelete }: SkillsAuditDrawerProps) {
  if (!row) return null;
  if (typeof document === "undefined") return null;
  return createPortal(<SkillsAuditDrawerPanel row={row} onClose={onClose} onDelete={onDelete} />, document.body);
}

// ── inner panel (exported for SSR / unportaled rendering) ────────────────

type HistoryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "data"; versions: SkillhubVersionRow[] };

export function SkillsAuditDrawerPanel({
  row,
  onClose,
  onDelete,
}: Required<Pick<SkillsAuditDrawerProps, "row" | "onClose">> & Pick<SkillsAuditDrawerProps, "onDelete">) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(true, panelRef, onClose);

  // Lock body scroll while drawer is open.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const adminApi = useAdminApi();
  const [history, setHistory] = useState<HistoryState>({ kind: "idle" });

  // Lazy-fetch version history when the drawer opens for this row.
  // Keyed on row.id so switching between rows refetches cleanly.
  useEffect(() => {
    let cancelled = false;
    setHistory({ kind: "loading" });
    adminApi
      .skillhubVersionHistory(row.id)
      .then((versions) => {
        if (cancelled) return;
        setHistory({ kind: "data", versions });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setHistory({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [adminApi, row.id]);

  const titleId = `skills-audit-drawer-title-${row.id}`;
  const isDeleted = Boolean(row.deleted_at);

  return (
    <>
      <div aria-hidden="true" onClick={onClose} className="fixed inset-0 z-40 bg-black/40" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-50 flex w-[520px] max-w-full flex-col border-l border-[var(--border)] bg-[var(--bg)] shadow-xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">Skill</div>
            <h2 id={titleId} className="mt-0.5 truncate font-mono text-sm">
              {row.name}
              {isDeleted && (
                <span className="ml-2 rounded bg-red-900/30 px-1.5 py-0.5 text-[10px] uppercase text-red-300">
                  deleted
                </span>
              )}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close audit drawer"
            className="rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Metadata block */}
          <FieldGroup label="ID" value={row.id} mono />
          <FieldGroup label="Description" value={row.description} />
          <FieldGroup label="Visibility" value={visibilityLabel(row.visibility)} />
          <FieldGroup label="Tenant" value={row.tenant_id ?? "-"} mono muted={!row.tenant_id} />
          <FieldGroup label="Team" value={row.team_id ?? "-"} mono muted={!row.team_id} />
          <FieldGroup label="Owner" value={row.owner_user_id ?? "-"} mono muted={!row.owner_user_id} />
          <FieldGroup label="Category" value={row.category ?? "-"} muted={!row.category} />
          <FieldGroup
            label="Tags"
            value={row.tags.length === 0 ? "-" : row.tags.join(", ")}
            muted={row.tags.length === 0}
          />
          <FieldGroup label="Current hash" value={row.current_hash} mono />
          <FieldGroup label="Created" value={formatTimestamp(row.created_at)} />
          <FieldGroup label="Updated" value={formatTimestamp(row.updated_at)} />
          <FieldGroup label="Created by" value={row.created_by} mono />
          {row.updated_by && <FieldGroup label="Updated by" value={row.updated_by} mono />}
          {isDeleted && (
            <>
              <FieldGroup label="Deleted at" value={formatTimestamp(row.deleted_at!)} />
              <FieldGroup label="Deleted by" value={row.deleted_by ?? "(unknown)"} mono muted={!row.deleted_by} />
            </>
          )}

          {/* History block */}
          <div className="mt-6">
            <Label>Version history</Label>
            <div className="mt-2 space-y-3">
              <HistoryBlock state={history} />
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          {onDelete && !isDeleted && (
            <button
              type="button"
              onClick={() => onDelete(row)}
              className="rounded border border-red-700/40 bg-red-900/10 px-3 py-1 text-[12px] text-red-200 hover:bg-red-900/20"
            >
              Delete
            </button>
          )}
        </footer>
      </div>
    </>
  );
}

// ── History rendering ────────────────────────────────────────────────────

function HistoryBlock({ state }: { state: HistoryState }) {
  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <div role="status" className="text-[11px] text-[var(--fg-muted)]">
        Loading version history...
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div role="alert" className="rounded border border-red-700/40 bg-red-900/10 p-2 text-[11px] text-red-200">
        Failed to load history: {state.message}
      </div>
    );
  }
  if (state.versions.length === 0) {
    return <div className="text-[11px] text-[var(--fg-muted)]">No versions recorded.</div>;
  }
  return (
    <>
      {state.versions.map((v) => (
        <VersionRow key={v.id} version={v} />
      ))}
    </>
  );
}

function VersionRow({ version }: { version: SkillhubVersionRow }) {
  // Pretty-print the merge_input_json blob memoized on identity - the
  // drawer stays mounted while the operator reads, and re-stringifying
  // on every parent re-render would waste cycles.
  const mergeFormatted = useMemo(
    () => (version.merge_input_json ? JSON.stringify(version.merge_input_json, null, 2) : null),
    [version.merge_input_json],
  );

  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg-subtle)] p-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-mono text-[11px]" title={version.version_hash}>
          {version.version_hash.slice(0, 16)}...
        </div>
        <div className="text-[10px] text-[var(--fg-muted)]">{formatTimestamp(version.changed_at)}</div>
      </div>
      <div className="mt-1 text-[11px] text-[var(--fg-muted)]">
        by <span className="font-mono">{version.changed_by}</span>
      </div>
      {mergeFormatted ? (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">
            merge_input_json
            <span className="ml-1 normal-case tracking-normal text-[10px]">(client-side LLM merge audit)</span>
          </div>
          <pre className="mt-1 max-h-48 overflow-auto rounded border border-[var(--border)] bg-[var(--bg)] p-1.5 text-[10px] font-mono leading-snug">
            {mergeFormatted}
          </pre>
        </div>
      ) : (
        <div className="mt-2 text-[10px] text-[var(--fg-muted)]">direct edit (no merge_input)</div>
      )}
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

function FieldGroup({ label, value, mono, muted }: { label: string; value: string; mono?: boolean; muted?: boolean }) {
  return (
    <div className="mb-3">
      <Label>{label}</Label>
      <div className={"mt-0.5 text-[12px] " + (mono ? "font-mono " : "") + (muted ? "text-[var(--fg-muted)]" : "")}>
        {value}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">{children}</div>;
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function formatTimestamp(iso: string): string {
  return iso.slice(0, 19).replace("T", " ");
}

function visibilityLabel(v: SkillhubVisibility): string {
  return v;
}
