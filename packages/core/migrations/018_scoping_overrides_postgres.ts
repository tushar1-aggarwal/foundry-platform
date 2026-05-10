/**
 * Migration 018 (Postgres) -- backfill scoping_overrides for early adopters.
 *
 * See 018_scoping_overrides_sqlite.ts for the full backstory (#549).
 *
 * Body matches `017_auth_phase1_postgres.ts:42-56` byte for byte.
 */

import type { DatabaseAdapter } from "../database/index.js";

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

export async function applyPostgresScopingOverridesBackfill(db: DatabaseAdapter): Promise<void> {
  await db.exec(CREATE_SCOPING_OVERRIDES);
  for (const sql of SCOPING_OVERRIDES_INDEXES) {
    await db.exec(sql);
  }
}
