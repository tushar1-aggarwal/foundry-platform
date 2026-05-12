/**
 * Create / edit modal for a scoping override.
 *
 * Single modal serves both verbs: the `mode` prop discriminates.
 *   - `{ kind: "create" }` -> empty form; submit dispatches scopingSet
 *     for a fresh row.
 *   - `{ kind: "edit"; row }` -> form pre-populated from `row`; submit
 *     dispatches scopingSet on the same scope+key, which is idempotent
 *     (the resolver row is unique on `(scope_kind, scope_id, key)` per
 *     tenant -- repeated set updates `value_json` + `set_by` in place).
 *
 * Per-key value editor uses a discriminated union of inputs so a
 * `flow.allowlist` selection can never be set to a plain string at
 * runtime, and `runtime` / `model` / `compute.default` selections can
 * never be set to an array. Each value editor's options come from the
 * relevant catalog endpoint (`runtime/list` / `model/list` /
 * `compute/list` / `flow/list`); the server-side validator is the
 * authoritative gate, but the dropdowns make typo'd values impossible
 * at the UI layer.
 *
 * A11y: same conventions as `ScopingAuditDrawer` -- role="dialog",
 * aria-modal, focus trap via `useFocusTrap`, Escape closes, backdrop
 * click closes. Submit-button-disabled-until-valid avoids the
 * round-trip on obviously incomplete forms.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap.js";
import { useAdminApi } from "./adminApi.js";
import { useApi } from "../../hooks/useApi.js";
import { useOptionalAuth } from "../../auth/AuthContext.js";
import type { ScopeKind, ScopingOverrideRow, Tenant, Team, User } from "./types.js";

const SCOPE_KINDS: ScopeKind[] = ["user", "team", "tenant"];

type KnownKey = "runtime" | "model" | "compute.default" | "flow.allowlist";
const KNOWN_KEYS: KnownKey[] = ["runtime", "model", "compute.default", "flow.allowlist"];

export type ScopingEditMode = { kind: "create" } | { kind: "edit"; row: ScopingOverrideRow };

interface ScopingEditModalProps {
  /** When non-null the modal is open; null = closed (component returns null). */
  mode: ScopingEditMode | null;
  onClose: () => void;
  /** Called with the server's authoritative row after a successful save. */
  onSaved: (row: ScopingOverrideRow) => void;
  onToast?: (msg: string, type: string) => void;
}

interface Catalogs {
  runtimes: { name: string }[];
  models: { id: string; aliases?: string[] }[];
  computes: { name: string }[];
  flows: { name: string }[];
  users: User[];
  teams: Team[];
  tenant: Tenant | null;
}

// Empty catalogs while data is loading; dropdowns render a placeholder.
const EMPTY_CATALOGS: Catalogs = {
  runtimes: [],
  models: [],
  computes: [],
  flows: [],
  users: [],
  teams: [],
  tenant: null,
};

// ── Outer drawer wrapper (portal + null guard) ─────────────────────────────

export function ScopingEditModal(props: ScopingEditModalProps) {
  if (!props.mode) return null;
  if (typeof document === "undefined") return null;
  return createPortal(<ScopingEditModalPanel {...props} mode={props.mode} />, document.body);
}

// ── Inner panel (exported for SSR / direct tests) ──────────────────────────

interface PanelProps extends Omit<ScopingEditModalProps, "mode"> {
  mode: ScopingEditMode;
}

