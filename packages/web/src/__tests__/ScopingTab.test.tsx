/**
 * `ScopingTab` SSR tests.
 *
 * Two surfaces under test:
 *
 *   1. The outer `ScopingTab` mounted via `renderToString`. `useEffect`
 *      does NOT fire under SSR, so the outer test pins only what the
 *      initial render shows: the filter chips, the include-deleted
 *      toggle, and the loading status. This is the right shape -- we
 *      assert that the chrome mounts and the a11y semantics survive
 *      SSR, without coupling to the fetch lifecycle.
 *
 *   2. `ScopingTabBody` / `ScopingTable` rendered directly with a
 *      synthesized `ScopingFetchState`. Lets us cover empty / data /
 *      truncated / error branches without racing the effect. Both
 *      subcomponents are exported from `ScopingTab.tsx` purely for
 *      testability; production code uses `ScopingTab` end-to-end.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { MockTransport } from "../transport/MockTransport.js";
import { TransportProvider } from "../transport/TransportContext.js";
import { ScopingTab, ScopingTabBody, ScopingTable, type ScopingFetchState } from "../components/admin/ScopingTab.js";
import type { ScopingOverrideRow } from "../components/admin/types.js";

function makeRow(over: Partial<ScopingOverrideRow> = {}): ScopingOverrideRow {
  return {
    id: "s-1",
    scope_kind: "tenant",
    scope_id: "default",
    key: "runtime",
    value_json: JSON.stringify("codex"),
    tenant_id: "default",
    created_at: "2026-05-11T00:00:00Z",
    updated_at: "2026-05-11T00:00:00Z",
    deleted_at: null,
    set_by: "u-rachna",
    deleted_by: null,
    ...over,
  };
}

function mountTab(): string {
  const t = new MockTransport();
  t.register("admin/scoping/list", () => ({ rows: [], truncated: false }));
  return renderToString(
    <TransportProvider transport={t}>
      <ScopingTab />
    </TransportProvider>,
  );
}

// ── outer ScopingTab: initial-render contract ──────────────────────────────

describe("ScopingTab (outer, SSR initial render)", () => {
  test("renders all scope-kind chips", () => {
    const html = mountTab();
    expect(html).toContain(">user</button>");
    expect(html).toContain(">team</button>");
    expect(html).toContain(">tenant</button>");
  });

  test("renders all known-key chips", () => {
    const html = mountTab();
    expect(html).toContain(">flow.allowlist</button>");
    expect(html).toContain(">runtime</button>");
    expect(html).toContain(">model</button>");
    expect(html).toContain(">compute.default</button>");
  });

  test("renders the include-deleted toggle, unchecked by default", () => {
    const html = mountTab();
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Show deleted");
    // React serializes unchecked checkboxes WITHOUT the `checked` attribute.
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
  });

  test("chips surface their pressed state via aria-pressed", () => {
    const html = mountTab();
    expect(html).toMatch(/aria-pressed="true"/); // "All" pressed by default
    expect(html).toMatch(/aria-pressed="false"/); // others not
  });

  test("initial state announces loading via role=status", () => {
    const html = mountTab();
    expect(html).toMatch(/role="status"[^>]*>\s*Loading scoping overrides/);
  });
});

// ── body branches: data / empty / truncated / error ────────────────────────

const noop = () => {};

describe("ScopingTabBody", () => {
  test("empty state, no filters -> generic empty message", () => {
    const state: ScopingFetchState = { kind: "data", rows: [], truncated: false };
    const html = renderToString(<ScopingTabBody state={state} onRetry={noop} hasFilters={false} />);
    expect(html).toContain("No scoping overrides yet");
  });

  test("empty state, with filters -> filter-aware message", () => {
    const state: ScopingFetchState = { kind: "data", rows: [], truncated: false };
    const html = renderToString(<ScopingTabBody state={state} onRetry={noop} hasFilters={true} />);
    expect(html).toContain("No scoping overrides match the current filters");
  });

  test("data state renders the table", () => {
    const state: ScopingFetchState = {
      kind: "data",
      rows: [makeRow({ id: "s-1", scope_kind: "user", scope_id: "u-1", key: "runtime", value_json: '"codex"' })],
      truncated: false,
    };
    const html = renderToString(<ScopingTabBody state={state} onRetry={noop} hasFilters={false} />);
    expect(html).toContain("<table");
    expect(html).toContain("u-1");
    // No truncation banner when truncated=false.
    expect(html).not.toContain("safety cap");
  });

  test("truncated=true renders the banner with the shown count", () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      makeRow({ id: `s-${i}`, scope_id: `u-${i}`, key: "runtime", value_json: '"codex"' }),
    );
    const state: ScopingFetchState = { kind: "data", rows, truncated: true };
    const html = renderToString(<ScopingTabBody state={state} onRetry={noop} hasFilters={false} />);
    expect(html).toContain("safety cap");
    // React injects `<!-- -->` between static strings and interpolated
    // variables under SSR for hydration boundary tracking; use a regex
    // so the assertion isn't sensitive to that artifact.
    expect(html).toMatch(/\(.*3.* rows shown\)/);
    expect(html).toMatch(/role="status"/); // banner is announced
  });

  test("error state renders an alert + retry button", () => {
    const state: ScopingFetchState = { kind: "error", message: "boom" };
    const html = renderToString(<ScopingTabBody state={state} onRetry={noop} hasFilters={false} />);
    expect(html).toMatch(/role="alert"/);
    // `<!-- -->` separator between static + interpolated text; regex it.
    expect(html).toMatch(/Failed to load scoping overrides: .*boom/);
    expect(html).toContain(">Retry</button>");
  });
});

// ── ScopingTable: column shape + tombstone visual ──────────────────────────

describe("ScopingTable", () => {
  test("renders semantic table with the documented columns", () => {
    const html = renderToString(<ScopingTable rows={[makeRow()]} />);
    expect(html).toContain("<table");
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody>");
    for (const col of ["Scope", "Scope ID", "Key", "Value", "Set by", "Updated"]) {
      expect(html).toContain(`${col}</th>`);
    }
  });

  test("rows stay semantic <tr> -- no role/tabindex/aria-label override", () => {
    // Regression: the first iteration used role="button"+tabIndex on the
    // <tr>, which orphans <td> children from the table grid (ARIA
    // role-override anti-pattern). Inspect action moved to a dedicated
    // button cell.
    const html = renderToString(<ScopingTable rows={[makeRow()]} onRowClick={noop} />);
    expect(html).not.toMatch(/<tr[^>]*role="button"/);
    expect(html).not.toMatch(/<tr[^>]*tabindex/i);
    expect(html).not.toMatch(/<tr[^>]*aria-label/);
  });

  test("interactive row renders an Inspect button cell with proper a11y", () => {
    const html = renderToString(<ScopingTable rows={[makeRow()]} onRowClick={noop} />);
    expect(html).toContain(">Inspect</button>");
    expect(html).toMatch(/aria-label="Inspect[^"]+"/);
  });

  test("non-interactive table (no onRowClick) omits the Inspect button", () => {
    const html = renderToString(<ScopingTable rows={[makeRow()]} />);
    expect(html).not.toContain(">Inspect</button>");
  });

  test("tombstoned row gets the deleted badge", () => {
    const rows = [
      makeRow({
        id: "s-dead",
        deleted_at: "2026-05-11T01:00:00Z",
        deleted_by: "u-yana",
      }),
    ];
    const html = renderToString(<ScopingTable rows={rows} />);
    // Badge text + visual treatment (line-through / opacity-60 via class).
    expect(html.toLowerCase()).toContain(">deleted</span>");
    expect(html).toMatch(/opacity-60|line-through/);
  });

  test("array values render as compact one-line form", () => {
    const rows = [makeRow({ value_json: '["docs","fix-bug","pr-review"]' })];
    const html = renderToString(<ScopingTable rows={rows} />);
    // Compact form should NOT contain JSON quotes around individual items.
    expect(html).toContain("[docs, fix-bug, pr-review]");
  });

  test("object values are JSON-stringified and truncated past 60 chars", () => {
    const big = JSON.stringify({ a: 1, b: 2, longish_key_to_push_us_over: "value-value-value-value" });
    const rows = [makeRow({ value_json: big })];
    const html = renderToString(<ScopingTable rows={rows} />);
    expect(html).toContain("...");
    // Original full JSON is on the title attribute for hover-reveal.
    expect(html).toContain(`title="${big.replace(/"/g, "&quot;")}"`);
  });
});
