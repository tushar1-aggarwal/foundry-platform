/**
 * Postgres half of migration 023 -- add the seven integration columns to
 * `tenant_policies`. Postgres supports `ADD COLUMN IF NOT EXISTS`, so no
 * PRAGMA probe is needed.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

const COLUMNS: Array<[string, string]> = [
  ["router_enabled", "INTEGER"],
  ["router_required", "INTEGER NOT NULL DEFAULT 0"],
  ["router_policy", "TEXT"],
  ["auto_index", "INTEGER"],
  ["auto_index_required", "INTEGER NOT NULL DEFAULT 0"],
  ["tensorzero_enabled", "INTEGER"],
  ["allowed_k8s_contexts", "TEXT NOT NULL DEFAULT '[]'"],
];

export async function applyPostgresIntegrationColumns(db: DatabaseAdapter): Promise<void> {
  await runDdl(
    db,
    `CREATE TABLE IF NOT EXISTS tenant_policies (
      tenant_id TEXT PRIMARY KEY,
      allowed_providers TEXT NOT NULL DEFAULT '[]',
      default_provider TEXT NOT NULL DEFAULT 'k8s',
      max_concurrent_sessions INTEGER NOT NULL DEFAULT 10,
      max_cost_per_day_usd DOUBLE PRECISION,
      compute_pools TEXT NOT NULL DEFAULT '[]',
      compute_config_yaml TEXT,
      created_at TEXT NOT NULL DEFAULT now()::text,
      updated_at TEXT NOT NULL DEFAULT now()::text
    )`,
  );

  for (const [col, def] of COLUMNS) {
    await runDdl(db, `ALTER TABLE tenant_policies ADD COLUMN IF NOT EXISTS ${col} ${def}`);
  }
}

async function runDdl(db: DatabaseAdapter, sql: string): Promise<void> {
  try {
    await db.prepare(sql).run();
  } catch {
    logDebug("general", "tenant_policies_integration_columns DDL step skipped");
  }
}
