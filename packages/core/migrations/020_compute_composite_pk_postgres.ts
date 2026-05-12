/**
 * Postgres half of migration 018 -- swap the compute PK from (name) to
 * (name, tenant_id).
 *
 * Idempotent: the drop is guarded by IF EXISTS and the add checks the
 * existing constraint shape via pg_constraint so a re-run after the new
 * shape is in place is a no-op.
 *
 * Constraint name `compute_pkey` is the Postgres default for
 * `CREATE TABLE compute (name TEXT PRIMARY KEY, ...)`, which is how this
 * table was originally bootstrapped (see schema-postgres.ts before this
 * migration).
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applyPostgresComputeCompositePk(db: DatabaseAdapter): Promise<void> {
  const current = (await db
    .prepare(
      `SELECT array_agg(a.attname ORDER BY array_position(c.conkey, a.attnum)) AS cols
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = 'compute'::regclass AND c.contype = 'p'`,
    )
    .get()) as { cols: string[] | null } | undefined;

  const cols = current?.cols ?? [];
  if (cols.length === 2 && cols[0] === "name" && cols[1] === "tenant_id") {
    logDebug("general", "compute PK already (name, tenant_id) -- skipping");
    return;
  }

  await db.exec("ALTER TABLE compute DROP CONSTRAINT IF EXISTS compute_pkey");
  await db.exec("ALTER TABLE compute ADD CONSTRAINT compute_pkey PRIMARY KEY (name, tenant_id)");
}
