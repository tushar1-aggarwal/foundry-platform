/**
 * Unit tests for the pure helpers in `admin-scoping-validators.ts`.
 * Whole-validator behavior is covered by `admin-scoping.test.ts`; this
 * file isolates the format/truncation logic so we can exercise it
 * without seeding 20+ flows into a real flow store.
 */

import { describe, it, expect } from "bun:test";
import { formatKnownOptionsHint } from "../admin-scoping-validators.js";

describe("formatKnownOptionsHint", () => {
  it("returns empty string when the catalog is empty", () => {
    expect(formatKnownOptionsHint([], 20)).toBe("");
  });

  it("joins all entries when length <= max", () => {
    expect(formatKnownOptionsHint(["b", "a", "c"], 20)).toBe("a, b, c");
  });

  it("sorts entries deterministically before joining", () => {
    expect(formatKnownOptionsHint(["zebra", "apple", "mango"], 20)).toBe("apple, mango, zebra");
  });

  it("truncates and appends '(and N more)' when length > max", () => {
    // max=2 against 5 known entries: deterministic alphabetical order
    // means the visible head is `a, b` and the tail counts the 3 hidden.
    const out = formatKnownOptionsHint(["e", "a", "d", "b", "c"], 2);
    expect(out).toBe("a, b, ... (and 3 more)");
  });

  it("boundary: length === max prints all entries with no suffix", () => {
    expect(formatKnownOptionsHint(["a", "b", "c"], 3)).toBe("a, b, c");
  });

  it("boundary: length === max + 1 prints the suffix with N=1", () => {
    expect(formatKnownOptionsHint(["a", "b", "c", "d"], 3)).toBe("a, b, c, ... (and 1 more)");
  });
});
