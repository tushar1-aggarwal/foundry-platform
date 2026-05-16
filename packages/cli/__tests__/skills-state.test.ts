/**
 * Tests for the sync-state sidecar.
 *
 * Coverage:
 *   - sidecarPath: composes correctly, asserts safe keys
 *   - read: missing file -> null; happy path; malformed JSON; wrong shape
 *   - write: creates dir + file; round-trip; deterministic JSON
 *   - delete: idempotent, returns whether the file existed
 *   - list: walks the directory, skips corrupt files, harness filter
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SidecarError,
  _resetGitignoreWarningForTests,
  deleteSidecar,
  lastSyncPath,
  listSidecars,
  readLastSync,
  readSidecar,
  sidecarDir,
  sidecarPath,
  warnIfSidecarNotGitignored,
  writeLastSync,
  writeSidecar,
} from "../skills/state.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "skillhub-cli-state-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("sidecarPath / sidecarDir", () => {
  it("composes <repo>/.ark/skills-state/<harness>-<skill>.json", () => {
    expect(sidecarDir("/repo")).toBe("/repo/.ark/skills-state");
    expect(sidecarPath({ repoRoot: "/repo", harness: "claude", skillName: "code-review" })).toBe(
      "/repo/.ark/skills-state/claude-code-review.json",
    );
  });

  it("rejects harness with unsafe characters (slash, dot, space)", () => {
    expect(() => sidecarPath({ repoRoot: "/repo", harness: "../etc", skillName: "x" })).toThrow(SidecarError);
    expect(() => sidecarPath({ repoRoot: "/repo", harness: "claude code", skillName: "x" })).toThrow();
    expect(() => sidecarPath({ repoRoot: "/repo", harness: "claude.malicious", skillName: "x" })).toThrow();
  });

  it("rejects skill name with unsafe characters", () => {
    expect(() => sidecarPath({ repoRoot: "/repo", harness: "claude", skillName: "../escape" })).toThrow(SidecarError);
  });

  it("rejects harness id containing a hyphen (would silently misroute via the listSidecars split)", () => {
    // Future "claude-code" harness would otherwise produce
    // `claude-code-myskill.json`, which list/parse logic would split as
    // {harness: "claude", skillName: "code-myskill"}. Reject at write
    // time so the convention is machine-checkable.
    expect(() => sidecarPath({ repoRoot: "/repo", harness: "claude-code", skillName: "x" })).toThrow(SidecarError);
  });

  it("permits hyphens in skill name (kebab-case is the dominant convention)", () => {
    expect(() => sidecarPath({ repoRoot: "/repo", harness: "claude", skillName: "code-review-v2" })).not.toThrow();
  });
});

describe("readSidecar", () => {
  it("returns null when the file does not exist", () => {
    expect(readSidecar({ repoRoot, harness: "claude", skillName: "missing" })).toBeNull();
  });

  it("returns the parsed payload when present and well-formed", () => {
    writeSidecar({
      repoRoot,
      harness: "claude",
      skillName: "code-review",
      payload: { skill_id: "skl-abc123", current_hash: "sha256-foo" },
    });
    expect(readSidecar({ repoRoot, harness: "claude", skillName: "code-review" })).toEqual({
      skill_id: "skl-abc123",
      current_hash: "sha256-foo",
    });
  });

  it("throws SidecarError on malformed JSON", () => {
    mkdirSync(sidecarDir(repoRoot), { recursive: true });
    writeFileSync(join(sidecarDir(repoRoot), "claude-bad.json"), "{not valid json");
    expect(() => readSidecar({ repoRoot, harness: "claude", skillName: "bad" })).toThrow(/malformed JSON/);
  });

  it("throws SidecarError when required fields are missing", () => {
    mkdirSync(sidecarDir(repoRoot), { recursive: true });
    writeFileSync(join(sidecarDir(repoRoot), "claude-noid.json"), JSON.stringify({ current_hash: "x" }));
    expect(() => readSidecar({ repoRoot, harness: "claude", skillName: "noid" })).toThrow(/missing required fields/);
  });
});

describe("writeSidecar", () => {
  it("creates the state directory if needed and writes the payload", () => {
    expect(existsSync(sidecarDir(repoRoot))).toBe(false);
    writeSidecar({
      repoRoot,
      harness: "cursor",
      skillName: "deploy",
      payload: { skill_id: "skl-1", current_hash: "h1" },
    });
    expect(existsSync(sidecarDir(repoRoot))).toBe(true);
    expect(readSidecar({ repoRoot, harness: "cursor", skillName: "deploy" })).toEqual({
      skill_id: "skl-1",
      current_hash: "h1",
    });
  });

  it("overwrites an existing sidecar", () => {
    writeSidecar({ repoRoot, harness: "claude", skillName: "x", payload: { skill_id: "old", current_hash: "h0" } });
    writeSidecar({ repoRoot, harness: "claude", skillName: "x", payload: { skill_id: "new", current_hash: "h1" } });
    expect(readSidecar({ repoRoot, harness: "claude", skillName: "x" })).toEqual({
      skill_id: "new",
      current_hash: "h1",
    });
  });
});

describe("warnIfSidecarNotGitignored", () => {
  // Capture console.warn so the assertion can read what (if anything)
  // was emitted. Restore after each case to leave the environment
  // clean for sibling tests.
  let warnings: string[];
  let originalWarn: typeof console.warn;
  beforeEach(() => {
    warnings = [];
    originalWarn = console.warn;
    console.warn = (msg: unknown) => warnings.push(String(msg));
    _resetGitignoreWarningForTests();
  });
  afterEach(() => {
    console.warn = originalWarn;
  });

  it("silent when no .gitignore exists (don't gate on git infra)", () => {
    warnIfSidecarNotGitignored(repoRoot);
    expect(warnings).toEqual([]);
  });

  it("silent when .gitignore excludes `.ark/skills-state/`", () => {
    writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\n.ark/skills-state/\n");
    warnIfSidecarNotGitignored(repoRoot);
    expect(warnings).toEqual([]);
  });

  it("silent when .gitignore broadly excludes `.ark/`", () => {
    writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\n.ark/\n");
    warnIfSidecarNotGitignored(repoRoot);
    expect(warnings).toEqual([]);
  });

  it("warns once when .gitignore exists but does NOT exclude the sidecar dir", () => {
    writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\ndist/\n");
    warnIfSidecarNotGitignored(repoRoot);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(".ark/skills-state/");
    expect(warnings[0]).toContain("false-conflict");
    // Subsequent calls in the same process must NOT re-warn (avoid spam
    // across every put/sync within one CLI run).
    warnIfSidecarNotGitignored(repoRoot);
    warnIfSidecarNotGitignored(repoRoot);
    expect(warnings.length).toBe(1);
  });

  it("treats commented-out exclusion lines as not-excluded (only real patterns count)", () => {
    writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\n# .ark/skills-state/\n");
    warnIfSidecarNotGitignored(repoRoot);
    expect(warnings.length).toBe(1);
  });

  it("writeSidecar triggers the warning when gitignore lacks the exclusion", () => {
    writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\n");
    writeSidecar({
      repoRoot,
      harness: "claude",
      skillName: "x",
      payload: { skill_id: "skl-1", current_hash: "h1" },
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(".ark/skills-state/");
  });
});

describe("deleteSidecar", () => {
  it("returns true when a file was removed, false when absent", () => {
    writeSidecar({ repoRoot, harness: "claude", skillName: "gone", payload: { skill_id: "x", current_hash: "h" } });
    expect(deleteSidecar({ repoRoot, harness: "claude", skillName: "gone" })).toBe(true);
    expect(deleteSidecar({ repoRoot, harness: "claude", skillName: "gone" })).toBe(false);
    expect(readSidecar({ repoRoot, harness: "claude", skillName: "gone" })).toBeNull();
  });
});

describe("listSidecars", () => {
  it("returns empty when the state directory does not exist", () => {
    expect(listSidecars({ repoRoot })).toEqual([]);
  });

  it("walks every sidecar; harness name splits on the first hyphen so kebab-case skill names survive", () => {
    writeSidecar({
      repoRoot,
      harness: "claude",
      skillName: "code-review",
      payload: { skill_id: "skl-a", current_hash: "h-a" },
    });
    writeSidecar({
      repoRoot,
      harness: "claude",
      skillName: "deploy",
      payload: { skill_id: "skl-b", current_hash: "h-b" },
    });
    writeSidecar({
      repoRoot,
      harness: "cursor",
      skillName: "format",
      payload: { skill_id: "skl-c", current_hash: "h-c" },
    });
    const all = listSidecars({ repoRoot }).sort((x, y) =>
      `${x.harness}-${x.skill_name}`.localeCompare(`${y.harness}-${y.skill_name}`),
    );
    expect(all).toEqual([
      { harness: "claude", skill_name: "code-review", payload: { skill_id: "skl-a", current_hash: "h-a" } },
      { harness: "claude", skill_name: "deploy", payload: { skill_id: "skl-b", current_hash: "h-b" } },
      { harness: "cursor", skill_name: "format", payload: { skill_id: "skl-c", current_hash: "h-c" } },
    ]);
  });

  it("filters by harness when supplied", () => {
    writeSidecar({ repoRoot, harness: "claude", skillName: "a", payload: { skill_id: "s1", current_hash: "h1" } });
    writeSidecar({ repoRoot, harness: "cursor", skillName: "b", payload: { skill_id: "s2", current_hash: "h2" } });
    expect(listSidecars({ repoRoot, harness: "claude" }).map((r) => r.skill_name)).toEqual(["a"]);
  });

  it("silently skips corrupt sidecars (one bad file does not break the listing)", () => {
    writeSidecar({ repoRoot, harness: "claude", skillName: "ok", payload: { skill_id: "s", current_hash: "h" } });
    writeFileSync(join(sidecarDir(repoRoot), "claude-broken.json"), "{ this is not json");
    writeFileSync(join(sidecarDir(repoRoot), "claude-missing-fields.json"), JSON.stringify({ skill_id: "x" }));
    const records = listSidecars({ repoRoot });
    expect(records.map((r) => r.skill_name)).toEqual(["ok"]);
  });

  it("ignores entries that don't end in .json (e.g. stray editor swap files)", () => {
    writeSidecar({ repoRoot, harness: "claude", skillName: "real", payload: { skill_id: "s", current_hash: "h" } });
    writeFileSync(join(sidecarDir(repoRoot), "claude-swap.json.swp"), "binary garbage");
    expect(listSidecars({ repoRoot }).map((r) => r.skill_name)).toEqual(["real"]);
  });
});

describe("last-sync timestamp", () => {
  it("lastSyncPath composes <repo>/.ark/skills-state/last-sync.json", () => {
    expect(lastSyncPath("/repo")).toBe("/repo/.ark/skills-state/last-sync.json");
  });

  it("readLastSync returns null when the file does not exist", () => {
    expect(readLastSync(repoRoot)).toBeNull();
  });

  it("writeLastSync + readLastSync round-trip", () => {
    writeLastSync(repoRoot, "2026-05-14T12:34:56.789Z");
    expect(readLastSync(repoRoot)).toBe("2026-05-14T12:34:56.789Z");
  });

  it("writeLastSync creates the state dir if absent", () => {
    expect(readLastSync(repoRoot)).toBeNull();
    writeLastSync(repoRoot, "2026-05-14T00:00:00.000Z");
    expect(readLastSync(repoRoot)).toBe("2026-05-14T00:00:00.000Z");
  });

  it("readLastSync returns null when the JSON is malformed (caller falls back to epoch)", () => {
    mkdirSync(sidecarDir(repoRoot), { recursive: true });
    writeFileSync(lastSyncPath(repoRoot), "{ not valid json", "utf8");
    expect(readLastSync(repoRoot)).toBeNull();
  });

  it("readLastSync returns null when last_sync_at field is missing or non-string", () => {
    writeLastSync(repoRoot, "2026-05-14T00:00:00.000Z");
    writeFileSync(lastSyncPath(repoRoot), JSON.stringify({ other: "field" }), "utf8");
    expect(readLastSync(repoRoot)).toBeNull();
  });
});
