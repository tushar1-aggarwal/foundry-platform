/**
 * Postgres half of migration 022 (skills + skill_versions).
 *
 * Mirrors the SQLite variant. JSON columns use `text` to match the
 * existing codebase convention (e.g. `scoping_overrides.value_json`).
 */

import type { DatabaseAdapter } from "../database/index.js";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS skills (
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
    CONSTRAINT skills_tenant_id_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT skills_team_id_fk
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    CONSTRAINT skills_owner_user_id_fk
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
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
  "CREATE INDEX IF NOT EXISTS idx_skills_tenant ON skills (tenant_id)",
  "CREATE INDEX IF NOT EXISTS idx_skills_tenant_category ON skills (tenant_id, category)",
  "CREATE INDEX IF NOT EXISTS idx_skills_owner_user ON skills (owner_user_id)",
  `CREATE TABLE IF NOT EXISTS skill_versions (
    id                     TEXT PRIMARY KEY,
    skill_id               TEXT NOT NULL,
    version_hash           TEXT NOT NULL,
    body                   TEXT NOT NULL,
    supporting_files_json  TEXT NOT NULL DEFAULT '[]',
    changed_by             TEXT NOT NULL,
    changed_at             TEXT NOT NULL,
    merge_input_json       TEXT,
    CONSTRAINT skill_versions_skill_id_fk
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_time ON skill_versions (skill_id, changed_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_versions_skill_hash ON skill_versions (skill_id, version_hash)",
];

export async function applyPostgresSkills(db: DatabaseAdapter): Promise<void> {
  for (const sql of STATEMENTS) {
    await db.exec(sql);
  }
}
