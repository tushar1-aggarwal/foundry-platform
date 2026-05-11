/**
 * SQLite half of migration 015 -- drop the legacy `provider` columns from
 * `compute` + `compute_templates` and drop the matching index.
 *
 * Order:
 *   1. Firecracker data fixup. Rows with the legacy "firecracker as
 *      isolation" shape get rewritten to "firecracker as compute kind"
 *      so `app.getCompute('firecracker')` resolves to FirecrackerCompute.
 *      Done first so the legacy `provider` column is still queryable for
 *      diagnostics if a row needs manual inspection.
 *   2. Drop `idx_compute_provider`.
 *   3. Drop `compute.provider`.
 *   4. Drop `compute_templates.provider`.
 *
 * SQLite 3.35+ supports `ALTER TABLE ... DROP COLUMN` natively (and
 * bun:sqlite ships 3.46+), so we don't need the
 * recreate-table-and-copy-rows dance. The drops are wrapped to swallow
 * "no such column" so re-runs are idempotent (SQLite's DROP COLUMN
 * doesn't accept IF EXISTS).
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applySqliteDropLegacyProviderColumns(db: DatabaseAdapter): Promise<void> {
  // 0. Ensure compute_templates has compute_kind + isolation_kind before we
  //    touch them. Installs created before these columns were added to the
  //    initial schema have only the legacy `provider` column. SQLite has no
  //    ADD COLUMN IF NOT EXISTS, so swallow the "duplicate column name" error.
  await addColumnIfMissing(db, "ALTER TABLE compute_templates ADD COLUMN compute_kind TEXT NOT NULL DEFAULT 'local'");
  await addColumnIfMissing(
    db,
    "ALTER TABLE compute_templates ADD COLUMN isolation_kind TEXT NOT NULL DEFAULT 'direct'",
  );

  // Backfill compute_kind from provider only when the legacy provider column
  // still exists (old installs). Fresh SQLite DBs created with the current
  // initSchema (which dropped provider from compute_templates) skip this.
  const hasProvider = await sqliteColumnExists(db, "compute_templates", "provider");
  if (hasProvider) {
    await db
      .prepare(
        `UPDATE compute_templates
          SET compute_kind = provider
          WHERE compute_kind = 'local' AND provider IS NOT NULL AND provider != ''`,
      )
      .run();
  }

  // 1. Firecracker data fixup. Idempotent: rows already on (firecracker, direct)
  //    or (k8s, ...) are untouched. Coerces both `local + firecracker-in-container`
  //    AND `ec2 + firecracker-in-container` (the previously coerced legacy
  //    "firecracker as isolation" shapes) onto the canonical
  //    `firecracker + direct` pair.
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

  // 2. Drop the index that fed `findByProvider`. IF EXISTS is supported here.
  await runDdl(db, "DROP INDEX IF EXISTS idx_compute_provider");

  // 3 + 4. Drop the legacy `provider` columns. Swallow "no such column" for
  //         idempotent re-runs.
  await dropColumnIfExists(db, "compute", "provider");
  await dropColumnIfExists(db, "compute_templates", "provider");
}

async function runDdl(db: DatabaseAdapter, sql: string): Promise<void> {
  await db.exec(sql);
}

async function sqliteColumnExists(db: DatabaseAdapter, table: string, column: string): Promise<boolean> {
  const cols = (await db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

async function addColumnIfMissing(db: DatabaseAdapter, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!/duplicate column name/i.test(msg)) throw e;
    logDebug("general", `column already exists (idempotent): ${msg}`);
  }
}

async function dropColumnIfExists(db: DatabaseAdapter, table: string, column: string): Promise<void> {
  try {
    await runDdl(db, `ALTER TABLE ${table} DROP COLUMN ${column}`);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!/no such column|cannot drop column/i.test(msg)) throw e;
    logDebug("general", `${table}.${column} already dropped: ${msg}`);
  }
}
