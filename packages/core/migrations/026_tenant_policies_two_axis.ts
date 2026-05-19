/**
 * Migration 026 -- collapse `tenant_policies` onto two-axis compute pairs.
 *
 * Before this migration `tenant_policies` stored a single provider-name
 * string per tenant (`allowed_providers`, `default_provider`) and each
 * `compute_pools` JSON element carried a `provider` string. This migration
 * replaces them with `(compute_kind, isolation_kind)` pairs:
 *
 *   allowed_compute  TEXT NOT NULL DEFAULT '[]'
 *   default_compute  TEXT NOT NULL DEFAULT '{"compute_kind":"k8s","isolation_kind":"direct"}'
 *
 * Steps:
 *   1. Add the two new columns (IF NOT EXISTS / PRAGMA-probe idiom).
 *   2. Backfill: read every row, map the old single-axis name -> a
 *      ComputeAxes pair, and also rewrite each `compute_pools` element's
 *      `provider` string into a `compute` ComputeAxes object. The JSON
 *      transform runs in TS, not raw SQL.
 *   3. Drop the old `allowed_providers` / `default_provider` columns.
 *
 * Both dialects use their respective IF NOT EXISTS / try-guarded idiom so
 * the migration is safe to re-run.
 */

import type { DatabaseAdapter } from "../database/index.js";
import type { MigrationApplyContext } from "./types.js";
import { backfillTwoAxis } from "./026_tenant_policies_two_axis_shared.js";
import { applySqliteTwoAxis } from "./026_tenant_policies_two_axis_sqlite.js";
import { applyPostgresTwoAxis } from "./026_tenant_policies_two_axis_postgres.js";
import { MIGRATIONS_TABLE } from "./runner.js";

export const VERSION = 26;
export const NAME = "tenant_policies_two_axis";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (await alreadyApplied(ctx.db)) return;
  if (ctx.dialect === "sqlite") {
    await applySqliteTwoAxis(ctx.db);
  } else {
    await applyPostgresTwoAxis(ctx.db);
  }
  await backfillTwoAxis(ctx.db);
  if (ctx.dialect === "sqlite") {
    await dropOldColumnsSqlite(ctx.db);
  } else {
    await dropOldColumnsPostgres(ctx.db);
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

async function dropOldColumnsSqlite(db: DatabaseAdapter): Promise<void> {
  for (const col of ["allowed_providers", "default_provider"]) {
    try {
      await db.exec(`ALTER TABLE tenant_policies DROP COLUMN ${col}`);
    } catch {
      // SQLite has no DROP COLUMN IF EXISTS; "no such column" on a re-run is benign.
    }
  }
}

async function dropOldColumnsPostgres(db: DatabaseAdapter): Promise<void> {
  for (const col of ["allowed_providers", "default_provider"]) {
    try {
      await db.exec(`ALTER TABLE tenant_policies DROP COLUMN IF EXISTS ${col}`);
    } catch {
      // benign on re-run
    }
  }
}
