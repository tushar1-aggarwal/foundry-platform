/**
 * SQLite half of migration 024 -- create the `workers` table.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applySqliteWorkersTable(db: DatabaseAdapter): Promise<void> {
  await runDdl(
    db,
    `CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'online',
      capacity INTEGER NOT NULL DEFAULT 5,
      active_sessions INTEGER NOT NULL DEFAULT 0,
      last_heartbeat TEXT NOT NULL,
      compute_name TEXT,
      tenant_id TEXT,
      metadata TEXT DEFAULT '{}'
    )`,
  );
  // Indexes that match the WorkerRegistry query shapes (status + capacity
  // filter on every `getAvailable`/`getLeastLoaded`; tenant filter on the
  // multi-tenant scheduler path).
  await runDdl(db, "CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status)");
  await runDdl(db, "CREATE INDEX IF NOT EXISTS idx_workers_tenant ON workers(tenant_id)");
}

async function runDdl(db: DatabaseAdapter, sql: string): Promise<void> {
  try {
    await db.prepare(sql).run();
  } catch {
    logDebug("general", "workers_table DDL step skipped");
  }
}
