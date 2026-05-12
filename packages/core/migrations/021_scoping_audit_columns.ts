/**
 * Migration 021 -- audit metadata columns on `scoping_overrides`.
 *
 * Adds `set_by` and `deleted_by` (both nullable TEXT) so the admin
 * write RPCs (`admin/scoping/*`, Phase 2) can record who created /
 * modified / soft-deleted each override row.
 *
 * `set_by` / `deleted_by` are **actor identifiers**, not necessarily
 * real `users.id`. The handler stores `ctx.userId` directly:
 *   - cookie auth          -> real `users.id` (e.g. `u-rachna`)
 *   - admin api-key auth   -> the api-key sentinel `ak-...`
 *   - local-mode admin     -> literal `"local"`
 * Soft pointer (no FK to `users.id`) -- mirrors `api_keys.deleted_by`'s
 * convention. Callers reading these columns for audit should treat
 * them as opaque string identifiers.
 *
 * Existing Phase 1 rows have NULL for both columns. No backfill;
 * pre-existing rows simply have no recorded author, which is the
 * truthful state.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteScopingAuditColumns } from "./021_scoping_audit_columns_sqlite.js";
import { applyPostgresScopingAuditColumns } from "./021_scoping_audit_columns_postgres.js";

export const VERSION = 21;
export const NAME = "scoping_audit_columns";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteScopingAuditColumns(ctx.db);
  } else {
    await applyPostgresScopingAuditColumns(ctx.db);
  }
}