export function ScopingEditModalPanel({ mode, onClose, onSaved, onToast }: PanelProps) {
  const adminApi = useAdminApi();
  const api = useApi();
  const auth = useOptionalAuth();
  const callerTenantId = auth?.identity?.tenantId ?? null;

  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(true, panelRef, onClose);

  // ── form state ──────────────────────────────────────────────────────────
  const initial = useMemo(() => initialFormState(mode, callerTenantId), [mode, callerTenantId]);
  const [scopeKind, setScopeKind] = useState<ScopeKind>(initial.scope_kind);
  const [scopeId, setScopeId] = useState<string>(initial.scope_id);
  const [key, setKey] = useState<KnownKey>(initial.key);
  const [value, setValue] = useState<unknown>(initial.value);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset value to a sensible default whenever the key changes (only
  // applies once after every key change in create mode; edit mode keeps
  // the original until the user explicitly changes the key).
  useEffect(() => {
    if (key === initial.key && value === initial.value) return; // first render
    setValue(defaultValueForKey(key));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset scope_id on every scope_kind change in create mode. Without
  // this, a user picks "u-rachna" under user scope, switches to team
  // scope, sees the team dropdown showing blank (no team matches the
  // user id) -- but state still holds "u-rachna" and submit would send
  // it, producing a confusing NOT_FOUND on the server. Edit mode locks
  // scope_kind via the disabled fieldset, so this effect is a no-op
  // there; the early return preserves the row's original scope_id.
  useEffect(() => {
    if (mode.kind === "edit") return;
    setScopeId(scopeKind === "tenant" ? (callerTenantId ?? "") : "");
  }, [scopeKind, callerTenantId, mode.kind]);

  // ── catalog loading ────────────────────────────────────────────────────
  const [catalogs, setCatalogs] = useState<Catalogs>(EMPTY_CATALOGS);
  const [catalogsLoaded, setCatalogsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadCatalogs() {
      // Each catalog has its own `.catch` so a partial failure on one
      // RPC doesn't silently drop the other catalogs from the modal.
      // Worst case: one dropdown is empty. Each catch console.warns so
      // ops debugging "why is the runtime dropdown empty?" in the
      // browser devtools can see which RPC failed.
      const warn = (label: string, err: unknown) =>
        console.warn(`[scoping-edit-modal] ${label} catalog load failed:`, err);
      try {
        const [runtimes, models, computes, flows, users, teams, tenants] = await Promise.all([
          api.getRuntimes().catch((e) => {
            warn("runtime", e);
            return [] as { name: string }[];
          }),
          api.getModels().catch((e) => {
            warn("model", e);
            return [] as { id: string; aliases?: string[] }[];
          }),
          api.getCompute().catch((e) => {
            warn("compute", e);
            return [] as { name: string }[];
          }),
          api.getFlows().catch((e) => {
            warn("flow", e);
            return [] as { name: string }[];
          }),
          adminApi.listUsers().catch((e) => {
            warn("users", e);
            return [] as User[];
          }),
          callerTenantId
            ? adminApi.listTeams(callerTenantId).catch((e) => {
                warn("teams", e);
                return [] as Team[];
              })
            : Promise.resolve([] as Team[]),
          callerTenantId
            ? adminApi.listTenants().catch((e) => {
                warn("tenants", e);
                return [] as Tenant[];
              })
            : Promise.resolve([] as Tenant[]),
        ]);
        if (cancelled) return;
        setCatalogs({
          runtimes: runtimes.filter((r) => r?.name),
          models: models.filter((m) => m?.id),
          computes: computes.filter((c) => c?.name),
          flows: flows.filter((f) => f?.name),
          users,
          teams,
          tenant: tenants.find((t) => t.id === callerTenantId) ?? null,
        });
        setCatalogsLoaded(true);
      } catch (e: any) {
        if (cancelled) return;
        onToast?.(`Failed to load catalogs: ${e?.message ?? String(e)}`, "error");
        setCatalogsLoaded(true); // unblock the form even on partial failure
      }
    }
    void loadCatalogs();
    return () => {
      cancelled = true;
    };
  }, [api, adminApi, callerTenantId, onToast]);

  // Body scroll lock while open.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // ── submit ─────────────────────────────────────────────────────────────
  // Unmount guard. The submit handler awaits scopingSet -- if the user
  // hits Cancel / Escape / backdrop-click during that await, the modal
  // unmounts but the RPC promise still resolves. Without the guard,
  // setSubmitting / setSubmitError would fire on an unmounted component
  // and React would log "Can't perform a state update on an unmounted
  // component." Not a crash, but noisy.
  const unmountedRef = useRef(false);
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const canSubmit = isFormValid({ scopeKind, scopeId, key, value }) && !submitting;
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      setSubmitting(true);
      setSubmitError(null);
      try {
        const row = await adminApi.scopingSet({ scope_kind: scopeKind, scope_id: scopeId, key, value });
        if (unmountedRef.current) return;
        onSaved(row);
        onToast?.(mode.kind === "create" ? "Override created." : "Override updated.", "success");
        onClose();
      } catch (err: any) {
        if (unmountedRef.current) return;
        setSubmitError(err?.message ?? String(err));
      } finally {
        if (!unmountedRef.current) setSubmitting(false);
      }
    },
    [adminApi, scopeKind, scopeId, key, value, canSubmit, onSaved, onClose, onToast, mode.kind],
  );

  const titleId = "scoping-edit-modal-title";

  return (
    <>
      <div aria-hidden="true" onClick={onClose} className="fixed inset-0 z-40 bg-black/40" />
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-8">
        <form
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onSubmit={handleSubmit}
          className="w-[520px] max-w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] shadow-xl"
        >
          <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-3">
            <h2 id={titleId} className="text-sm font-semibold">
              {mode.kind === "create" ? "Create scoping override" : "Edit scoping override"}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close edit modal"
              className="rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
            >
              <CloseIcon />
            </button>
          </header>

          <div className="space-y-4 px-5 py-4">
            <ScopeKindField scope={scopeKind} onChange={setScopeKind} disabled={mode.kind === "edit"} />
            <ScopeIdField
              scopeKind={scopeKind}
              scopeId={scopeId}
              onChange={setScopeId}
              catalogs={catalogs}
              callerTenantId={callerTenantId}
              disabled={mode.kind === "edit"}
            />
            <KeyField keyValue={key} onChange={setKey} disabled={mode.kind === "edit"} />
            <ValueField
              keyName={key}
              value={value}
              onChange={setValue}
              catalogs={catalogs}
              catalogsLoaded={catalogsLoaded}
            />
            {submitError && (
              <div
                role="alert"
                className="rounded border border-red-700/40 bg-red-900/10 p-2.5 text-[12px] text-red-200"
              >
                {submitError}
              </div>
            )}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-[var(--border)] px-3 py-1 text-[12px] hover:bg-[var(--bg-subtle)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className={
                "rounded px-3 py-1 text-[12px] font-medium " +
                (canSubmit
                  ? "bg-[var(--accent,#7c5cff)] text-white hover:opacity-90"
                  : "cursor-not-allowed bg-[var(--bg-subtle)] text-[var(--fg-muted)]")
              }
            >
              {submitting ? "Saving..." : mode.kind === "create" ? "Create" : "Save"}
            </button>
          </footer>
        </form>
      </div>
    </>
  );
}

// ── Form initialization ────────────────────────────────────────────────────

export function initialFormState(
  mode: ScopingEditMode,
  callerTenantId: string | null,
): { scope_kind: ScopeKind; scope_id: string; key: KnownKey; value: unknown } {
  if (mode.kind === "edit") {
    const k = mode.row.key as KnownKey;
    let v: unknown;
    try {
      v = JSON.parse(mode.row.value_json);
    } catch {
      v = mode.row.value_json;
    }
    return { scope_kind: mode.row.scope_kind, scope_id: mode.row.scope_id, key: k, value: v };
  }
  // create
  return {
    scope_kind: "tenant",
    scope_id: callerTenantId ?? "",
    key: "runtime",
    value: defaultValueForKey("runtime"),
  };
}

export function defaultValueForKey(key: KnownKey): unknown {
  if (key === "flow.allowlist") return [] as string[];
  return "";
}

export function isFormValid(s: { scopeKind: ScopeKind; scopeId: string; key: KnownKey; value: unknown }): boolean {
  if (!s.scopeId.trim()) return false;
  if (s.key === "flow.allowlist") return Array.isArray(s.value) && s.value.length > 0;
  return typeof s.value === "string" && s.value.length > 0;
}

// ── Field components ───────────────────────────────────────────────────────

function ScopeKindField({
  scope,
  onChange,
  disabled,
}: {
  scope: ScopeKind;
  onChange: (s: ScopeKind) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="contents">
      <Label>Scope</Label>
      <div role="radiogroup" aria-label="Scope kind" className="mt-1 flex gap-2">
        {SCOPE_KINDS.map((k) => (
          <label
            key={k}
            className={
              "cursor-pointer rounded border px-3 py-1 text-[12px] " +
              (scope === k
                ? "border-[var(--accent,#7c5cff)] bg-[var(--bg-subtle)] text-[var(--fg)]"
                : "border-[var(--border)] text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]")
            }
          >
            <input
              type="radio"
              name="scope"
              value={k}
              checked={scope === k}
              onChange={() => onChange(k)}
              className="sr-only"
            />
            {k}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ScopeIdField({
  scopeKind,
  scopeId,
  onChange,
  catalogs,
  callerTenantId,
  disabled,
}: {
  scopeKind: ScopeKind;
  scopeId: string;
  onChange: (id: string) => void;
  catalogs: Catalogs;
  callerTenantId: string | null;
  disabled?: boolean;
}) {
  if (scopeKind === "tenant") {
    return (
      <div>
        <Label>Scope ID</Label>
        <input
          type="text"
          value={callerTenantId ?? scopeId}
          readOnly
          disabled
          aria-label="Tenant ID (locked to your tenant)"
          className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1 font-mono text-[12px] text-[var(--fg-muted)]"
        />
        <p className="mt-1 text-[11px] text-[var(--fg-muted)]">
          Tenant-scope overrides apply to every caller in your tenant; the scope ID locks to your tenant.
        </p>
      </div>
    );
  }
  if (scopeKind === "user") {
    return (
      <div>
        <Label>User</Label>
        <select
          value={scopeId}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Target user"
          className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[12px]"
        >
          <option value="">-- pick a user --</option>
          {catalogs.users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </select>
      </div>
    );
  }
  // team
  return (
    <div>
      <Label>Team</Label>
      <select
        value={scopeId}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Target team"
        className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[12px]"
      >
        <option value="">-- pick a team --</option>
        {catalogs.teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.slug})
          </option>
        ))}
      </select>
    </div>
  );
}

function KeyField({
  keyValue,
  onChange,
  disabled,
}: {
  keyValue: KnownKey;
  onChange: (k: KnownKey) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <Label>Key</Label>
      <select
        value={keyValue}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as KnownKey)}
        aria-label="Override key"
        className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[12px]"
      >
        {KNOWN_KEYS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
    </div>
  );
}

function ValueField({
  keyName,
  value,
  onChange,
  catalogs,
  catalogsLoaded,
}: {
  keyName: KnownKey;
  value: unknown;
  onChange: (v: unknown) => void;
  catalogs: Catalogs;
  catalogsLoaded: boolean;
}) {
  if (keyName === "runtime") {
    return (
      <CatalogSelect
        label="Runtime"
        value={asString(value)}
        onChange={onChange}
        options={catalogs.runtimes.map((r) => ({ label: r.name, value: r.name }))}
        placeholder={catalogsLoaded ? "-- pick a runtime --" : "Loading runtimes..."}
        disabled={!catalogsLoaded}
      />
    );
  }
  if (keyName === "model") {
    const options = catalogs.models.map((m) => ({
      label: m.aliases && m.aliases.length > 0 ? `${m.id} (alias: ${m.aliases[0]})` : m.id,
      value: m.id,
    }));
    return (
      <CatalogSelect
        label="Model"
        value={asString(value)}
        onChange={onChange}
        options={options}
        placeholder={catalogsLoaded ? "-- pick a model --" : "Loading models..."}
        disabled={!catalogsLoaded}
      />
    );
  }
  if (keyName === "compute.default") {
    return (
      <CatalogSelect
        label="Compute target"
        value={asString(value)}
        onChange={onChange}
        options={catalogs.computes.map((c) => ({ label: c.name, value: c.name }))}
        placeholder={catalogsLoaded ? "-- pick a compute --" : "Loading computes..."}
        disabled={!catalogsLoaded}
      />
    );
  }
  // flow.allowlist
  return (
    <FlowAllowlistField
      value={Array.isArray(value) ? (value as string[]) : []}
      onChange={onChange}
      flowOptions={catalogs.flows.map((f) => f.name)}
      catalogsLoaded={catalogsLoaded}
    />
  );
}

function CatalogSelect({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
  placeholder: string;
  disabled: boolean;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[12px]"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function FlowAllowlistField({
  value,
  onChange,
  flowOptions,
  catalogsLoaded,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  flowOptions: string[];
  catalogsLoaded: boolean;
}) {
  function toggle(name: string) {
    if (value.includes(name)) onChange(value.filter((n) => n !== name));
    else onChange([...value, name]);
  }
  return (
    <div>
      <Label>Flow allowlist</Label>
      {!catalogsLoaded ? (
        <div className="mt-1 text-[12px] text-[var(--fg-muted)]">Loading flows...</div>
      ) : flowOptions.length === 0 ? (
        <div className="mt-1 text-[12px] text-[var(--fg-muted)]">No flows in the catalog.</div>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="Allowed flows">
          {flowOptions.map((name) => {
            const picked = value.includes(name);
            return (
              <button
                key={name}
                type="button"
                role="checkbox"
                aria-checked={picked}
                onClick={() => toggle(name)}
                className={
                  "rounded-full border px-2.5 py-0.5 text-[11px] " +
                  (picked
                    ? "border-[var(--accent,#7c5cff)] bg-[var(--bg-subtle)] text-[var(--fg)]"
                    : "border-[var(--border)] text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]")
                }
              >
                {name}
              </button>
            );
          })}
        </div>
      )}
      {value.length > 0 && (
        <p className="mt-2 text-[11px] text-[var(--fg-muted)]">
          {value.length} flow{value.length === 1 ? "" : "s"} selected
        </p>
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">{children}</div>;
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
