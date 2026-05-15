import { describe, test, expect } from "bun:test";
import { tenantPath, teamPath, userPath, parsePath, validateSegment, validateKey, MAX_PATH_LENGTH } from "../paths.js";

describe("path helpers", () => {
  test("round-trip tenant path", () => {
    const p = tenantPath("default", "ANTHROPIC_API_KEY");
    expect(p).toBe("/ark/default/tenant/ANTHROPIC_API_KEY");
    expect(parsePath(p)).toEqual({ scope: "tenant", tenantId: "default", key: "ANTHROPIC_API_KEY" });
  });

  test("round-trip team path (single + multi segment)", () => {
    const p1 = teamPath("acme", ["eng"], "API_KEY");
    expect(p1).toBe("/ark/acme/teams/eng/API_KEY");
    expect(parsePath(p1)).toEqual({ scope: "team", tenantId: "acme", segments: ["eng"], key: "API_KEY" });

    const p2 = teamPath("acme", ["eng", "infra", "platform"], "DB_URL");
    expect(p2).toBe("/ark/acme/teams/eng/infra/platform/DB_URL");
    expect(parsePath(p2)).toEqual({
      scope: "team",
      tenantId: "acme",
      segments: ["eng", "infra", "platform"],
      key: "DB_URL",
    });
  });

  test("round-trip user path", () => {
    const p = userPath("acme", "u1", "TOKEN");
    expect(p).toBe("/ark/acme/users/u1/TOKEN");
    expect(parsePath(p)).toEqual({ scope: "user", tenantId: "acme", userId: "u1", key: "TOKEN" });
  });

  test("rejects traversal-shaped segments", () => {
    expect(() => tenantPath("..", "K")).toThrow();
    expect(() => teamPath("t", [".."], "K")).toThrow();
    expect(() => teamPath("t", ["a/b"], "K")).toThrow();
    expect(() => userPath("t", ".hidden", "K")).toThrow();
    expect(() => validateSegment("a\\b")).toThrow();
    expect(() => validateSegment("")).toThrow();
    expect(() => validateSegment(".")).toThrow();
  });

  test("rejects keys not matching SECRET_NAME_RE", () => {
    expect(() => tenantPath("t", "lowercase")).toThrow();
    expect(() => tenantPath("t", "")).toThrow();
    expect(() => tenantPath("t", "WITH-DASH")).toThrow();
    expect(() => validateKey("WITH SPACE")).toThrow();
  });

  test("deepest legal path stays under the SSM 2048 limit", () => {
    // Build a deeply-nested path with 8-char segments and an 80-char key.
    const segments = Array(20).fill("eight888");
    const key = "K".repeat(80);
    const p = teamPath("tenant-id", segments, key);
    expect(p.length).toBeLessThan(MAX_PATH_LENGTH);
    // And the limit is enforced when crossed
    const tooLong = Array(300).fill("eight888");
    expect(() => teamPath("tenant", tooLong, "K")).toThrow();
  });

  test("parsePath returns null for shapes outside the convention", () => {
    expect(parsePath("/some/other/path")).toBeNull();
    expect(parsePath("/ark/t/unknown/X/KEY")).toBeNull();
    expect(parsePath("/ark/t/teams/KEY")).toBeNull(); // missing segments
    expect(parsePath("/ark/t/tenant/lowercase")).toBeNull();
    expect(parsePath("/ark//tenant/KEY")).toBeNull();
  });
});
