/**
 * `<repo>/.ark/config.yaml` parser + writer for the `skills` section.
 *
 * RFC §5 spec. The file is optional, project-local, and per-developer
 * (gitignore-friendly though teams may opt to commit it). It can carry
 * sections for other features alongside skills - this module only
 * touches the `skills:` key.
 *
 *   skills:
 *     read_paths:        # additive: extra paths the CLI walks alongside
 *       - .foundry/skills  # each adapter's own readPaths()
 *     write_to:          # per-harness path override for sync writes;
 *       claude: .claude/skills           # absent harness = use the
 *       cursor: .agents/skills           # adapter's defaultWritePath()
 *     enabled_harnesses: [claude, cursor]  # optional restriction
 *
 * Auto-written by Layer 4 of the detection cascade (`detect.ts`) when
 * the user picks a harness interactively, so subsequent syncs short-
 * circuit at Layer 2.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Parsed `skills` section. All fields optional - a present `skills:` key
 * with no sub-keys is valid (and equivalent to absence for cascade
 * purposes).
 */
export interface SkillsConfig {
  /** Custom paths the CLI walks ALONGSIDE adapter.readPaths(), not in place of. */
  read_paths?: string[];
  /** Per-harness write-target override. Keys must match a known `harnessId`. */
  write_to?: Record<string, string>;
  /**
   * Restrict sync to this allowlist; if set, the cascade result is
   * intersected with it. **Empty array is treated as "no restriction"**
   * (i.e. equivalent to omitting the key) - matches the common author
   * intent of "I forgot to fill this in" over the unusual "I want to
   * block everything." `detect.ts` enforces this via a `.length > 0`
   * guard before falling back to Layer 3.
   */
  enabled_harnesses?: string[];
}

/**
 * Thrown when the file's `skills:` section has the wrong shape (e.g.
 * `read_paths` is not an array). The handler / command catches this and
 * surfaces a CLI-friendly error - we never silently coerce bad config.
 */
export class SkillsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillsConfigError";
  }
}

/** Absolute path of the config file given a repo root. */
export function configPath(repoRoot: string): string {
  return join(repoRoot, ".ark", "config.yaml");
}

/**
 * Read + validate the `skills` section. Returns `null` when:
 *   - the file does not exist (most common case)
 *   - the file exists but has no `skills:` key
 *
 * Throws `SkillsConfigError` only on malformed YAML or wrong-shape
 * `skills:` content. Other top-level sections in the file are ignored.
 */
export function loadSkillsConfig(repoRoot: string): SkillsConfig | null {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SkillsConfigError(`malformed YAML in ${path}: ${msg}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const skillsSection = (parsed as Record<string, unknown>).skills;
  if (skillsSection === undefined) return null;
  if (typeof skillsSection !== "object" || skillsSection === null || Array.isArray(skillsSection)) {
    throw new SkillsConfigError(`${path}: 'skills' must be a mapping, got ${typeof skillsSection}`);
  }
  return validateSkillsSection(skillsSection as Record<string, unknown>, path);
}

/**
 * Write the `skills` section. Preserves every other top-level section
 * in the file. Creates the parent directory + the file if absent.
 *
 * Caller is responsible for gitignoring `<repo>/.ark/` if they want -
 * we don't touch `.gitignore` from CLI code (per existing convention).
 */
export function writeSkillsConfig(repoRoot: string, skills: SkillsConfig): void {
  const path = configPath(repoRoot);
  let doc: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SkillsConfigError(`cannot rewrite ${path}: existing file has malformed YAML: ${msg}`);
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  }
  doc.skills = skills;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(doc), "utf8");
}

// ── helpers ───────────────────────────────────────────────────────────────

function validateSkillsSection(section: Record<string, unknown>, path: string): SkillsConfig {
  const out: SkillsConfig = {};

  if (section.read_paths !== undefined) {
    if (!Array.isArray(section.read_paths) || !section.read_paths.every((p) => typeof p === "string")) {
      throw new SkillsConfigError(`${path}: skills.read_paths must be an array of strings`);
    }
    out.read_paths = section.read_paths as string[];
  }

  if (section.write_to !== undefined) {
    if (typeof section.write_to !== "object" || section.write_to === null || Array.isArray(section.write_to)) {
      throw new SkillsConfigError(`${path}: skills.write_to must be a mapping of harness -> path`);
    }
    const wt: Record<string, string> = {};
    for (const [harness, target] of Object.entries(section.write_to as Record<string, unknown>)) {
      if (typeof target !== "string") {
        throw new SkillsConfigError(`${path}: skills.write_to.${harness} must be a string`);
      }
      wt[harness] = target;
    }
    out.write_to = wt;
  }

  if (section.enabled_harnesses !== undefined) {
    if (!Array.isArray(section.enabled_harnesses) || !section.enabled_harnesses.every((h) => typeof h === "string")) {
      throw new SkillsConfigError(`${path}: skills.enabled_harnesses must be an array of strings`);
    }
    out.enabled_harnesses = section.enabled_harnesses as string[];
  }

  return out;
}
