/**
 * Migration 019 -- Temporal workflow columns.
 *
 * Adds workflow_id and workflow_run_id to sessions (nullable, populated when
 * the Temporal orchestrator takes over a session).
 *
 * Slot reassigned 017 -> 019 when temporal-phase-3 merged main: 017 already
 * applied as auth_phase1, 018 as scoping_overrides backfill.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteTemporalColumns } from "./019_temporal_columns_sqlite.js";
import { applyPostgresTemporalColumns } from "./019_temporal_columns_postgres.js";

export const VERSION = 19;
export const NAME = "temporal_columns";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteTemporalColumns(ctx.db);
  } else {
    await applyPostgresTemporalColumns(ctx.db);
  }
}
