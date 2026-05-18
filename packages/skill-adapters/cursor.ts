/**
 * Cursor adapter. Reads / writes the format documented at
 * cursor.com/docs/skills.
 *
 * On-disk layout:
 *   .cursor/skills/<name>/
 *     SKILL.md          frontmatter (YAML) + markdown body
 *     references/...    optional supporting files
 *     scripts/...
 *     assets/...
 *
 * Same on-disk shape as Claude (Agent Skills open standard); the only
 * differences are the directory tree and the set of harness-specific
 * frontmatter keys Cursor itself understands. The shared parse helper
 * routes everything that isn't `name` / `description` into
 * `harnessHints.cursor` so round-trips through the server are lossless.
 *
 * Telemetry: per RFC §9 Q2, when `render()` runs on a canonical skill
 * whose `harnessHints.claude` is non-empty, we emit a counter event.
 * That's the cross-harness consumption signal we want to measure to
 * decide if the normalize-on-upload policy is doing meaningful work.
 */

import { join } from "path";
import { emitCrossHarnessTelemetryIfClaudeOrigin, parseSkillAsHarness, renderSkillForHarness } from "./shared.js";
import type { CanonicalSkill, HarnessAdapter, LocalSkill, WrittenFile } from "./types.js";

const HARNESS_ID = "cursor";

export const cursorAdapter: HarnessAdapter = {
  harnessId: HARNESS_ID,

  readPaths(repoRoot: string): string[] {
    return [join(repoRoot, ".cursor", "skills")];
  },

  defaultWritePath(repoRoot: string): string {
    return join(repoRoot, ".cursor", "skills");
  },

  parse(skillDir: string): LocalSkill {
    return parseSkillAsHarness(HARNESS_ID, skillDir);
  },

  render(skill: CanonicalSkill): WrittenFile[] {
    emitCrossHarnessTelemetryIfClaudeOrigin(skill, HARNESS_ID);
    return renderSkillForHarness(HARNESS_ID, skill);
  },
};
