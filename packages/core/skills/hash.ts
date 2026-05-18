/**
 * Canonical-bundle hasher for Skill Hub.
 *
 * THE source of truth for skill hashing. Imported by both the server
 * (during skill/put to compute skills.current_hash) and the CLI (to
 * compute local_hash before skill/sync_status). If both sides ever
 * diverge in canonicalization, every sync looks like a conflict.
 *
 * The hash is sha256 over a CanonicalBundle serialized as JSON with
 * deeply-sorted keys and no whitespace. Hashes the NORMALIZED bundle
 * (post-normalizer), never the raw harness-flavored input. See §7 of
 * docs/skillhub-rfc.md.
 */

import { createHash } from "node:crypto";

export interface SupportingFile {
  path: string;
  content: string;
}

export interface CanonicalBundle {
  body: string;
  supporting_files: SupportingFile[];
}

/**
 * Recursive deterministic key sort. Arrays preserve their element order
 * (callers control that), object keys are sorted lexically at every level.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Stable canonical JSON: sorted keys, no whitespace.
 * Exposed so tests can assert the canonical form independently of the hash.
 */
export function canonicalize(bundle: CanonicalBundle): string {
  // Supporting files are sorted by path so caller order doesn't affect the hash.
  const sortedSupporting = [...bundle.supporting_files].sort((a, b) => a.path.localeCompare(b.path));
  const normalized = {
    body: bundle.body,
    supporting_files: sortedSupporting,
  };
  return JSON.stringify(sortKeysDeep(normalized));
}

/**
 * sha256(canonicalize(bundle)) as a lowercase hex string.
 * Both server and CLI MUST import this same function; reimplementing it
 * elsewhere risks hash drift.
 */
export function hashCanonicalBundle(bundle: CanonicalBundle): string {
  const json = canonicalize(bundle);
  return createHash("sha256").update(json, "utf8").digest("hex");
}
