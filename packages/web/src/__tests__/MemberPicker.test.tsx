/**
 * `MemberPicker` -- SSR initial-render contract.
 *
 * The picker's interesting behaviour (debounced search, picked-state
 * transitions, button-mode flip) is driven by `useEffect` + user
 * interaction and isn't exercised under SSR. The integration tests
 * for the underlying `admin/team/members/search` endpoint already
 * cover the data shape and tenant scoping. Here we just lock in the
 * surface a user sees on first render: ARIA roles for accessibility,
 * the role dropdown, the empty/disabled Add button, and the 3-char
 * placeholder copy that documents the threshold.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { MockTransport } from "../transport/MockTransport.js";
import { TransportProvider } from "../transport/TransportContext.js";
import { MemberPicker } from "../components/admin/MemberPicker.js";

function mount(): string {
  const transport = new MockTransport();
  // The picker's effects don't run under SSR, but the TransportProvider
  // still needs a transport to construct the context.
  return renderToString(
    <TransportProvider transport={transport}>
      <MemberPicker teamId="tm-test" onAdded={() => {}} />
    </TransportProvider>,
  );
}

describe("MemberPicker (SSR initial render)", () => {
  test("renders the combobox input with the 3-char hint in the placeholder", () => {
    const html = mount();
    expect(html).toContain('role="combobox"');
    expect(html).toMatch(/Type[^"]*3 chars/);
  });

  test("renders the role dropdown with all four roles", () => {
    const html = mount();
    for (const role of ["owner", "admin", "member", "viewer"]) {
      expect(html).toContain(`>${role}<`);
    }
  });

  test('renders the Add button in the disabled "pick a user" state', () => {
    const html = mount();
    // No picked user + empty query => disabled-empty mode + label "Add".
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:<[^>]*>)*\s*Add\s*<\/button>/);
    // The hover-title documents WHY the button is disabled so an admin
    // who tabs onto it understands what's expected.
    expect(html).toContain("Pick a user or type a new email");
  });

  test("dropdown is closed on first render (aria-expanded=false)", () => {
    const html = mount();
    expect(html).toContain('aria-expanded="false"');
    // listbox panel is conditionally rendered; absence is the contract.
    expect(html).not.toContain('role="listbox"');
  });
});
