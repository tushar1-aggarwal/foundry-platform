/**
 * AdminPage role-gate test.
 *
 * The sidebar entry is hidden for non-admins by `buildNavItems`, but
 * `#/admin` is still reachable via direct URL paste, CMD-K palette,
 * deep-link, and bookmarks. The page itself must role-gate to avoid
 * a non-admin landing there and seeing four empty tables + a flood
 * of FORBIDDEN toasts as each tab's RPC fires.
 *
 * SSR-only contract test: we don't mount AuthProvider; instead we
 * verify that the page surface reads from `useOptionalAuth()` and
 * branches on role. The contract: when no admin role is present in
 * context, the page renders the "Admin only" placeholder INSTEAD of
 * the tab list. Anonymous (no AuthProvider mounted at all) hits the
 * same branch.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockTransport } from "../transport/MockTransport.js";
import { TransportProvider } from "../transport/TransportContext.js";
import { AuthContext, type AuthContextValue } from "../auth/AuthContext.js";
import { AdminPage } from "../pages/AdminPage.js";
import type { Identity } from "../auth/whoami.js";

function freshQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function makeAuthContext(identity: Identity | null): AuthContextValue {
  return {
    status: identity ? "authed" : "anonymous",
    identity,
    refresh: async () => {},
    signOut: () => {},
  };
}

function mountAnonymous(): string {
  const transport = new MockTransport()
    .register("admin/tenant/list", () => ({ tenants: [] }))
    .register("admin/team/list", () => ({ teams: [] }))
    .register("admin/user/list", () => ({ users: [] }))
    .register("admin/scoping/list", () => ({ rows: [], truncated: false }));
  return renderToString(
    <QueryClientProvider client={freshQueryClient()}>
      <TransportProvider transport={transport}>
        <AdminPage view="admin" onNavigate={() => {}} readOnly={false} />
      </TransportProvider>
    </QueryClientProvider>,
  );
}

function mountWithRole(role: Identity["role"]): string {
  const transport = new MockTransport()
    .register("admin/tenant/list", () => ({ tenants: [] }))
    .register("admin/team/list", () => ({ teams: [] }))
    .register("admin/user/list", () => ({ users: [] }))
    .register("admin/scoping/list", () => ({ rows: [], truncated: false }));
  const identity: Identity = { userId: "u-test", email: "t@p.com", tenantId: "default", role };
  return renderToString(
    <QueryClientProvider client={freshQueryClient()}>
      <TransportProvider transport={transport}>
        <AuthContext.Provider value={makeAuthContext(identity)}>
          <AdminPage view="admin" onNavigate={() => {}} readOnly={false} />
        </AuthContext.Provider>
      </TransportProvider>
    </QueryClientProvider>,
  );
}

describe("AdminPage role gate", () => {
  test("anonymous (no AuthProvider) -> Admin-only placeholder", () => {
    const html = mountAnonymous();
    expect(html).toContain("Admin only");
    expect(html).toMatch(/Back to Sessions/);
  });

  test("member role -> Admin-only placeholder, no tab list", () => {
    const html = mountWithRole("member");
    expect(html).toContain("Admin only");
    // The ContentTabs header is skipped entirely in the role-gated
    // branch, so the four sub-tab labels do NOT render.
    for (const label of ["Tenants</button>", "Teams</button>", "Users</button>", "Scoping</button>"]) {
      expect(html).not.toContain(label);
    }
  });

  test("viewer role -> Admin-only placeholder", () => {
    const html = mountWithRole("viewer");
    expect(html).toContain("Admin only");
  });

  test("admin role -> tab list renders, no placeholder", () => {
    const html = mountWithRole("admin");
    expect(html).not.toContain("Admin only");
    // All four sub-tab labels appear in the ContentTabs header.
    for (const label of ["Tenants", "Teams", "Users", "Scoping"]) {
      expect(html).toContain(label);
    }
  });
});
