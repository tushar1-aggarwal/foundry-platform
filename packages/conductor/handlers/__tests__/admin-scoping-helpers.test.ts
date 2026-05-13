/**
 * Unit tests for the pure helpers under `admin/scoping/*` -- isolates
 * the probe / truncation math from the handler so we can cover the
 * boundary cases without seeding `DEFAULT_LIST_LIMIT` rows.
 */

import { describe, it, expect } from "bun:test";
import { applyListProbe } from "../admin-scoping.js";

describe("applyListProbe", () => {
  it("returns rows unchanged + truncated=false when probe.length < cap", () => {
    const out = applyListProbe([1, 2], 5);
    expect(out.rows).toEqual([1, 2]);
    expect(out.truncated).toBe(false);
  });

  it("returns rows unchanged + truncated=false when probe.length === cap", () => {
    // Boundary: caller asked for cap+1, but only cap rows came back ->
    // no further rows exist; not truncated.
    const out = applyListProbe([1, 2, 3], 3);
    expect(out.rows).toEqual([1, 2, 3]);
    expect(out.truncated).toBe(false);
  });

  it("trims the extra row + sets truncated=true when probe.length === cap + 1", () => {
    // The handler always queries cap+1; this case is the proof that more
    // rows existed beyond the cap.
    const out = applyListProbe([1, 2, 3, 4], 3);
    expect(out.rows).toEqual([1, 2, 3]);
    expect(out.truncated).toBe(true);
  });

  it("empty probe -> empty rows, truncated=false", () => {
    const out = applyListProbe([], 3);
    expect(out.rows).toEqual([]);
    expect(out.truncated).toBe(false);
  });
});
