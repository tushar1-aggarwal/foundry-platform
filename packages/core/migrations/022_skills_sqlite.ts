/**
 * Migration 022 (SQLite) -- skills + skill_versions tables.
 *
 * See 022_skills.ts for the high-level shape and the RFC link.
 *
 * Key design decisions encoded here (all from docs/skillhub-rfc.md §3):
 *   - `tenant_id` is NULLABLE. NULL for user-scope rows so the consultant
 *     pattern works (one user, many tenants, one personal skill).
 *   - A CHECK constraint enforces the visibility/scoping-column shape:
 *     user-scope   -> tenant_id NULL, owner_user_id NOT NULL, team_id NULL
 *     team-scope   -> tenant_id + team_id NOT NULL
 *     tenant-scope -> tenant_id NOT NULL, team_id + owner_user_id NULL
 *     cross_tenant -> tenant_id NOT NULL (origin tenant); reserved for a
 *                     future system-admin promotion flow, rejected by
 *                     skillhub/put in v1
 *   - Three partial unique indexes (one per visibility) so the same skill
 *     name can coexist across different scopes within a tenant.
 *   - `current_hash` is the lookup key into `skill_versions.version_hash`
 *     for the current body. Enforced by transaction order in skill/put
 *     (write version row first, then update current_hash) -- NOT an FK.
 *   - `harness_hints_json` / `supporting_files_json` use `text` (matches
 *     the existing scoping_overrides.value_json convention).
 */

import type { DatabaseAdapter } from "../database/index.js";

const CREATE_SKILLS = `
  CREATE TABLE IF NOT EXISTS skills (
    id                     TEXT PRIMARY KEY,
    tenant_id              TEXT,
    team_id                TEXT,
    owner_user_id          TEXT,
    visibility             TEXT NOT NULL,
    name                   TEXT NOT NULL,
    description            TEXT NOT NULL,
    body                   TEXT NOT NULL,
    category               TEXT,
    tags                   TEXT NOT NULL DEFAULT '[]',
    supporting_files_json  TEXT NOT NULL DEFAULT '[]',
    harness_hints_json     TEXT NOT NULL DEFAULT '{}',
    current_hash           TEXT NOT NULL,
    upstream_id            TEXT,
    created_by             TEXT NOT NULL,
    updated_by             TEXT,
    deleted_at             TEXT,
    deleted_by             TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    CONSTRAINT ck_skills_visibility_scope CHECK (
      (visibility = 'user'
        AND tenant_id IS NULL AND team_id IS NULL AND owner_user_id IS NOT NULL)
      OR (visibility = 'team'
        AND tenant_id IS NOT NULL AND team_id IS NOT NULL AND owner_user_id IS NULL)
      OR (visibility = 'tenant'
        AND tenant_id IS NOT NULL AND team_id IS NULL AND owner_user_id IS NULL)
      OR (visibility = 'cross_tenant'
        AND tenant_id IS NOT NULL AND team_id IS NULL AND owner_user_id IS NULL)
    ),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`;

const SKILLS_INDEXES = [
  // Three partial uniqueness indexes -- one per visibility-scope so the
  // same `name` can coexist for the same user, the same team, and the
  // same tenant simultaneously.
  //
  // NOTE for the future system-admin / `cross_tenant` visibility enablement:
  // there is NO partial unique index for visibility='cross_tenant' below.
  // In v1 that's fine because skillhub/put rejects cross_tenant writes at
  // the handler layer, so no cross_tenant rows ever exist. When enabled,
  // add a fourth index (`idx_skills_cross_tenant_name_live`) in a
  // follow-up migration before any cross_tenant row is created. See
  // RFC §9 Q1 for context.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_user_name_live
     ON skills (owner_user_id, name)
     WHERE deleted_at IS NULL AND visibility = 'user'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_team_name_live
     ON skills (team_id, name)
     WHERE deleted_at IS NULL AND visibility = 'team'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_tenant_name_live
     ON skills (tenant_id, name)
     WHERE deleted_at IS NULL AND visibility = 'tenant'
       AND team_id IS NULL AND owner_user_id IS NULL`,
  // Hot-path indexes for the list/search queries.
  "CREATE INDEX IF NOT EXISTS idx_skills_tenant ON skills (tenant_id)",
  "CREATE INDEX IF NOT EXISTS idx_skills_tenant_category ON skills (tenant_id, category)",
  "CREATE INDEX IF NOT EXISTS idx_skills_owner_user ON skills (owner_user_id)",
];

const CREATE_SKILL_VERSIONS = `
  CREATE TABLE IF NOT EXISTS skill_versions (
    id                     TEXT PRIMARY KEY,
    skill_id               TEXT NOT NULL,
    version_hash           TEXT NOT NULL,
    body                   TEXT NOT NULL,
    supporting_files_json  TEXT NOT NULL DEFAULT '[]',
    changed_by             TEXT NOT NULL,
    changed_at             TEXT NOT NULL,
    merge_input_json       TEXT,
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
  )
`;

const SKILL_VERSIONS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_time ON skill_versions (skill_id, changed_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_versions_skill_hash ON skill_versions (skill_id, version_hash)",
];

export async function applySqliteSkills(db: DatabaseAdapter): Promise<void> {
  await db.exec(CREATE_SKILLS);
  for (const sql of SKILLS_INDEXES) await db.exec(sql);

  await db.exec(CREATE_SKILL_VERSIONS);
  for (const sql of SKILL_VERSIONS_INDEXES) await db.exec(sql);
}
