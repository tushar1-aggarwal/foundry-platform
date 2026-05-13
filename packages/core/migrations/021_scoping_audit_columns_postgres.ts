/**
 * Migration 021 (Postgres) -- audit columns on `scoping_overrides`.
 *
 * Mirrors the SQLite half. Postgres ADD COLUMN IF NOT EXISTS does
 * the duplicate-column defense natively.
 */

import type { DatabaseAdapter } from "../database/index.js";

const STATEMENTS = [
  "ALTER TABLE scoping_overrides ADD COLUMN IF NOT EXISTS set_by TEXT",
  "ALTER TABLE scoping_overrides ADD COLUMN IF NOT EXISTS deleted_by TEXT",
];

export async function applyPostgresScopingAuditColumns(db: DatabaseAdapter): Promise<void> {
  for (const sql of STATEMENTS) {
    await db.exec(sql);
  }
}
