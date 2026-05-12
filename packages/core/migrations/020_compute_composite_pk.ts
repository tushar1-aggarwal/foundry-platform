/**
 * Migration 020 -- compute table per-tenant PK.
 *
 * Before: PRIMARY KEY (name)  -- single-tenant assumption; two tenants
 *         could not both hold a row named `local`.
 * After:  PRIMARY KEY (name, tenant_id) -- matches the rest of the
 *         tenant-scoped table family (`groups`, `compute_templates`, ...).
 *
 * Migration safety: existing rows all carry `tenant_id='default'`, so the
 * composite PK is a no-op for uniqueness on the existing data set.
 *
 * Slot reassigned 018 -> 020 when temporal-phase-3 merged main: main took
 * slots 017 (auth_phase1) + 018 (scoping_overrides) and temporal_columns
 * had to move to 019, so this lands at 020.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteComputeCompositePk } from "./020_compute_composite_pk_sqlite.js";
import { applyPostgresComputeCompositePk } from "./020_compute_composite_pk_postgres.js";

export const VERSION = 20;
export const NAME = "compute_composite_pk";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteComputeCompositePk(ctx.db);
  } else {
    await applyPostgresComputeCompositePk(ctx.db);
  }
}
