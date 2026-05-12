/**
 * Postgres half of migration 017 -- adds workflow_id/workflow_run_id columns
 * to sessions so operators can correlate session rows with Temporal workflow history.
 */

import type { DatabaseAdapter } from "../database/index.js";

const STATEMENTS = [
  "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workflow_id TEXT",
  "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workflow_run_id TEXT",
];

export async function applyPostgresTemporalColumns(db: DatabaseAdapter): Promise<void> {
  for (const sql of STATEMENTS) {
    await db.exec(sql);
  }
}
