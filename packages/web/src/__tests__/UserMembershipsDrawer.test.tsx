/**
 * `UserMembershipsDrawer` -- SSR initial-render contract.
 *
 * The drawer is a portal under real DOM; under `renderToString`,
 * portals are no-ops, so we render the inner `Panel` directly with
 * synthesized props to inspect the markup. Interactive behaviour
 * (effects firing, role changes, add-to-team form) is exercised by
 * manual testing in the dev server; the server-side handler tests
 * already cover the data shape for `admin/user/memberships`.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { MockTransport } from "../transport/MockTransport.js";
import { TransportProvider } from "../transport/TransportContext.js";
import { UserMembershipsDrawerPanel } from "../components/admin/UserMembershipsDrawer.js";
import type { User } from "../components/admin/types.js";

function makeUser(over: Partial<User> = {}): User {
  return {
    id: "u-drawer-1",
    email: "drawer@example.com",
    name: "Drawer Test",
    created_at: "2026-05-10T00:00:00Z",
    updated_at: "2026-05-12T00:00:00Z",
    deleted_at: null,
    deleted_by: null,
    ...over,
  };
}

function mount(user: User): string {
  const transport = new MockTransport();
  return renderToString(
    <TransportProvider transport={transport}>
      <UserMembershipsDrawerPanel user={user} onClose={() => {}} />
    </TransportProvider>,
  );
}

describe("UserMembershipsDrawer (SSR initial render)", () => {
  test("renders the panel with role=dialog and aria-modal=true", () => {
    const html = mount(makeUser());
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });

  test("renders the user's email and name in the header", () => {
    const html = mount(makeUser({ email: "alice@x.com", name: "Alice A" }));
    expect(html).toContain("alice@x.com");
    expect(html).toContain("Alice A");
  });

  test("shows the loading state on first render (effects haven't fired under SSR)", () => {
    const html = mount(makeUser());
    expect(html).toMatch(/Loading memberships/i);
  });

  test("renders the '+ Add to team' button in the footer", () => {
    const html = mount(makeUser());
    expect(html).toMatch(/\+ Add to team/);
  });

  test("renders the backdrop with aria-hidden so SR users don't tab into it", () => {
    const html = mount(makeUser());
    expect(html).toContain('aria-hidden="true"');
  });
});
