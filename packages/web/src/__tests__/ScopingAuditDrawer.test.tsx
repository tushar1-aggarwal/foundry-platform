/**
 * `ScopingAuditDrawerPanel` SSR tests.
 *
 * We test the inner panel (not the outer drawer) so we don't have to
 * mount a portal under `renderToString`. The outer `ScopingAuditDrawer`
 * is just a `null`-or-portal wrapper around the same panel; portal
 * rendering under SSR is a no-op, so testing the panel directly is the
 * right level of coverage. Focus-trap effects don't fire under SSR
 * either -- their behavior is exercised manually in the E2E pass at
 * the end of the batch.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { ScopingAuditDrawerPanel } from "../components/admin/ScopingAuditDrawer.js";
import type { ScopingOverrideRow } from "../components/admin/types.js";

function makeRow(over: Partial<ScopingOverrideRow> = {}): ScopingOverrideRow {
  return {
    id: "s-abc123",
    scope_kind: "user",
    scope_id: "u-rachna",
    key: "runtime",
    value_json: JSON.stringify("codex"),
    tenant_id: "default",
    created_at: "2026-05-10T08:00:00Z",
    updated_at: "2026-05-11T16:30:45Z",
    deleted_at: null,
    set_by: "u-yana",
    deleted_by: null,
    ...over,
  };
}

const noop = () => {};

describe("ScopingAuditDrawerPanel", () => {
  test("mounts as a dialog with aria-modal + aria-labelledby", () => {
    const html = renderToString(<ScopingAuditDrawerPanel row={makeRow()} onClose={noop} />);
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toMatch(/aria-labelledby="scoping-audit-drawer-title-/);
  });

  test("title row combines scope_kind / scope_id / key", () => {
    const html = renderToString(
      <ScopingAuditDrawerPanel
        row={makeRow({ scope_kind: "team", scope_id: "tm-eng", key: "flow.allowlist" })}
        onClose={noop}
      />,
    );
    expect(html).toMatch(/team.*tm-eng.*flow\.allowlist/);
  });

  test("close button has accessible label", () => {
    const html = renderToString(<ScopingAuditDrawerPanel row={makeRow()} onClose={noop} />);
    expect(html).toContain('aria-label="Close audit drawer"');
  });

  test("renders every live-row audit field", () => {
    const html = renderToString(<ScopingAuditDrawerPanel row={makeRow()} onClose={noop} />);
    for (const label of ["ID", "Tenant", "Scope kind", "Scope ID", "Key", "Set by", "Created", "Updated"]) {
      expect(html).toContain(`>${label}</div>`);
    }
    // Live row -- no "Deleted at" / "Deleted by" panels.
    expect(html).not.toContain(">Deleted at</div>");
    expect(html).not.toContain(">Deleted by</div>");
  });

  test("tombstone row shows the deleted badge + deleted_at/by fields", () => {
    const html = renderToString(
      <ScopingAuditDrawerPanel
        row={makeRow({
          deleted_at: "2026-05-11T17:00:00Z",
          deleted_by: "u-deleter",
        })}
        onClose={noop}
      />,
    );
    expect(html.toLowerCase()).toContain(">deleted</span>");
    expect(html).toContain(">Deleted at</div>");
    expect(html).toContain(">Deleted by</div>");
    // Tombstones don't show Edit / Delete buttons.
    expect(html).not.toContain(">Edit</button>");
    expect(html).not.toContain(">Delete</button>");
  });

  test("value pre-block contains pretty-printed JSON of value_json", () => {
    const html = renderToString(
      <ScopingAuditDrawerPanel row={makeRow({ value_json: '["docs","fix-bug"]' })} onClose={noop} />,
    );
    // Pretty-printed array spans multiple lines with two-space indent.
    expect(html).toContain("<pre");
    expect(html).toContain("&quot;docs&quot;");
    expect(html).toContain("&quot;fix-bug&quot;");
  });

  test("Edit + Delete buttons render only when handlers are passed (live row)", () => {
    const htmlWith = renderToString(
      <ScopingAuditDrawerPanel row={makeRow()} onClose={noop} onEdit={noop} onDelete={noop} />,
    );
    expect(htmlWith).toContain(">Edit</button>");
    expect(htmlWith).toContain(">Delete</button>");

    const htmlWithout = renderToString(<ScopingAuditDrawerPanel row={makeRow()} onClose={noop} />);
    expect(htmlWithout).not.toContain(">Edit</button>");
    expect(htmlWithout).not.toContain(">Delete</button>");
  });

  test("set_by null renders the (unknown) placeholder", () => {
    const html = renderToString(<ScopingAuditDrawerPanel row={makeRow({ set_by: null })} onClose={noop} />);
    expect(html).toContain("(unknown)");
  });
});
