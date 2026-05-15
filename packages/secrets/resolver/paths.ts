/**
 * Path-convention helpers for the hierarchical secrets resolver.
 *
 * Layout:
 *   /ark/<tenantId>/tenant/<KEY>
 *   /ark/<tenantId>/teams/<segment>[/<segment>...]/<KEY>
 *   /ark/<tenantId>/users/<userId>/<KEY>
 *
 * `tenantId`, every team `segment`, and `userId` are scope segments and must
 * match SCOPE_SEGMENT_RE. KEY validation uses SECRET_NAME_RE (existing
 * `[A-Z0-9_]+`) so legacy flat names keep reading; the source plan's stricter
 * `[A-Z][A-Z0-9_]*` is enforced at write time by callers (CLI) when desired.
 *
 * Pure functions, no IO. Hard-fails on any traversal-shaped segment, leading
 * dots, or values that would push the assembled path over 2048 chars.
 */

import { SECRET_NAME_RE, SCOPE_SEGMENT_RE } from "../../core/secrets/types.js";

/** SSM Parameter Store hard limit on full parameter names. */
export const MAX_PATH_LENGTH = 2048;

export type ParsedPath =
  | { scope: "tenant"; tenantId: string; key: string }
  | { scope: "team"; tenantId: string; segments: string[]; key: string }
  | { scope: "user"; tenantId: string; userId: string; key: string };

export function validateSegment(segment: string, fieldName = "segment"): void {
  if (typeof segment !== "string" || segment.length === 0) {
    throw new Error(`Invalid ${fieldName}: must be a non-empty string`);
  }
  if (segment === "." || segment === "..") {
    throw new Error(`Invalid ${fieldName} '${segment}': must not be '.' or '..'`);
  }
  if (segment.startsWith(".")) {
    throw new Error(`Invalid ${fieldName} '${segment}': must not start with '.'`);
  }
  if (segment.includes("/") || segment.includes("\\")) {
    throw new Error(`Invalid ${fieldName} '${segment}': must not contain path separators`);
  }
  if (!SCOPE_SEGMENT_RE.test(segment)) {
    throw new Error(
      `Invalid ${fieldName} '${segment}': must match [a-z0-9][a-z0-9-]{0,62} (lowercase kebab-case, <= 63 chars)`,
    );
  }
}

export function validateKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Secret key must be a non-empty string");
  }
  if (!SECRET_NAME_RE.test(key)) {
    throw new Error(`Invalid secret key '${key}': must match [A-Z0-9_]+ (uppercase ASCII, digits, underscore)`);
  }
}

function assertLength(p: string): string {
  if (p.length > MAX_PATH_LENGTH) {
    throw new Error(
      `Secret path is ${p.length} chars, exceeds the ${MAX_PATH_LENGTH}-char limit: ${p.slice(0, 80)}...`,
    );
  }
  return p;
}

export function tenantPath(tenantId: string, key: string): string {
  validateSegment(tenantId, "tenantId");
  validateKey(key);
  return assertLength(`/ark/${tenantId}/tenant/${key}`);
}

export function tenantPrefix(tenantId: string): string {
  validateSegment(tenantId, "tenantId");
  return `/ark/${tenantId}/tenant/`;
}

export function teamPath(tenantId: string, segments: readonly string[], key: string): string {
  validateSegment(tenantId, "tenantId");
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("Team path requires at least one segment");
  }
  for (const s of segments) validateSegment(s, "team segment");
  validateKey(key);
  return assertLength(`/ark/${tenantId}/teams/${segments.join("/")}/${key}`);
}

export function teamPrefix(tenantId: string, segments: readonly string[]): string {
  validateSegment(tenantId, "tenantId");
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("Team prefix requires at least one segment");
  }
  for (const s of segments) validateSegment(s, "team segment");
  return `/ark/${tenantId}/teams/${segments.join("/")}/`;
}

export function userPath(tenantId: string, userId: string, key: string): string {
  validateSegment(tenantId, "tenantId");
  validateSegment(userId, "userId");
  validateKey(key);
  return assertLength(`/ark/${tenantId}/users/${userId}/${key}`);
}

export function userPrefix(tenantId: string, userId: string): string {
  validateSegment(tenantId, "tenantId");
  validateSegment(userId, "userId");
  return `/ark/${tenantId}/users/${userId}/`;
}

/**
 * Parse a full path back into its structured shape. Returns null when the
 * path is not in the expected `/ark/<tid>/{tenant|teams/<...>|users/<uid>}/<KEY>`
 * shape -- callers can treat that as "skip this entry".
 */
export function parsePath(path: string): ParsedPath | null {
  if (typeof path !== "string" || !path.startsWith("/ark/")) return null;
  const parts = path.split("/");
  // ["", "ark", tenantId, scope, ...]
  if (parts.length < 5) return null;
  if (parts[0] !== "" || parts[1] !== "ark") return null;
  const tenantId = parts[2];
  if (!tenantId) return null;
  const scope = parts[3];
  const key = parts[parts.length - 1];
  if (!key) return null;
  if (!SECRET_NAME_RE.test(key)) return null;
  try {
    if (scope === "tenant") {
      // /ark/<tid>/tenant/<KEY>
      if (parts.length !== 5) return null;
      validateSegment(tenantId, "tenantId");
      return { scope: "tenant", tenantId, key };
    }
    if (scope === "users") {
      // /ark/<tid>/users/<uid>/<KEY>
      if (parts.length !== 6) return null;
      const userId = parts[4];
      validateSegment(tenantId, "tenantId");
      validateSegment(userId, "userId");
      return { scope: "user", tenantId, userId, key };
    }
    if (scope === "teams") {
      // /ark/<tid>/teams/<seg>[/<seg>...]/<KEY>
      if (parts.length < 6) return null;
      const segments = parts.slice(4, parts.length - 1);
      if (segments.length === 0) return null;
      validateSegment(tenantId, "tenantId");
      for (const s of segments) validateSegment(s, "team segment");
      return { scope: "team", tenantId, segments, key };
    }
  } catch {
    return null;
  }
  return null;
}
