/**
 * Postgres half of migration 015 -- drop the legacy `provider` columns from
 * `compute` + `compute_templates` and drop the matching index. Mirrors the
 * SQLite half. Same firecracker data fixup + same column drops; Postgres
 * supports `IF EXISTS` natively so the body is shorter.
 */

import type { DatabaseAdapter } from "../database/index.js";

async function ddl(db: DatabaseAdapter, sql: string): Promise<void> {
  await db.exec(sql);
}

async function columnExists(db: DatabaseAdapter, table: string, column: string): Promise<boolean> {
  const row = (await db
    .prepare(
      `SELECT 1 AS present FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2 LIMIT 1`,
    )
    .get(table, column)) as { present: number } | undefined;
  return !!row;
}

export async function applyPostgresDropLegacyProviderColumns(db: DatabaseAdapter): Promise<void> {
  // 0. Ensure compute_templates has compute_kind + isolation_kind before we
  //    touch them. Postgres supports ADD COLUMN IF NOT EXISTS natively.
  await ddl(db, "ALTER TABLE compute_templates ADD COLUMN IF NOT EXISTS compute_kind TEXT NOT NULL DEFAULT 'local'");
  await ddl(db, "ALTER TABLE compute_templates ADD COLUMN IF NOT EXISTS isolation_kind TEXT NOT NULL DEFAULT 'direct'");

  // Backfill compute_kind from provider only when the legacy provider column
  // still exists. Fresh installs that used the new initPostgresSchema (which
  // never included provider) skip this no-op safely.
  const hasPgProvider = await columnExists(db, "compute_templates", "provider");
  if (hasPgProvider) {
    await db
      .prepare(
        `UPDATE compute_templates
          SET compute_kind = provider
          WHERE compute_kind = 'local' AND provider IS NOT NULL AND provider != ''`,
      )
      .run();
  }

  // 1. Firecracker data fixup. Idempotent. Coerces both
  //    `local + firecracker-in-container` AND `ec2 + firecracker-in-container`
  //    (the previously coerced legacy "firecracker as isolation" shapes) onto
  //    the canonical `firecracker + direct` pair.
  await db
    .prepare(
      `UPDATE compute
        SET compute_kind = 'firecracker',
            isolation_kind = 'direct'
        WHERE isolation_kind = 'firecracker-in-container'`,
    )
    .run();
  await db
    .prepare(
      `UPDATE compute_templates
        SET compute_kind = 'firecracker',
            isolation_kind = 'direct'
        WHERE isolation_kind = 'firecracker-in-container'`,
    )
    .run();

  // 2. Drop the index that fed `findByProvider`.
  await ddl(db, "DROP INDEX IF EXISTS idx_compute_provider");

  // 3 + 4. Drop the legacy `provider` columns.
  await ddl(db, "ALTER TABLE compute DROP COLUMN IF EXISTS provider");
  await ddl(db, "ALTER TABLE compute_templates DROP COLUMN IF EXISTS provider");
}
