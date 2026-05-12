/**
 * Audit drawer for a single scoping override row.
 *
 * Slides in from the right when a row is clicked. Surfaces the full
 * audit field set -- including `deleted_at` / `deleted_by` for
 * tombstoned rows -- and exposes Edit and Delete actions via props.
 * Edit/Delete wiring lands in steps 7 + 8; this component just
 * renders the surface.
 *
 * A11y:
 *   - Renders as `role="dialog" aria-modal="true"`.
 *   - Focus trap captures Tab cycling inside the panel; Escape closes.
 *   - Focus returns to the trigger element when the drawer unmounts
 *     (handled by `useFocusTrap`).
 *   - Backdrop click closes (matches the standard drawer pattern).
 *
 * SSR caveat: the drawer mounts into a React portal targeting
 * `document.body`. Under `renderToString` portals are no-ops, so tests
 * that need to inspect drawer markup render `ScopingAuditDrawerPanel`
 * (the portal-free inner) directly with synthesized props.
 */

import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap.js";
import type { ScopingOverrideRow } from "./types.js";

interface ScopingAuditDrawerProps {
  /** When non-null, the drawer is open and shows this row. */
  row: ScopingOverrideRow | null;
  onClose: () => void;
  /** Optional -- wired in step 7 (edit modal). */
  onEdit?: (row: ScopingOverrideRow) => void;
  /** Optional -- wired in step 8 (delete action). */
  onDelete?: (row: ScopingOverrideRow) => void;
}

export function ScopingAuditDrawer({ row, onClose, onEdit, onDelete }: ScopingAuditDrawerProps) {
  // Render nothing -- including no portal target probe -- when closed.
  if (!row) return null;
  // `createPortal` requires a DOM target; under SSR `document` is
  // undefined. Guard so the same component can be imported by SSR-only
  // test code (the inner Panel is exported separately for those tests).
  if (typeof document === "undefined") return null;
  return createPortal(
    <ScopingAuditDrawerPanel row={row} onClose={onClose} onEdit={onEdit} onDelete={onDelete} />,
    document.body,
  );
}

// ── Inner panel: exported for tests / unportaled rendering ────────────────

export function ScopingAuditDrawerPanel({
  row,
  onClose,
  onEdit,
  onDelete,
}: Required<Pick<ScopingAuditDrawerProps, "row" | "onClose">> & Pick<ScopingAuditDrawerProps, "onEdit" | "onDelete">) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(true, panelRef, onClose);

  // Lock body scroll while drawer is open; restore on unmount.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const titleId = `scoping-audit-drawer-title-${row.id}`;
  // The drawer stays mounted while the operator reads -- memoise the
  // JSON pretty-print so it doesn't re-stringify on every parent
  // re-render (e.g. when the parent's filter chips repaint).
  const formattedValue = useMemo(() => formatJsonPretty(row.value_json), [row.value_json]);
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
        className="fixed inset-y-0 right-0 z-50 flex w-[440px] max-w-full flex-col border-l border-[var(--border)] bg-[var(--bg)] shadow-xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">Scoping override</div>
            <h2 id={titleId} className="mt-0.5 font-mono text-sm">
              {row.scope_kind} / {row.scope_id} / {row.key}
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
          <FieldGroup label="ID" value={row.id} mono />
          <FieldGroup label="Tenant" value={row.tenant_id} mono />
          <FieldGroup label="Scope kind" value={row.scope_kind} />
          <FieldGroup label="Scope ID" value={row.scope_id} mono />
          <FieldGroup label="Key" value={row.key} mono />
          <div className="mb-3">
            <Label>Value (raw)</Label>
            <pre className="mt-1 max-h-64 overflow-auto rounded border border-[var(--border)] bg-[var(--bg-subtle)] p-2 text-[11px] font-mono leading-snug">
              {formattedValue}
            </pre>
          </div>
          <FieldGroup label="Set by" value={row.set_by ?? "(unknown)"} mono muted={!row.set_by} />
          <FieldGroup label="Created" value={formatTimestamp(row.created_at)} />
          <FieldGroup label="Updated" value={formatTimestamp(row.updated_at)} />
          {isDeleted && (
            <>
              <FieldGroup label="Deleted at" value={formatTimestamp(row.deleted_at!)} />
              <FieldGroup label="Deleted by" value={row.deleted_by ?? "(unknown)"} mono muted={!row.deleted_by} />
            </>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          {onEdit && !isDeleted && (
            <button
              type="button"
              onClick={() => onEdit(row)}
              className="rounded border border-[var(--border)] px-3 py-1 text-[12px] hover:bg-[var(--bg-subtle)]"
            >
              Edit
            </button>
          )}
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

// ── Field rendering helpers ────────────────────────────────────────────────

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
  // Display in "YYYY-MM-DD HH:MM:SS" (UTC, slicing the ISO) for stable
  // SSR / tooling output. Don't `new Date()` here -- timezone differences
  // would diverge test fixtures from production rendering.
  return iso.slice(0, 19).replace("T", " ");
}

function formatJsonPretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
