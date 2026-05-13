/**
 * `parseHash` regression tests.
 *
 * Pre-existing bug surfaced 2026-05-11: `admin` was absent from
 * `VALID_VIEWS`, so direct-URL access to `#/admin` and `navigate("admin")`
 * both silently fell back to `view: "sessions"`. AdminPage was reachable
 * only via the optimistic state update inside `navigate()` on the very
 * first call -- the next `hashchange` event clobbered it back to
 * `sessions`. The fix added `admin` to the allowlist; these tests pin
 * the allowlist behavior so future contributors don't reintroduce it.
 */

import { describe, test, expect, beforeEach } from "bun:test";

// bun:test does not have a DOM; stub the window shape the hook reads.
(globalThis as any).window = (globalThis as any).window ?? { location: { hash: "" } };

import { parseHash } from "../hooks/useHashRouter.js";

function setHash(value: string) {
  (window as unknown as { location: { hash: string } }).location.hash = value;
}

beforeEach(() => setHash(""));

describe("parseHash", () => {
  test("empty hash -> default sessions view", () => {
    setHash("");
    expect(parseHash()).toEqual({ view: "sessions", subId: null, tab: null });
  });

  test("recognised view -> returned verbatim", () => {
    setHash("#/agents");
    expect(parseHash()).toEqual({ view: "agents", subId: null, tab: null });
  });

  test("admin view is in the allowlist (regression)", () => {
    setHash("#/admin");
    expect(parseHash()).toEqual({ view: "admin", subId: null, tab: null });
  });

  test("unknown view -> falls back to sessions (existing safety)", () => {
    setHash("#/ghost-view-name");
    expect(parseHash()).toEqual({ view: "sessions", subId: null, tab: null });
  });

  test("legacy #/dashboard redirects to sessions", () => {
    setHash("#/dashboard");
    expect(parseHash()).toEqual({ view: "sessions", subId: null, tab: null });
  });

  test("subId + tab parsed from hash segments", () => {
    setHash("#/agents/agent-1/runtimes");
    expect(parseHash()).toEqual({ view: "agents", subId: "agent-1", tab: "runtimes" });
  });

  test("empty subId allows tab-only routing (e.g. #/agents//runtimes)", () => {
    setHash("#/agents//runtimes");
    expect(parseHash()).toEqual({ view: "agents", subId: null, tab: "runtimes" });
  });
});
