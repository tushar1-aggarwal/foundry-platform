/**
 * Integration tests for writeBundleToDisk - the shared write helper
 * used by both `ark skills sync` (FF-pull, merge-accept) and
 * `ark skills install`.
 *
 * Three reviewer-flagged scenarios drive the coverage here; each
 * was a real correctness bug in an earlier draft of the orchestrator:
 *
 *   1. **Round-trip put-after-FF-pull** (C14 #1): the writer must
 *      pass server_description / server_category / server_tags
 *      through to adapter.render so the rendered SKILL.md has a
 *      well-formed frontmatter. Otherwise a subsequent
 *      `ark skills put` would fail with "missing required
 *      'description'" because the empty value the writer emitted
 *      doesn't round-trip through adapter.parse.
 *
 *   2. **Accept-merge-with-requires_manual** (C14 #2): split coverage.
 *      The pure `unresolvedPaths()` helper is unit-tested in
 *      skills-sync-helpers.test.ts. The orchestrator's call site at
 *      skills-sync.ts (handleConflict) that calls the helper to
 *      refuse a push is **structurally verified in code review but
 *      not exercised by any automated test** - landing that test
 *      requires the ArkClient injection refactor deferred below.
 *      If a future change weakens or relocates that guard, no test
 *      currently catches it; reviewers should re-verify the call
 *      site on touches to handleConflict.
 *
 *   3. **Server-deletes-file-then-FF-pull** (C14 #3 / C15): the
 *      writer must SWEEP files in the target skill dir that the
 *      new bundle doesn't include. Without sweep, a server-side
 *      deletion lingers locally and next sync_status reports a
 *      false conflict (local hash includes the orphan).
 *
 * Tests run against the real Claude adapter + a real tmpdir. No
 * server transport, no LLM, no daemon - just the file boundary.
 * Daemon-level end-to-end tests are deferred (would require
 * orchestrator refactor to make ArkClient injectable).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { claudeAdapter } from "../../skill-adapters/claude.js";
import type { SkillhubSupportingFile } from "../../types/index.js";
import { writeBundleToDisk } from "../skills/write.js";

let scratchDir: string;
let writeDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "skills-write-test-"));
  writeDir = join(scratchDir, ".claude", "skills");
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function writeOpts(overrides: {
  skillName: string;
  description: string;
  body: string;
  supportingFiles?: SkillhubSupportingFile[];
  category?: string | null;
  tags?: string[];
  harnessHints?: Record<string, Record<string, unknown>>;
}) {
  return {
    adapter: claudeAdapter,
    targetDir: writeDir,
    skillName: overrides.skillName,
    name: overrides.skillName,
    description: overrides.description,
    category: overrides.category ?? null,
    tags: overrides.tags ?? [],
    body: overrides.body,
    supportingFiles: overrides.supportingFiles ?? [],
    harnessHints: overrides.harnessHints ?? { claude: {} },
  };
}

describe("writeBundleToDisk — basic write", () => {
  it("creates the skill directory and the SKILL.md + supporting files", () => {
    writeBundleToDisk(
      writeOpts({
        skillName: "code-review",
        description: "Review code changes",
        body: "# code-review\n\nDo the thing.\n",
        supportingFiles: [
          { path: "refs/spec.md", content: "spec\n" },
          { path: "scripts/run.py", content: "print('hello')\n" },
        ],
      }),
    );
    const root = join(writeDir, "code-review");
    expect(existsSync(join(root, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(root, "refs/spec.md"), "utf8")).toBe("spec\n");
    expect(readFileSync(join(root, "scripts/run.py"), "utf8")).toBe("print('hello')\n");
  });

  it("creates the target dir lazily (no-op when the .claude/skills tree didn't exist)", () => {
    expect(existsSync(writeDir)).toBe(false);
    writeBundleToDisk(writeOpts({ skillName: "first-time", description: "init", body: "body\n" }));
    expect(existsSync(join(writeDir, "first-time", "SKILL.md"))).toBe(true);
  });
});

// ── C14 #1 regression: empty-description round-trip ──────────────────────

describe("writeBundleToDisk — C14 #1: round-trip put-after-FF-pull", () => {
  it("emits a SKILL.md whose adapter.parse() round-trips successfully", () => {
    // The bug: orchestrator used to pass description: "" to render(),
    // producing SKILL.md frontmatter with an empty description. The
    // next `ark skills put` would then fail because adapter.parse()
    // rejects skills missing required frontmatter fields. C14 review
    // surfaced this; the fix threaded server_description through
    // get_with_ancestor + writeBundleToDisk. This test pins that
    // round-trip works end-to-end.
    writeBundleToDisk(
      writeOpts({
        skillName: "code-review",
        description: "Reviews code changes for bugs, style, and best practices.",
        body: "# code-review\n\nbody\n",
        category: "review",
        tags: ["quality", "review"],
        supportingFiles: [{ path: "refs/spec.md", content: "spec\n" }],
        harnessHints: { claude: { "disable-model-invocation": false } },
      }),
    );
    const root = join(writeDir, "code-review");
    const parsed = claudeAdapter.parse(root);
    // The load-bearing assertion: description survives the round trip.
    expect(parsed.description).toBe("Reviews code changes for bugs, style, and best practices.");
    expect(parsed.name).toBe("code-review");
    expect(parsed.body).toBe("# code-review\n\nbody\n");
    expect(parsed.supportingFiles).toEqual([{ path: "refs/spec.md", content: "spec\n" }]);
    expect(parsed.harnessHints.claude).toMatchObject({ "disable-model-invocation": false });
  });
});

// ── C14 #3 / C15 regression: stale-file sweep ────────────────────────────

describe("writeBundleToDisk — C14 #3: server-deletes-file-then-FF-pull", () => {
  it("DELETES files in the skill dir that aren't in the new bundle (the sweep)", () => {
    // Setup: simulate a prior install/sync that wrote three files.
    writeBundleToDisk(
      writeOpts({
        skillName: "code-review",
        description: "v1",
        body: "v1 body\n",
        supportingFiles: [
          { path: "refs/spec.md", content: "v1 spec\n" },
          { path: "scripts/run.py", content: "print('v1')\n" },
        ],
      }),
    );
    // Sanity: all three files exist.
    expect(existsSync(join(writeDir, "code-review", "scripts/run.py"))).toBe(true);

    // Server-side scenario: a teammate deleted scripts/run.py
    // (security issue). New bundle lacks it.
    writeBundleToDisk(
      writeOpts({
        skillName: "code-review",
        description: "v2",
        body: "v2 body\n",
        supportingFiles: [{ path: "refs/spec.md", content: "v2 spec\n" }],
      }),
    );
    // The sweep deleted scripts/run.py.
    expect(existsSync(join(writeDir, "code-review", "scripts/run.py"))).toBe(false);
    // The kept file got the updated content.
    expect(readFileSync(join(writeDir, "code-review", "refs/spec.md"), "utf8")).toBe("v2 spec\n");
    // SKILL.md was rewritten too.
    expect(readFileSync(join(writeDir, "code-review", "SKILL.md"), "utf8")).toContain("v2 body");
  });

  it("prunes empty subdirectories left behind by the sweep", () => {
    writeBundleToDisk(
      writeOpts({
        skillName: "code-review",
        description: "v1",
        body: "v1\n",
        supportingFiles: [{ path: "scripts/run.py", content: "x\n" }],
      }),
    );
    expect(existsSync(join(writeDir, "code-review", "scripts"))).toBe(true);

    // New bundle drops the scripts/ subdir entirely.
    writeBundleToDisk(writeOpts({ skillName: "code-review", description: "v2", body: "v2\n", supportingFiles: [] }));
    expect(existsSync(join(writeDir, "code-review", "scripts"))).toBe(false);
    // Skill dir itself is preserved even when it's hollow except for SKILL.md.
    expect(existsSync(join(writeDir, "code-review", "SKILL.md"))).toBe(true);
  });

  it("preserves hidden files in the skill dir (defensive; mirrors collectSupportingFiles)", () => {
    // The user might keep a `.DS_Store` or editor swap file in the
    // skill dir; sweep should never touch those.
    writeBundleToDisk(writeOpts({ skillName: "code-review", description: "x", body: "body\n" }));
    const root = join(writeDir, "code-review");
    writeFileSync(join(root, ".DS_Store"), "junk");

    // Rewrite with a different body.
    writeBundleToDisk(writeOpts({ skillName: "code-review", description: "x", body: "body 2\n" }));
    expect(existsSync(join(root, ".DS_Store"))).toBe(true);
    expect(readFileSync(join(root, ".DS_Store"), "utf8")).toBe("junk");
  });

  it("does NOT follow symlinks during the sweep (so a malicious symlink in the skill dir can't escape)", () => {
    writeBundleToDisk(writeOpts({ skillName: "code-review", description: "x", body: "body\n" }));
    const root = join(writeDir, "code-review");
    // Drop a real file outside the skill dir + a symlink inside
    // pointing at it.
    const outsideTarget = join(scratchDir, "outside.txt");
    writeFileSync(outsideTarget, "do-not-delete\n");
    symlinkSync(outsideTarget, join(root, "link-to-outside.txt"));

    // Rewrite without the symlink in the bundle. The sweep should
    // leave the symlink + its target untouched (lstatSync sees it
    // as a symlink and skips it).
    writeBundleToDisk(writeOpts({ skillName: "code-review", description: "x", body: "body\n" }));
    // Target file outside the dir survives unconditionally.
    expect(existsSync(outsideTarget)).toBe(true);
    expect(readFileSync(outsideTarget, "utf8")).toBe("do-not-delete\n");
    // The symlink ITSELF is preserved (we don't sweep it either,
    // out of defense - same posture as collectSupportingFiles).
    expect(existsSync(join(root, "link-to-outside.txt"))).toBe(true);
  });
});

// ── Idempotency + isolation between skills ───────────────────────────────

describe("writeBundleToDisk — idempotency + isolation", () => {
  it("writing the same bundle twice produces byte-identical output", () => {
    const bundle = writeOpts({
      skillName: "code-review",
      description: "fixed",
      body: "fixed body\n",
      supportingFiles: [{ path: "refs/spec.md", content: "fixed spec\n" }],
    });
    writeBundleToDisk(bundle);
    const before = readFileSync(join(writeDir, "code-review", "SKILL.md"), "utf8");
    writeBundleToDisk(bundle);
    const after = readFileSync(join(writeDir, "code-review", "SKILL.md"), "utf8");
    expect(after).toBe(before);
  });

  it("writing skill B does NOT sweep files from skill A (sweep is bounded to the skill's own subdir)", () => {
    writeBundleToDisk(
      writeOpts({
        skillName: "code-review",
        description: "A",
        body: "A\n",
        supportingFiles: [{ path: "refs/a.md", content: "a\n" }],
      }),
    );
    writeBundleToDisk(
      writeOpts({
        skillName: "deploy",
        description: "B",
        body: "B\n",
        supportingFiles: [{ path: "refs/b.md", content: "b\n" }],
      }),
    );
    // Both skills' files exist.
    expect(existsSync(join(writeDir, "code-review", "refs/a.md"))).toBe(true);
    expect(existsSync(join(writeDir, "deploy", "refs/b.md"))).toBe(true);
  });
});

// ── End-to-end: simulated FF-pull flow ───────────────────────────────────

describe("writeBundleToDisk — simulated full FF-pull flow", () => {
  it("install then FF-pull-update then put-after-pull round-trips cleanly", () => {
    // 1. Initial install: writes skill v1.
    writeBundleToDisk(
      writeOpts({
        skillName: "code-review",
        description: "Reviews code changes",
        body: "# code-review\n\nv1 body\n",
        supportingFiles: [
          { path: "refs/spec.md", content: "v1 spec\n" },
          { path: "scripts/run.py", content: "print('v1')\n" },
        ],
        category: "review",
        tags: ["quality"],
        harnessHints: { claude: { "allowed-tools": ["Bash(git *)"] } },
      }),
    );
    const root = join(writeDir, "code-review");

    // 2. Server-side: teammate deleted scripts/run.py and edited the
    //    body + description. FF-pull writes the new shape.
    writeBundleToDisk(
      writeOpts({
        skillName: "code-review",
        description: "Reviews code changes for bugs and style",
        body: "# code-review\n\nv2 body\n",
        supportingFiles: [{ path: "refs/spec.md", content: "v2 spec\n" }],
        category: "review",
        tags: ["quality", "verification"],
        harnessHints: { claude: { "allowed-tools": ["Bash(git *)"] } },
      }),
    );

    // 3. The local files reflect ONLY the new bundle.
    expect(existsSync(join(root, "scripts/run.py"))).toBe(false);
    expect(existsSync(join(root, "scripts"))).toBe(false); // empty dir pruned
    expect(readFileSync(join(root, "refs/spec.md"), "utf8")).toBe("v2 spec\n");

    // 4. The user edits the body locally, then runs `ark skills put`
    //    which calls adapter.parse on this dir. Parse must succeed
    //    (no "missing description" because writeBundleToDisk
    //    threaded server_description through).
    const parsedAfterPull = claudeAdapter.parse(root);
    expect(parsedAfterPull.description).toBe("Reviews code changes for bugs and style");
    expect(parsedAfterPull.body).toBe("# code-review\n\nv2 body\n");
    expect(parsedAfterPull.supportingFiles).toEqual([{ path: "refs/spec.md", content: "v2 spec\n" }]);
    // claude-specific frontmatter survived.
    expect(parsedAfterPull.harnessHints.claude).toMatchObject({ "allowed-tools": ["Bash(git *)"] });
  });
});
