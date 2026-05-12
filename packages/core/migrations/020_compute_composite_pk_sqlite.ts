/**
 * SQLite half of migration 018 -- swap the compute PK from (name) to
 * (name, tenant_id).
 *
 * SQLite has no `ALTER TABLE ... DROP PRIMARY KEY` / `ADD PRIMARY KEY`.
 * The canonical workaround is the rebuild-and-copy dance:
 *
 *   1. Create `compute_new` with the desired composite PK.
 *   2. Copy rows from `compute` to `compute_new`.
 *   3. Drop the old indexes (their definitions reference the old `compute`).
 *   4. Drop `compute`.
 *   5. Rename `compute_new` to `compute`.
 *   6. Recreate indexes on the new table.
 *
 * Idempotent: introspects `sqlite_master` first to detect the post-migration
 * shape and skips work when already applied. Detection uses the textual
 * `sql` column of the table-creation statement, which is the only place
 * the PK declaration is preserved in SQLite metadata.
 *
 * Foreign keys: migration runner toggles `PRAGMA foreign_keys = OFF` for
 * SQLite migrations, so the rename below cannot trip cascading deletes
 * even on installs that have FK enforcement turned on elsewhere.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applySqliteComputeCompositePk(db: DatabaseAdapter): Promise<void> {
  const row = (await db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'compute' LIMIT 1`)
    .get()) as { sql: string | null } | undefined;

  const createSql = row?.sql ?? "";
  if (/PRIMARY KEY\s*\(\s*name\s*,\s*tenant_id\s*\)/i.test(createSql)) {
    logDebug("general", "compute PK already (name, tenant_id) -- skipping");
    return;
  }

  await db.exec(`
    CREATE TABLE compute_new (
      name TEXT NOT NULL,
      compute_kind TEXT NOT NULL DEFAULT 'local',
      isolation_kind TEXT NOT NULL DEFAULT 'direct',
      status TEXT NOT NULL DEFAULT 'stopped',
      config TEXT DEFAULT '{}',
      is_template INTEGER NOT NULL DEFAULT 0,
      cloned_from TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (name, tenant_id)
    )
  `);

  await db.exec(`
    INSERT INTO compute_new (
      name, compute_kind, isolation_kind, status, config,
      is_template, cloned_from, tenant_id, created_at, updated_at
    )
    SELECT
      name, compute_kind, isolation_kind, status, config,
      is_template, cloned_from, tenant_id, created_at, updated_at
    FROM compute
  `);

  await db.exec("DROP INDEX IF EXISTS idx_compute_kind");
  await db.exec("DROP INDEX IF EXISTS idx_compute_isolation_kind");
  await db.exec("DROP INDEX IF EXISTS idx_compute_status");
  await db.exec("DROP INDEX IF EXISTS idx_compute_tenant");

  await db.exec("DROP TABLE compute");
  await db.exec("ALTER TABLE compute_new RENAME TO compute");

  await db.exec("CREATE INDEX IF NOT EXISTS idx_compute_kind ON compute(compute_kind)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_compute_isolation_kind ON compute(isolation_kind)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_compute_status ON compute(status)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_compute_tenant ON compute(tenant_id)");
}
