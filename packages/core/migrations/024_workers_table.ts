/**
 * Migration 024 -- `workers` table.
 *
 * The hosted-mode worker registry tracks available compute workers (their
 * URL, capacity, current session load, last heartbeat). Previously the
 * table was created at runtime via `WorkerRegistry.ensureSchema()` -- on
 * every first call to any of its 10 public methods. No migration owned
 * the table; the runtime DDL was the only place it existed.
 *
 * This migration moves the schema into the canonical migration runner.
 * The follow-up code change in WorkerRegistry deletes the runtime DDL.
 *
 * Both dialects use IF NOT EXISTS so the migration is safe to re-run
 * against legacy installs that already had the manager create the table.
 */

import type { DatabaseAdapter } from "../database/index.js";
import type { MigrationApplyContext } from "./types.js";
import { applySqliteWorkersTable } from "./024_workers_table_sqlite.js";
import { applyPostgresWorkersTable } from "./024_workers_table_postgres.js";
import { MIGRATIONS_TABLE } from "./runner.js";

export const VERSION = 24;
export const NAME = "workers_table";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (await alreadyApplied(ctx.db)) return;
  if (ctx.dialect === "sqlite") {
    await applySqliteWorkersTable(ctx.db);
  } else {
    await applyPostgresWorkersTable(ctx.db);
  }
}

async function alreadyApplied(db: DatabaseAdapter): Promise<boolean> {
  try {
    const row = (await db
      .prepare(`SELECT 1 AS present FROM ${MIGRATIONS_TABLE} WHERE version >= ? LIMIT 1`)
      .get(VERSION)) as { present: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}
