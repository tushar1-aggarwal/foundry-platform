/**
 * `buildNavItems` -- role-gated sidebar composition.
 *
 * Pure-function tests. Covers:
 *   - Anonymous (null role) -> Admin entry NOT present.
 *   - member / viewer / worker -> Admin entry NOT present.
 *   - admin -> Admin entry appended at the end.
 *   - Unread badge merges onto the Sessions entry without affecting
 *     the admin gate.
 *
 * No DOM, no React render; the function returns IconRailItem[] which we
 * inspect by `.id` / `.label` / `.badge` directly.
 */

import { describe, test, expect } from "bun:test";
import { buildNavItems } from "../components/Layout.js";

describe("buildNavItems", () => {
  test("no identity, no unread -> base 9 entries, no admin", () => {
    const items = buildNavItems(null, undefined);
    expect(items.map((i) => i.id)).toEqual([
      "sessions",
      "agents",
      "flows",
      "compute",
      "history",
      "tools",
      "schedules",
      "integrations",
      "costs",
    ]);
    expect(items.some((i) => i.id === "admin")).toBe(false);
  });

  test("member role -> no admin entry", () => {
    const items = buildNavItems("member", undefined);
    expect(items.some((i) => i.id === "admin")).toBe(false);
  });

  test("viewer role -> no admin entry", () => {
    const items = buildNavItems("viewer", undefined);
    expect(items.some((i) => i.id === "admin")).toBe(false);
  });

  test("worker role -> no admin entry", () => {
    // `worker` is a real role in the identity union (used by service callers);
    // it must NOT see the admin entry just because it's not member/viewer.
    const items = buildNavItems("worker", undefined);
    expect(items.some((i) => i.id === "admin")).toBe(false);
  });

  test("admin role -> admin entry appended at end", () => {
    const items = buildNavItems("admin", undefined);
    expect(items.length).toBe(10);
    expect(items[items.length - 1].id).toBe("admin");
    expect(items[items.length - 1].label).toBe("Admin");
  });

  test("admin role + unread badge -> admin appended AND sessions badged", () => {
    const items = buildNavItems("admin", 7);
    const sessions = items.find((i) => i.id === "sessions");
    const admin = items.find((i) => i.id === "admin");
    expect(sessions?.badge).toBe(7);
    expect(admin).toBeDefined();
    // The admin entry itself never gets a badge.
    expect(admin?.badge).toBeUndefined();
  });

  test("unread=0 is treated as no badge (no admin role either)", () => {
    // `totalUnread` is typed `number | undefined`; the production code
    // uses `if (!totalUnread)` so 0 collapses to "no badge". Pin that.
    const items = buildNavItems(null, 0);
    const sessions = items.find((i) => i.id === "sessions");
    expect(sessions?.badge).toBeUndefined();
  });
});
