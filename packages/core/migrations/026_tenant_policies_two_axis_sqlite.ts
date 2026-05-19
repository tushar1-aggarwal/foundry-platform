/**
 * SQLite half of migration 026 -- add the two-axis columns to
 * `tenant_policies`. SQLite has no `ADD COLUMN IF NOT EXISTS`, so we
 * PRAGMA-probe the column list first and skip columns that already exist.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

const COLUMNS: Array<[string, string]> = [
  ["allowed_compute", "TEXT NOT NULL DEFAULT '[]'"],
  ["default_compute", `TEXT NOT NULL DEFAULT '{"compute_kind":"k8s","isolation_kind":"direct"}'`],
];

export async function applySqliteTwoAxis(db: DatabaseAdapter): Promise<void> {
  // Defense in depth: ensure the parent table exists with its pre-026
  // shape so the ADD COLUMN + backfill have something to operate on.
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
    logDebug("general", "tenant_policies_two_axis DDL step skipped");
  }
}
