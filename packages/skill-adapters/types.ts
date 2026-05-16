/**
 * Skill adapter types. Defines the contract every harness adapter
 * (Claude, Cursor, Codex, future) implements. See RFC §6.
 *
 * The adapter layer is the ONLY layer that knows harness-specific
 * details (file paths, frontmatter shapes). Everything above
 * (visibility, scoping, merge, sync orchestration) stays generic.
 */

/**
 * One file inside a skill directory other than `SKILL.md` itself
 * (scripts, references, assets). `path` is relative to the skill's
 * own directory; e.g. `references/spec.md`.
 */
export interface SupportingFile {
  path: string;
  content: string;
}

/**
 * One file emitted by `render()` for writing to disk. Mirrors
 * `SupportingFile` plus the top-level `SKILL.md` (whose `relativePath`
 * is just `"SKILL.md"`).
 */
export interface WrittenFile {
  relativePath: string;
  content: string;
}

/**
 * What an adapter can know just by reading a local skill directory.
 * Server-side fields (id, scoping, audit) are NOT here - the CLI fills
 * those in before calling `skillhub/put`. This is the shape returned
 * by `parse()`.
 */
export interface LocalSkill {
  name: string;
  description: string;
  body: string;
  supportingFiles: SupportingFile[];
  category: string | null;
  tags: string[];
  /**
   * Keyed by harness id. The adapter that parsed the file only ever
   * sets its own entry; other entries arrive on the server side from
   * other harnesses' uploads and are preserved across round-trips.
   */
  harnessHints: Record<string, Record<string, unknown>>;
}

/**
 * The canonical record as the adapter sees it for `render()`.
 *
 * This is a SUBSET of the server-side `SkillRow` - just the fields an
 * adapter needs to write files. The CLI maps `SkillRow` -> `CanonicalSkill`
 * before calling `render()`; server-only fields (id, tenant_id, audit,
 * etc.) are intentionally excluded because the adapter has no business
 * looking at them.
 */
export interface CanonicalSkill {
  name: string;
  description: string;
  /** Post-normalization body (per RFC §7). */
  body: string;
  /** Post-normalization supporting files. */
  supportingFiles: SupportingFile[];
  category: string | null;
  tags: string[];
  /**
   * Full harness_hints map keyed by harness id. The adapter for harness
   * `X` reads `harnessHints[X]` for harness-specific frontmatter fields
   * AND consults `harnessHints[X].original_body` /
   * `harnessHints[X].original_supporting_files` when present (RFC §7:
   * the author's raw, un-normalized form is preserved at upload time
   * iff normalization changed something, so re-rendering for the
   * uploader's own harness reproduces what they wrote).
   */
  harnessHints: Record<string, Record<string, unknown>>;
}

/**
 * The pluggable adapter contract. Adding a new harness = one new
 * implementation + one line in `index.ts` registry. No core changes.
 */
export interface HarnessAdapter {
  /**
   * Stable identifier. Used in DB hints (`harness_hints_json` keys),
   * CLI flags (`--harness <id>`), and config (`<repo>/.ark/config.yaml`).
   * Immutable - renaming a harness is a data migration, never an
   * in-place rename (per RFC §3).
   */
  harnessId: string;

  /**
   * Every path this harness reads skills from, relative to `repoRoot`.
   * Should match the harness's own docs exactly (project + user-home +
   * enterprise scopes if applicable). v1 commonly returns only the
   * project-level path; user-home + heuristics are deferred per RFC §5.
   * Used by the CLI for both Layer 1 detection and the read side of sync.
   */
  readPaths(repoRoot: string): string[];

  /**
   * The path this harness writes its OWN skills to by default. Used
   * when sync materializes a new skill for this harness. Always
   * overridable via `<repo>/.ark/config.yaml:skills.write_to.<harness>`
   * or the `--dir` flag.
   */
  defaultWritePath(repoRoot: string): string;

  /**
   * Parse one skill directory (contains `SKILL.md` + any supporting
   * files) into a harness-agnostic `LocalSkill`. The CLI enriches the
   * result with scoping/visibility/id/sidecar metadata before sending
   * to the server.
   *
   * Throws if `skillDir/SKILL.md` is missing or malformed (the CLI
   * surfaces the error to the user).
   */
  parse(skillDir: string): LocalSkill;

  /**
   * Render a canonical skill to a list of files for this harness:
   * `SKILL.md` (frontmatter + body) plus any supporting files.
   *
   * Source-of-body selection:
   *   - If `skill.harnessHints[harnessId].original_body` is set, use
   *     it (the author's raw, un-normalized form preserved at upload
   *     per RFC §7). Same for `original_supporting_files`.
   *   - Otherwise render from `skill.body` and `skill.supportingFiles`
   *     (the canonical, normalized form).
   *
   * Frontmatter fields:
   *   - `name` and `description` are universal (every harness emits them).
   *   - Harness-specific extra fields come from `skill.harnessHints[harnessId]`
   *     minus the two `original_*` keys (those are storage, not file output).
   */
  render(skill: CanonicalSkill): WrittenFile[];
}
