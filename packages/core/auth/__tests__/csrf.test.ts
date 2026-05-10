import { describe, it, expect } from "bun:test";
import { generateState, validateState } from "../csrf.js";

describe("generateState", () => {
  it("returns 64 hex characters (32 bytes of entropy)", () => {
    const s = generateState();
    expect(s).toHaveLength(64);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });

  it("produces unique values across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateState());
    expect(seen.size).toBe(1000);
  });
});

describe("validateState", () => {
  it("returns true for matching tokens", () => {
    const t = generateState();
    expect(validateState(t, t)).toBe(true);
  });

  it("returns false for mismatching tokens of equal length", () => {
    const a = generateState();
    const b = generateState();
    expect(validateState(a, b)).toBe(false);
  });

  it("returns false on length mismatch", () => {
    expect(validateState("aaaa", "aaaaaa")).toBe(false);
  });

  it("returns false on null / empty / undefined", () => {
    expect(validateState(null, "abc")).toBe(false);
    expect(validateState("abc", null)).toBe(false);
    expect(validateState(undefined, "abc")).toBe(false);
    expect(validateState("abc", undefined)).toBe(false);
    expect(validateState("", "")).toBe(false);
    expect(validateState(null, null)).toBe(false);
  });
});
