/**
 * SQLite half of migration 023 -- add the seven integration columns to
 * `tenant_policies`. SQLite has no `ADD COLUMN IF NOT EXISTS`, so we
 * PRAGMA-probe the column list first and skip columns that already
 * exist (legacy installs that ran `TenantPolicyManager._migrateIntegrationColumns`
 * already have most of them).
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

export async function applySqliteIntegrationColumns(db: DatabaseAdapter): Promise<void> {
  // Defense in depth: ensure the parent table exists. Migration 008 is
  // the canonical creator; a legacy install that never ran 008 but only
  // ever touched the lazy ensureSchema path is unlikely but cheap to handle.
  await runDdl(
    db,
    `CREATE TABLE IF NOT EXISTS tenant_policies (
      tenant_id TEXT PRIMARY KEY,
      allowed_providers TEXT NOT NULL DEFAULT '[]',
      default_provider TEXT NOT NULL DEFAULT 'k8s',
      max_concurrent_sessions INTEGER NOT NULL DEFAULT 10,
      max_cost_per_day_usd REAL,
      compute_pools TEXT NOT NULL DEFAULT '[]',
      compute_config_yaml TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );

  const existing = await columnNames(db, "tenant_policies");
  for (const [col, def] of COLUMNS) {
    if (existing.has(col)) {
      logDebug("general", `tenant_policies.${col} already present`);
      continue;
    }
    await runDdl(db, `ALTER TABLE tenant_policies ADD COLUMN ${col} ${def}`);
  }
}

async function columnNames(db: DatabaseAdapter, table: string): Promise<Set<string>> {
  try {
    const rows = (await db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

async function runDdl(db: DatabaseAdapter, sql: string): Promise<void> {
  try {
    await db.prepare(sql).run();
  } catch {
    logDebug("general", "tenant_policies_integration_columns DDL step skipped");
  }
}
