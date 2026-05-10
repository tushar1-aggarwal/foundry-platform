/**
 * Postgres half of the auth Phase 1 schema additions.
 *
 * Mirrors the SQLite variant. Postgres ADD COLUMN IF NOT EXISTS and
 * ON CONFLICT DO NOTHING are used in place of SQLite's catch-on-duplicate
 * and INSERT OR IGNORE.
 */

import type { DatabaseAdapter } from "../database/index.js";

const STATEMENTS = [
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TEXT",
  "ALTER TABLE teams ADD COLUMN IF NOT EXISTS parent_team_id TEXT",
  // Self-service ownership column on api_keys. NULL = admin / tenant-level
  // (legacy). Set when minted via the self-service surface. Soft pointer
  // (no FK) -- mirrors `tenant_id`'s convention on this table.
  "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id TEXT",
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub_live
     ON users (google_sub)
     WHERE google_sub IS NOT NULL AND deleted_at IS NULL`,
  "CREATE INDEX IF NOT EXISTS idx_teams_parent ON teams (parent_team_id)",
  "CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id)",
  `CREATE TABLE IF NOT EXISTS sessions_auth (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    team_chain    TEXT,
    user_agent    TEXT,
    ip            TEXT,
    CONSTRAINT sessions_auth_user_id_fk
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS idx_sessions_auth_user ON sessions_auth (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_auth_expires ON sessions_auth (expires_at)",
  // scoping_overrides: single override surface for the ScopingResolver.
  // tenant_id is on the unique index AND every resolver query as defense
  // in depth against future id-generator changes that could otherwise
  // collapse uniqueness across tenants.
  `CREATE TABLE IF NOT EXISTS scoping_overrides (
    id          TEXT PRIMARY KEY,
    scope_kind  TEXT NOT NULL,
    scope_id    TEXT NOT NULL,
    key         TEXT NOT NULL,
    value_json  TEXT NOT NULL,
    tenant_id   TEXT NOT NULL DEFAULT 'default',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_scoping_overrides_live
     ON scoping_overrides (scope_kind, scope_id, key, tenant_id)
     WHERE deleted_at IS NULL`,
  "CREATE INDEX IF NOT EXISTS idx_scoping_overrides_tenant ON scoping_overrides (tenant_id)",
  `INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
   VALUES ('default', 'default', 'Default Tenant', 'active', now(), now())
   ON CONFLICT (id) DO NOTHING`,
  `INSERT INTO teams (id, tenant_id, parent_team_id, slug, name, description, created_at, updated_at)
   VALUES ('default-team', 'default', NULL, 'default-team', 'Default Team',
           'Holding pen for users not yet assigned to a real team',
           now(), now())
   ON CONFLICT (id) DO NOTHING`,
];

export async function applyPostgresAuthPhase1(db: DatabaseAdapter): Promise<void> {
  for (const sql of STATEMENTS) {
    await db.exec(sql);
  }
}
