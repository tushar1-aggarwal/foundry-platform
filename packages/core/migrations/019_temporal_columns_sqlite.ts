/**
 * SQLite half of migration 017 -- adds workflow_id/workflow_run_id columns to
 * sessions so operators can correlate session rows with Temporal workflow history.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

async function addColumnSafe(db: DatabaseAdapter, sql: string, columnName: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!/duplicate column name/i.test(msg)) throw e;
    logDebug("general", `${columnName} column already present -- skipping`);
  }
}

export async function applySqliteTemporalColumns(db: DatabaseAdapter): Promise<void> {
  await addColumnSafe(db, "ALTER TABLE sessions ADD COLUMN workflow_id TEXT", "sessions.workflow_id");
  await addColumnSafe(db, "ALTER TABLE sessions ADD COLUMN workflow_run_id TEXT", "sessions.workflow_run_id");
}
