/**
 * Postgres half of migration 026 -- add the two-axis columns to
 * `tenant_policies`. Postgres supports `ADD COLUMN IF NOT EXISTS`, so no
 * PRAGMA probe is needed.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

const COLUMNS: Array<[string, string]> = [
  ["allowed_compute", "TEXT NOT NULL DEFAULT '[]'"],
  ["default_compute", `TEXT NOT NULL DEFAULT '{"compute_kind":"k8s","isolation_kind":"direct"}'`],
];

export async function applyPostgresTwoAxis(db: DatabaseAdapter): Promise<void> {
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
    logDebug("general", "tenant_policies_two_axis DDL step skipped");
  }
}
