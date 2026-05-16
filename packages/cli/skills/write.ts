/**
 * Shared bundle-write helpers used by both `ark skills install`
 * (single-skill pull) and `ark skills sync`'s fast-forward-pull and
 * merge-accept paths. Extracted from skills-sync.ts in Commit 15
 * after the reviewer noted that install re-implemented the inline
 * write loop and lost the stale-file sweep that C14 added to sync.
 *
 * Both write paths share three correctness invariants:
 *   1. adapter.render() runs over the full CanonicalSkill, including
 *      name + description + category + tags (otherwise the rendered
 *      SKILL.md frontmatter is malformed and the next adapter.parse()
 *      throws).
 *   2. Files in the target skill dir that the new bundle doesn't
 *      include get DELETED on the way out. Without this sweep, a
 *      server-side file deletion lingers locally and the next
 *      sync_status reports a false conflict (local hash includes the
 *      orphan file).
 *   3. Empty subdirectories left behind by the sweep are pruned
 *      bottom-up. The skill's own dir is preserved (don't surprise
 *      the user with a missing directory).
 *
 * Sweep is bounded to the skill's own subdir and skips hidden files
 * + symlinks - the same defensive posture the adapter's
 * collectSupportingFiles uses on read. No path outside the skill
 * directory is ever touched.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, posix, relative, sep } from "path";
import type { HarnessAdapter } from "../../skill-adapters/index.js";
import type { SkillhubSupportingFile } from "../../types/index.js";

/**
 * Pure planner: given the existing files in a skill dir and the
 * files the new bundle wants written, return the relative paths
 * that should be deleted. Exported for unit-testing the sweep
 * logic without filesystem I/O.
 */
export function planSweep(existing: string[], wanted: string[]): string[] {
  const wantedSet = new Set(wanted);
  const toDelete: string[] = [];
  for (const path of existing) {
    if (!wantedSet.has(path)) toDelete.push(path);
  }
  return toDelete.sort();
}

/**
 * List files (POSIX-relative paths) inside `dir`, skipping hidden
 * entries and refusing to traverse symlinks. Mirrors the read-side
 * `collectSupportingFiles` in packages/skill-adapters/shared.ts so
 * the sweep operates on the same file universe the adapter would
 * parse.
 */
function listFilesRelative(dir: string): string[] {
  const out: string[] = [];
  function walk(current: string): void {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current)) {
      if (entry.startsWith(".")) continue;
      const abs = join(current, entry);
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(abs);
      } else if (stat.isFile()) {
        const rel = relative(dir, abs);
        out.push(sep === posix.sep ? rel : rel.split(sep).join(posix.sep));
      }
    }
  }
  walk(dir);
  return out;
}

function pruneEmptyDirs(root: string): void {
  // Bottom-up: walk children first, rmdir if empty. Don't touch the
  // root itself - leave a hollow skill directory rather than surprise
  // the user with a missing dir.
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".")) continue;
    const abs = join(root, entry);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) continue;
    pruneEmptyDirs(abs);
    if (readdirSync(abs).length === 0) {
      rmdirSync(abs);
    }
  }
}

/**
 * Write the rendered bundle to `<targetDir>/<skillName>/...` and
 * sweep any file in the skill directory that isn't in the new
 * bundle. Empty subdirectories left behind are pruned.
 *
 * Used by both `ark skills sync` (FF-pull, merge-accept) and
 * `ark skills install`. Mirrors the read-side adapter behavior:
 * the rendered output is the only thing that lives in the skill
 * dir on disk; nothing else is preserved.
 */
export function writeBundleToDisk(opts: {
  adapter: HarnessAdapter;
  targetDir: string;
  skillName: string;
  name: string;
  description: string;
  category: string | null;
  tags: string[];
  body: string;
  supportingFiles: SkillhubSupportingFile[];
  harnessHints: Record<string, Record<string, unknown>>;
}): void {
  const skillRoot = join(opts.targetDir, opts.skillName);
  const files = opts.adapter.render({
    name: opts.name,
    description: opts.description,
    body: opts.body,
    supportingFiles: opts.supportingFiles,
    category: opts.category,
    tags: opts.tags,
    harnessHints: opts.harnessHints,
  });
  const wanted = new Set(files.map((f) => f.relativePath));
  for (const f of files) {
    const abs = join(skillRoot, f.relativePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
  }
  if (existsSync(skillRoot)) {
    const existing = listFilesRelative(skillRoot);
    const toDelete = planSweep(existing, [...wanted]);
    for (const rel of toDelete) {
      unlinkSync(join(skillRoot, rel));
    }
    pruneEmptyDirs(skillRoot);
  }
}
