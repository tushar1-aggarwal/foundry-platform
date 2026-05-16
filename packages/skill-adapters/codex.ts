/**
 * Codex adapter. Reads / writes the format documented at
 * developers.openai.com/codex/skills.
 *
 * On-disk layout:
 *   .codex/skills/<name>/    - Codex's own scope
 *   .agents/skills/<name>/   - universal Agent Skills convention (RFC §6),
 *                              also read by Codex
 *     SKILL.md
 *     references/...
 *     scripts/...
 *     assets/...
 *
 * Same on-disk shape as Claude / Cursor (Agent Skills open standard).
 * The shared parse helper routes Codex-specific frontmatter keys into
 * `harnessHints.codex` for lossless round-trips.
 *
 * `defaultWritePath()` is `.codex/skills/` (the harness-native location);
 * `readPaths()` also includes `.agents/skills/` so teams who've adopted
 * the universal convention don't need extra config to be picked up.
 *
 * Telemetry: per RFC §9 Q2, `render()` emits a cross-harness counter
 * when the canonical skill carries non-empty `harnessHints.claude`.
 */

import { join } from "path";
import { emitCrossHarnessTelemetryIfClaudeOrigin, parseSkillAsHarness, renderSkillForHarness } from "./shared.js";
import type { CanonicalSkill, HarnessAdapter, LocalSkill, WrittenFile } from "./types.js";

const HARNESS_ID = "codex";

export const codexAdapter: HarnessAdapter = {
  harnessId: HARNESS_ID,

  readPaths(repoRoot: string): string[] {
    return [join(repoRoot, ".codex", "skills"), join(repoRoot, ".agents", "skills")];
  },

  defaultWritePath(repoRoot: string): string {
    return join(repoRoot, ".codex", "skills");
  },

  parse(skillDir: string): LocalSkill {
    return parseSkillAsHarness(HARNESS_ID, skillDir);
  },

  render(skill: CanonicalSkill): WrittenFile[] {
    emitCrossHarnessTelemetryIfClaudeOrigin(skill, HARNESS_ID);
    return renderSkillForHarness(HARNESS_ID, skill);
  },
};
