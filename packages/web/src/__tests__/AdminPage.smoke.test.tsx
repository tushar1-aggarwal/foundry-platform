import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { MockTransport } from "../transport/MockTransport.js";
import { TransportProvider } from "../transport/TransportContext.js";
import { AdminPage } from "../pages/AdminPage.js";

/**
 * Smoke test: AdminPage SSR-renders without throwing.
 *
 * AdminPage role-gates on `useOptionalAuth()?.identity?.role`. Without
 * an AuthProvider mounted, that resolves to null, so the page renders
 * the "Admin only" placeholder branch. The smoke test asserts the
 * page mounts cleanly in that anonymous-context branch -- the admin-
 * branch markup (tab list, sub-tab content) is exercised in
 * `AdminPage.roleGate.test.tsx`.
 */

describe("AdminPage smoke", () => {
  test("renders without throwing (anonymous context branch)", () => {
    const transport = new MockTransport()
      .register("admin/tenant/list", () => ({ tenants: [] }))
      .register("admin/team/list", () => ({ teams: [] }))
      .register("admin/user/list", () => ({ users: [] }))
      .register("admin/scoping/list", () => ({ rows: [], truncated: false }));

    let html: string | null = null;
    let err: Error | null = null;
    try {
      html = renderToString(
        <TransportProvider transport={transport}>
          <AdminPage view="admin" onNavigate={() => {}} readOnly={false} />
        </TransportProvider>,
      );
    } catch (e) {
      err = e as Error;
    }
    if (err) console.log("THROWN:", err.message, "\n", err.stack);
    expect(err).toBeNull();
    expect(html).not.toBeNull();
    expect(html!.length).toBeGreaterThan(200);
  });
});
