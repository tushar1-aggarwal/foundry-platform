/**
 * Migration 025 -- `instance_heartbeat` table.
 *
 * Daemon-instance liveness tracking (PID + last-heartbeat timestamp).
 * Used by `registerInstance` / `activeInstanceCount` in
 * `packages/core/infra/instance-lock.ts` to detect concurrent ark
 * daemons against the same DB.
 *
 * Previously the table was created at runtime inside `registerInstance`
 * (boot-path) and `activeInstanceCount` (on-demand utility). On the
 * Postgres path migration 001 already created the table via
 * `initPostgresSchema`; on SQLite it was created only at runtime.
 * This migration moves the schema into the canonical migration runner
 * for both dialects.
 */

import type { DatabaseAdapter } from "../database/index.js";
import type { MigrationApplyContext } from "./types.js";
import { applySqliteInstanceHeartbeat } from "./025_instance_heartbeat_sqlite.js";
import { applyPostgresInstanceHeartbeat } from "./025_instance_heartbeat_postgres.js";
import { MIGRATIONS_TABLE } from "./runner.js";

export const VERSION = 25;
export const NAME = "instance_heartbeat";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (await alreadyApplied(ctx.db)) return;
  if (ctx.dialect === "sqlite") {
    await applySqliteInstanceHeartbeat(ctx.db);
  } else {
    await applyPostgresInstanceHeartbeat(ctx.db);
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
