/**
 * Migration 018 -- scoping_overrides backfill for installs that applied
 * migration 017 before the scoping_overrides addition (#549).
 *
 * Idempotent on fresh installs: 017's updated body already creates the
 * table, and this migration uses CREATE TABLE IF NOT EXISTS.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteScopingOverridesBackfill } from "./018_scoping_overrides_sqlite.js";
import { applyPostgresScopingOverridesBackfill } from "./018_scoping_overrides_postgres.js";

export const VERSION = 18;
export const NAME = "scoping_overrides_backfill";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteScopingOverridesBackfill(ctx.db);
  } else {
    await applyPostgresScopingOverridesBackfill(ctx.db);
  }
}
