/**
 * Migration 018 (SQLite) -- backfill scoping_overrides for early adopters.
 *
 * Background: migration 017 was extended in-place to include `scoping_overrides`
 * after some installs had already applied the original 017 (#549). The runner
 * keys on integer version, so a row in `ark_schema_migrations` saying "017 done"
 * blocks the table creation from re-running. This migration creates the table
 * unconditionally with `IF NOT EXISTS` -- fresh installs (which got the table
 * via the updated 017) treat this as a no-op; affected installs get the table
 * created here.
 *
 * Body matches `017_auth_phase1_sqlite.ts:CREATE_SCOPING_OVERRIDES` byte for
 * byte (column types, defaults, indexes). Don't drift -- the resolver opens
 * its own typed reader against this shape.
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

export async function applySqliteScopingOverridesBackfill(db: DatabaseAdapter): Promise<void> {
  await db.exec(CREATE_SCOPING_OVERRIDES);
  for (const sql of SCOPING_OVERRIDES_INDEXES) {
    await db.exec(sql);
  }
}
