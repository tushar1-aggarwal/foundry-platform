/**
 * Claude Code adapter. Reads / writes the format documented at
 * code.claude.com/docs/en/skills.
 *
 * On-disk layout:
 *   .claude/skills/<name>/
 *     SKILL.md          frontmatter (YAML) + markdown body
 *     references/...    optional supporting files
 *     scripts/...
 *     assets/...
 *
 * Frontmatter universal keys: `name`, `description`.
 * Claude-specific keys ride alongside (e.g. `disable-model-invocation`,
 * `allowed-tools`, `paths`). The shared parse helper routes those into
 * `harnessHints.claude` so they round-trip through the server losslessly.
 *
 * Note: `category` and `tags` are NOT part of the SKILL.md frontmatter
 * (see RFC §13 worked example). They live only in the canonical server
 * record - the CLI sets them via `--category` / `--tag` flags at upload
 * time. `parse()` returns `category: null` + `tags: []` by default.
 *
 * The Claude adapter does NOT emit the cross-harness telemetry counter
 * (RFC §9 Q2): when a Claude-authored skill is rendered back to Claude,
 * that's a self-render, not a cross-harness consumption.
 */

import { join } from "path";
import { parseSkillAsHarness, renderSkillForHarness } from "./shared.js";
import type { CanonicalSkill, HarnessAdapter, LocalSkill, WrittenFile } from "./types.js";

const HARNESS_ID = "claude";

export const claudeAdapter: HarnessAdapter = {
  harnessId: HARNESS_ID,

  readPaths(repoRoot: string): string[] {
    // v1: project-level only. User-home (`~/.claude/skills/`) is
    // deferred per RFC §5 "Deferred from v1".
    return [join(repoRoot, ".claude", "skills")];
  },

  defaultWritePath(repoRoot: string): string {
    return join(repoRoot, ".claude", "skills");
  },

  parse(skillDir: string): LocalSkill {
    return parseSkillAsHarness(HARNESS_ID, skillDir);
  },

  render(skill: CanonicalSkill): WrittenFile[] {
    return renderSkillForHarness(HARNESS_ID, skill);
  },
};
