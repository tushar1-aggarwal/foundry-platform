/**
 * Migration 022 -- Skill Hub: `skills` + `skill_versions` tables.
 *
 * Skills are the central-registry version of agent skills (Claude Code /
 * Cursor / Codex / Agent Skills open standard). See docs/skillhub-rfc.md.
 *
 * Two tables:
 *   - `skills`: live rows. Visibility is one of `user` | `team` | `tenant`
 *     | `cross_tenant`. User-scope rows carry `tenant_id` NULL (consultant
 *     pattern: a user in multiple tenants sees their personal skills
 *     across all of them). A CHECK constraint enforces the
 *     visibility/scoping-column invariant at the DB level.
 *   - `skill_versions`: append-only version history. Every `skillhub/put`
 *     that changes the body writes a new row here BEFORE updating the
 *     live `skills` row. Server-side source of truth for the 3-way merge
 *     ancestor body (§7 of the RFC).
 *
 * Visibility=`cross_tenant` is reachable only by a future system-admin
 * role (not in v1, see §9 Q1). The schema accepts it as a forward-compat
 * slot but handler-layer validation rejects writes with
 * `visibility=cross_tenant`. Named distinctly from "public" so the enum
 * doesn't read as "internet-public" - that ambiguity would be a foot-gun
 * for anyone scanning the schema.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteSkills } from "./022_skills_sqlite.js";
import { applyPostgresSkills } from "./022_skills_postgres.js";

export const VERSION = 22;
export const NAME = "skills";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteSkills(ctx.db);
  } else {
    await applyPostgresSkills(ctx.db);
  }
}
