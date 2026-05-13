/**
 * Migration 021 (SQLite) -- audit columns on `scoping_overrides`.
 *
 * Adds `set_by` and `deleted_by` (both nullable). Each ADD COLUMN is
 * wrapped in try/catch on "duplicate column name" so the migration is
 * safely re-runnable if a previous attempt added the column before the
 * apply-log row was committed (mirrors 017's pattern).
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

const ADD_SET_BY = "ALTER TABLE scoping_overrides ADD COLUMN set_by TEXT";
const ADD_DELETED_BY = "ALTER TABLE scoping_overrides ADD COLUMN deleted_by TEXT";

async function tryAddColumn(db: DatabaseAdapter, sql: string, label: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!/duplicate column name/i.test(msg)) throw e;
    logDebug("general", `${label} column already present -- skipping`);
  }
}

export async function applySqliteScopingAuditColumns(db: DatabaseAdapter): Promise<void> {
  await tryAddColumn(db, ADD_SET_BY, "scoping_overrides.set_by");
  await tryAddColumn(db, ADD_DELETED_BY, "scoping_overrides.deleted_by");
}
