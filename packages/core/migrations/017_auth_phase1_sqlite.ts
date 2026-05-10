/**
 * SQLite half of the auth Phase 1 schema additions.
 *
 *   - users.google_sub: Google's stable subject id, set on first OIDC login.
 *     Unique per live row via partial index.
 *   - users.last_login_at: bumped on each successful login.
 *   - teams.parent_team_id: self-reference for DX's variable-depth team
 *     hierarchy (entity → HoD → grandparent_team → parent_team → team).
 *     NULL means top-of-tenant (HoD-level).
 *   - sessions_auth: cookie-based session store for the OIDC flow.
 *   - api_keys.user_id: self-service ownership column. NULL = admin /
 *     tenant-level (legacy). Set when minted via the self-service surface.
 *     Soft pointer (no FK) -- mirrors the existing `tenant_id` convention
 *     on this table; integrity lives at the handler layer via
 *     `requireRealUser`.
 *   - scoping_overrides: single override surface walked by the
 *     ScopingResolver in the order user > team-chain > tenant. tenant_id
 *     participates in the unique index AND every lookup as defense in
 *     depth against future id-generator changes.
 *
 * Each ADD COLUMN is wrapped in try/catch on "duplicate column name" so the
 * migration is safely re-runnable if a previous attempt added the column
 * before the apply-log row was committed.
 *
 * Seed: a `default` tenant + `default-team` so the login-flow fallback path
 * has valid FK targets. Real tenants/teams enter via SQL playbook or DX
 * sync (later phase).
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

const ADD_GOOGLE_SUB = "ALTER TABLE users ADD COLUMN google_sub TEXT";
const ADD_LAST_LOGIN_AT = "ALTER TABLE users ADD COLUMN last_login_at TEXT";
const ADD_PARENT_TEAM_ID = "ALTER TABLE teams ADD COLUMN parent_team_id TEXT";
const ADD_APIKEYS_USER_ID = "ALTER TABLE api_keys ADD COLUMN user_id TEXT";

const CREATE_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub_live
     ON users (google_sub)
     WHERE google_sub IS NOT NULL AND deleted_at IS NULL`,
  "CREATE INDEX IF NOT EXISTS idx_teams_parent ON teams (parent_team_id)",
  "CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id)",
];

// Single override surface for the ScopingResolver. One row per
// (scope_kind, scope_id, key, tenant_id) live triple. tenant_id is on
// the unique index AND every resolver query as defense in depth against
// future id-generator changes that could otherwise collapse uniqueness
// across tenants.
const CREATE_SCOPING_OVERRIDES = `
  CREATE TABLE IF NOT EXISTS scoping_overrides (
    id          TEXT PRIMARY KEY,
    scope_kind  TEXT NOT NULL,
    scope_id    TEXT NOT NULL,
    key         TEXT NOT NULL,
    value_json  TEXT NOT NULL,
    tenant_id   TEXT NOT NULL DEFAULT 'default',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )
`;

const SCOPING_OVERRIDES_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_scoping_overrides_live
     ON scoping_overrides (scope_kind, scope_id, key, tenant_id)
     WHERE deleted_at IS NULL`,
  "CREATE INDEX IF NOT EXISTS idx_scoping_overrides_tenant ON scoping_overrides (tenant_id)",
];

const CREATE_SESSIONS_AUTH = `
  CREATE TABLE IF NOT EXISTS sessions_auth (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    team_chain    TEXT,
    user_agent    TEXT,
    ip            TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`;

const SESSIONS_AUTH_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_sessions_auth_user ON sessions_auth (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_auth_expires ON sessions_auth (expires_at)",
];

const SEED_DEFAULT_TENANT = `
  INSERT OR IGNORE INTO tenants (id, slug, name, status, created_at, updated_at)
  VALUES ('default', 'default', 'Default Tenant', 'active',
          datetime('now'), datetime('now'))
`;

const SEED_DEFAULT_TEAM = `
  INSERT OR IGNORE INTO teams (id, tenant_id, parent_team_id, slug, name, description, created_at, updated_at)
  VALUES ('default-team', 'default', NULL, 'default-team', 'Default Team',
          'Holding pen for users not yet assigned to a real team',
          datetime('now'), datetime('now'))
`;

async function tryAddColumn(db: DatabaseAdapter, sql: string, label: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!/duplicate column name/i.test(msg)) throw e;
    logDebug("general", `${label} column already present -- skipping`);
  }
}

export async function applySqliteAuthPhase1(db: DatabaseAdapter): Promise<void> {
  await tryAddColumn(db, ADD_GOOGLE_SUB, "users.google_sub");
  await tryAddColumn(db, ADD_LAST_LOGIN_AT, "users.last_login_at");
  await tryAddColumn(db, ADD_PARENT_TEAM_ID, "teams.parent_team_id");
  await tryAddColumn(db, ADD_APIKEYS_USER_ID, "api_keys.user_id");

  for (const sql of CREATE_INDEXES) await db.exec(sql);

  await db.exec(CREATE_SESSIONS_AUTH);
  for (const sql of SESSIONS_AUTH_INDEXES) await db.exec(sql);

  await db.exec(CREATE_SCOPING_OVERRIDES);
  for (const sql of SCOPING_OVERRIDES_INDEXES) await db.exec(sql);

  await db.exec(SEED_DEFAULT_TENANT);
  await db.exec(SEED_DEFAULT_TEAM);
}
