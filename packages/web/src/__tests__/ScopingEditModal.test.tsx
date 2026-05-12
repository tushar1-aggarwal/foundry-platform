/**
 * `ScopingEditModal` -- pure-helper + SSR-panel tests.
 *
 * Strategy:
 *   - Pure helpers (`initialFormState`, `isFormValid`, `defaultValueForKey`)
 *     get unit tests; they cover the create/edit init divergence, the
 *     submit gate, and the per-key default values.
 *   - The panel renders deterministically under SSR for the markup we
 *     care about: title (create vs edit), the locked tenant-scope id
 *     input, the disabled submit button before any value is chosen,
 *     and the dialog a11y attributes. The catalog-driven dropdowns
 *     populate via `useEffect` which doesn't fire under SSR -- those
 *     are exercised in the manual E2E pass.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { MockTransport } from "../transport/MockTransport.js";
import { TransportProvider } from "../transport/TransportContext.js";
import {
  ScopingEditModalPanel,
  initialFormState,
  isFormValid,
  defaultValueForKey,
  type ScopingEditMode,
} from "../components/admin/ScopingEditModal.js";
import type { ScopingOverrideRow } from "../components/admin/types.js";

function makeRow(over: Partial<ScopingOverrideRow> = {}): ScopingOverrideRow {
  return {
    id: "s-edit-1",
    scope_kind: "team",
    scope_id: "tm-eng",
    key: "model",
    value_json: JSON.stringify("sonnet"),
    tenant_id: "default",
    created_at: "2026-05-10T00:00:00Z",
    updated_at: "2026-05-11T00:00:00Z",
    deleted_at: null,
    set_by: "u-rachna",
    deleted_by: null,
    ...over,
  };
}

const noop = () => {};

function mountPanel(mode: ScopingEditMode): string {
  // Minimal transport that returns empty handlers for any RPC the
  // modal might fire on mount. catalog-loading useEffect doesn't run
  // under SSR; this just keeps the TransportProvider happy.
  const transport = new MockTransport();
  for (const m of [
    "runtime/list",
    "model/list",
    "compute/list",
    "flow/list",
    "admin/user/list",
    "admin/team/list",
    "admin/tenant/list",
  ]) {
    transport.register(m, () => ({}));
  }
  return renderToString(
    <TransportProvider transport={transport}>
      <ScopingEditModalPanel mode={mode} onClose={noop} onSaved={noop} />
    </TransportProvider>,
  );
}

// ── pure helpers ───────────────────────────────────────────────────────────

describe("initialFormState", () => {
  test("create mode -> tenant scope locked to callerTenantId + runtime default", () => {
    const s = initialFormState({ kind: "create" }, "default");
    expect(s.scope_kind).toBe("tenant");
    expect(s.scope_id).toBe("default");
    expect(s.key).toBe("runtime");
    expect(s.value).toBe("");
  });

  test("create mode without identity -> empty scope_id (caller signed out / local mode)", () => {
    const s = initialFormState({ kind: "create" }, null);
    expect(s.scope_id).toBe("");
  });

  test("edit mode -> rehydrates every field from the row", () => {
    const row = makeRow({
      scope_kind: "user",
      scope_id: "u-1",
      key: "flow.allowlist",
      value_json: JSON.stringify(["docs", "fix-bug"]),
    });
    const s = initialFormState({ kind: "edit", row }, "default");
    expect(s).toEqual({
      scope_kind: "user",
      scope_id: "u-1",
      key: "flow.allowlist",
      value: ["docs", "fix-bug"],
    });
  });

  test("edit mode tolerates corrupt value_json (falls back to raw)", () => {
    const row = makeRow({ key: "runtime", value_json: "not-json-at-all" });
    const s = initialFormState({ kind: "edit", row }, "default");
    expect(s.value).toBe("not-json-at-all");
  });
});

describe("defaultValueForKey", () => {
  test("flow.allowlist -> empty array (multi-select default)", () => {
    expect(defaultValueForKey("flow.allowlist")).toEqual([]);
  });

  test("scalar keys -> empty string", () => {
    expect(defaultValueForKey("runtime")).toBe("");
    expect(defaultValueForKey("model")).toBe("");
    expect(defaultValueForKey("compute.default")).toBe("");
  });
});

describe("isFormValid", () => {
  test("blank scope_id -> false regardless of key", () => {
    expect(isFormValid({ scopeKind: "user", scopeId: "", key: "runtime", value: "codex" })).toBe(false);
    expect(isFormValid({ scopeKind: "user", scopeId: "  ", key: "runtime", value: "codex" })).toBe(false);
  });

  test("scalar key with empty string value -> false", () => {
    expect(isFormValid({ scopeKind: "tenant", scopeId: "default", key: "runtime", value: "" })).toBe(false);
  });

  test("scalar key with non-empty value -> true", () => {
    expect(isFormValid({ scopeKind: "tenant", scopeId: "default", key: "runtime", value: "codex" })).toBe(true);
  });

  test("flow.allowlist with empty array -> false (must pick at least one)", () => {
    expect(isFormValid({ scopeKind: "tenant", scopeId: "default", key: "flow.allowlist", value: [] })).toBe(false);
  });

  test("flow.allowlist with at least one entry -> true", () => {
    expect(isFormValid({ scopeKind: "tenant", scopeId: "default", key: "flow.allowlist", value: ["docs"] })).toBe(true);
  });

  test("scalar key with non-string value (corrupt state) -> false", () => {
    // If someone ever managed to set the value to a number / object for a
    // scalar key, the gate must reject -- the server validator would too.
    expect(isFormValid({ scopeKind: "tenant", scopeId: "default", key: "runtime", value: 42 as unknown })).toBe(false);
  });
});

// ── SSR panel markup ───────────────────────────────────────────────────────

describe("ScopingEditModalPanel (SSR)", () => {
  test("create mode renders title + dialog a11y", () => {
    const html = mountPanel({ kind: "create" });
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toMatch(/aria-labelledby="scoping-edit-modal-title"/);
    expect(html).toContain("Create scoping override");
  });

  test("edit mode renders different title", () => {
    const html = mountPanel({ kind: "edit", row: makeRow() });
    expect(html).toContain("Edit scoping override");
  });

  test("scope radio group is mounted with all three options", () => {
    const html = mountPanel({ kind: "create" });
    expect(html).toMatch(/role="radiogroup"/);
    // sr-only radios + visible label text
    for (const k of ["user", "team", "tenant"]) {
      expect(html).toContain(`value="${k}"`);
    }
  });

  test("tenant scope shows the locked read-only ID input + helper text", () => {
    // create defaults to tenant scope, so the locked-input branch
    // renders in the initial SSR pass.
    const html = mountPanel({ kind: "create" });
    expect(html).toContain('aria-label="Tenant ID (locked to your tenant)"');
    expect(html).toMatch(/Tenant-scope overrides apply/);
  });

  test("key dropdown renders all four known keys", () => {
    const html = mountPanel({ kind: "create" });
    for (const k of ["runtime", "model", "compute.default", "flow.allowlist"]) {
      expect(html).toContain(`>${k}</option>`);
    }
  });

  test("submit button starts disabled (no value picked yet)", () => {
    const html = mountPanel({ kind: "create" });
    // The submit is a <button type="submit"> with text "Create" while
    // disabled; assert both.
    expect(html).toMatch(/type="submit"[^>]*disabled/);
    expect(html).toContain(">Create</button>");
  });

  test("edit mode pre-populates from row -- title says Save, submit enabled", () => {
    const html = mountPanel({ kind: "edit", row: makeRow({ key: "runtime", value_json: '"codex"' }) });
    expect(html).toContain(">Save</button>");
    expect(html).not.toMatch(/type="submit"[^>]*disabled/);
  });

  test("close button has accessible label", () => {
    const html = mountPanel({ kind: "create" });
    expect(html).toContain('aria-label="Close edit modal"');
  });
});
