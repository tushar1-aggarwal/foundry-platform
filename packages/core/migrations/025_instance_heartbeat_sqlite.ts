/**
 * SQLite half of migration 025 -- create the `instance_heartbeat` table.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applySqliteInstanceHeartbeat(db: DatabaseAdapter): Promise<void> {
  await runDdl(
    db,
    `CREATE TABLE IF NOT EXISTS instance_heartbeat (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL
    )`,
  );
}

async function runDdl(db: DatabaseAdapter, sql: string): Promise<void> {
  try {
    await db.prepare(sql).run();
  } catch {
    logDebug("general", "instance_heartbeat DDL step skipped");
  }
}
