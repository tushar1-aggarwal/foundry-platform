/**
 * Tests for packages/core/skills/hash.ts — the canonical-bundle hasher.
 *
 * Covers: determinism, order-independence of supporting_files, key-order
 * invariance, content sensitivity. Pinning these is critical — both
 * server and CLI import this module; any drift breaks sync_status.
 */

import { describe, it, expect } from "bun:test";
import { canonicalize, hashCanonicalBundle, type CanonicalBundle } from "../skills/hash.js";

const baseBundle: CanonicalBundle = {
  body: "# code-review\n\nReview the diff and flag issues.\n",
  supporting_files: [
    { path: "references/severity.md", content: "P0 = blocker; P3 = nit." },
    { path: "scripts/run.sh", content: "#!/bin/sh\necho hi" },
  ],
};

describe("skill canonical-bundle hasher", () => {
  it("is deterministic across calls", () => {
    const a = hashCanonicalBundle(baseBundle);
    const b = hashCanonicalBundle(baseBundle);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is insensitive to supporting_files caller order", () => {
    const reordered: CanonicalBundle = {
      body: baseBundle.body,
      supporting_files: [
        { path: "scripts/run.sh", content: "#!/bin/sh\necho hi" },
        { path: "references/severity.md", content: "P0 = blocker; P3 = nit." },
      ],
    };
    expect(hashCanonicalBundle(reordered)).toBe(hashCanonicalBundle(baseBundle));
  });

  it("changes when the body changes", () => {
    const changed: CanonicalBundle = { ...baseBundle, body: baseBundle.body + " edited" };
    expect(hashCanonicalBundle(changed)).not.toBe(hashCanonicalBundle(baseBundle));
  });

  it("changes when a supporting file's content changes", () => {
    const changed: CanonicalBundle = {
      body: baseBundle.body,
      supporting_files: [
        { path: "references/severity.md", content: "DIFFERENT" },
        { path: "scripts/run.sh", content: "#!/bin/sh\necho hi" },
      ],
    };
    expect(hashCanonicalBundle(changed)).not.toBe(hashCanonicalBundle(baseBundle));
  });

  it("changes when a supporting file's path changes", () => {
    const changed: CanonicalBundle = {
      body: baseBundle.body,
      supporting_files: [
        { path: "references/severity-new.md", content: "P0 = blocker; P3 = nit." },
        { path: "scripts/run.sh", content: "#!/bin/sh\necho hi" },
      ],
    };
    expect(hashCanonicalBundle(changed)).not.toBe(hashCanonicalBundle(baseBundle));
  });

  it("changes when supporting files are added or removed", () => {
    const removed: CanonicalBundle = {
      body: baseBundle.body,
      supporting_files: [{ path: "references/severity.md", content: "P0 = blocker; P3 = nit." }],
    };
    expect(hashCanonicalBundle(removed)).not.toBe(hashCanonicalBundle(baseBundle));
  });

  it("hash is sensitive to body whitespace", () => {
    // The canonical form preserves the body verbatim (only key-ordering
    // is canonicalized). A trailing newline changes the hash.
    const a: CanonicalBundle = { body: "hello", supporting_files: [] };
    const b: CanonicalBundle = { body: "hello\n", supporting_files: [] };
    expect(hashCanonicalBundle(a)).not.toBe(hashCanonicalBundle(b));
  });

  it("canonicalize() produces sorted-key JSON with no whitespace", () => {
    const json = canonicalize(baseBundle);
    // No whitespace between fields.
    expect(json).not.toContain(": ");
    expect(json).not.toContain(", ");
    // Top-level keys appear in sorted order: body before supporting_files.
    expect(json.indexOf('"body"')).toBeLessThan(json.indexOf('"supporting_files"'));
    // Supporting files appear in sorted-by-path order.
    expect(json.indexOf("references/severity.md")).toBeLessThan(json.indexOf("scripts/run.sh"));
  });
});
