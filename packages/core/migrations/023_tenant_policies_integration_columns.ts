/**
 * Migration 023 -- `tenant_policies` integration columns.
 *
 * Adds the seven integration-feature columns that were previously created
 * at runtime by `TenantPolicyManager._migrateIntegrationColumns()`:
 *
 *   router_enabled            INTEGER
 *   router_required           INTEGER NOT NULL DEFAULT 0
 *   router_policy             TEXT
 *   auto_index                INTEGER
 *   auto_index_required       INTEGER NOT NULL DEFAULT 0
 *   tensorzero_enabled        INTEGER
 *   allowed_k8s_contexts      TEXT NOT NULL DEFAULT '[]'
 *
 * The manager's runtime ALTER loop ran 7 statements on every first call
 * to any of its public methods; this migration moves that schema work
 * into the canonical migration runner so the table is fully shaped before
 * any service touches it. The follow-up code change in TenantPolicyManager
 * deletes the runtime DDL.
 *
 * Both dialects use their respective IF NOT EXISTS idiom so the migration
 * is safe to re-run.
 */

import type { DatabaseAdapter } from "../database/index.js";
import type { MigrationApplyContext } from "./types.js";
import { applySqliteIntegrationColumns } from "./023_tenant_policies_integration_columns_sqlite.js";
import { applyPostgresIntegrationColumns } from "./023_tenant_policies_integration_columns_postgres.js";
import { MIGRATIONS_TABLE } from "./runner.js";

export const VERSION = 23;
export const NAME = "tenant_policies_integration_columns";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (await alreadyApplied(ctx.db)) return;
  if (ctx.dialect === "sqlite") {
    await applySqliteIntegrationColumns(ctx.db);
  } else {
    await applyPostgresIntegrationColumns(ctx.db);
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
