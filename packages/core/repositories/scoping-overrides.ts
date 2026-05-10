/**
 * ScopingOverrideRepository -- drizzle-backed adapter for the
 * `scoping_overrides` table.
 *
 * Override rows must be inserted via SQL playbook for now -- admin write
 * RPCs are deferred to Phase 2 (decision #9). The `set` / `delete` methods
 * here exist for tests + future RPC wiring; production reads go through
 * `ScopingResolver.resolve()`.
 *
 * tenant_id is part of every lookup (decision #13). Same defense in depth
 * that motivates the partial-unique-index columns: if any future
 * id-generator change collapses uniqueness across tenants, the resolver
 * still cannot cross-leak overrides.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { now } from "../util/time.js";
import { extractChanges } from "./tenants.js";

export type ScopeKind = "user" | "team" | "tenant";

export interface ScopingOverrideKey {
  scope_kind: ScopeKind;
  scope_id: string;
  key: string;
  tenant_id: string;
}

export interface ScopingOverrideRow {
  id: string;
  scope_kind: ScopeKind;
  scope_id: string;
  key: string;
  value_json: string;
  tenant_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

type DrizzleSelectScopingOverride = {
  id: string;
  scopeKind: string;
  scopeId: string;
  key: string;
  valueJson: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

function toPublic(row: DrizzleSelectScopingOverride): ScopingOverrideRow {
  return {
    id: row.id,
    scope_kind: row.scopeKind as ScopeKind,
    scope_id: row.scopeId,
    key: row.key,
    value_json: row.valueJson,
    tenant_id: row.tenantId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt ?? null,
  };
}

export class ScopingOverrideRepository {
  private _d: DrizzleClient | null = null;

  constructor(private db: DatabaseAdapter) {}

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  /** Single-row lookup. Returns null when no live row matches. */
  async get(k: ScopingOverrideKey): Promise<ScopingOverrideRow | null> {
    const d = this.d();
    const t = d.schema.scopingOverrides;
    const rows = await (d.db as any)
      .select()
      .from(t)
      .where(
        and(
          eq(t.scopeKind, k.scope_kind),
          eq(t.scopeId, k.scope_id),
          eq(t.key, k.key),
          eq(t.tenantId, k.tenant_id),
          isNull(t.deletedAt),
        ),
      )
      .limit(1);
    const row = (rows as DrizzleSelectScopingOverride[])[0];
    return row ? toPublic(row) : null;
  }

  /**
   * Batch lookup for one (scope_kind, key, tenant_id) across many scope_ids.
   * Resolver currently uses `get` per hop; this is here for a future
   * batched walk if profiling shows the per-hop SELECT is the bottleneck.
   */
  async getMany(args: {
    scope_kind: ScopeKind;
    scope_ids: string[];
    key: string;
    tenant_id: string;
  }): Promise<ScopingOverrideRow[]> {
    if (args.scope_ids.length === 0) return [];
    const d = this.d();
    const t = d.schema.scopingOverrides;
    const rows = await (d.db as any)
      .select()
      .from(t)
      .where(
        and(
          eq(t.scopeKind, args.scope_kind),
          inArray(t.scopeId, args.scope_ids),
          eq(t.key, args.key),
          eq(t.tenantId, args.tenant_id),
          isNull(t.deletedAt),
        ),
      );
    return (rows as DrizzleSelectScopingOverride[]).map(toPublic);
  }

  /**
   * Upsert: insert if no live row exists for the key, or update the
   * existing live row's value_json. Soft-deleted rows are not touched
   * (they remain a tombstone of the prior override).
   */
  async set(k: ScopingOverrideKey, value: unknown): Promise<ScopingOverrideRow> {
    const existing = await this.get(k);
    const ts = now();
    const valueJson = JSON.stringify(value);
    const d = this.d();
    const t = d.schema.scopingOverrides;
    if (existing) {
      await (d.db as any).update(t).set({ valueJson, updatedAt: ts }).where(eq(t.id, existing.id));
      return (await this.get(k))!;
    }
    const id = crypto.randomUUID();
    await (d.db as any).insert(t).values({
      id,
      scopeKind: k.scope_kind,
      scopeId: k.scope_id,
      key: k.key,
      valueJson,
      tenantId: k.tenant_id,
      createdAt: ts,
      updatedAt: ts,
    });
    return (await this.get(k))!;
  }

  /**
   * Soft-delete the live row matching `k`. Returns true if a row was
   * deleted, false if none existed (idempotent on repeat).
   */
  async delete(k: ScopingOverrideKey): Promise<boolean> {
    const d = this.d();
    const t = d.schema.scopingOverrides;
    const ts = now();
    const res = await (d.db as any)
      .update(t)
      .set({ deletedAt: ts, updatedAt: ts })
      .where(
        and(
          eq(t.scopeKind, k.scope_kind),
          eq(t.scopeId, k.scope_id),
          eq(t.key, k.key),
          eq(t.tenantId, k.tenant_id),
          isNull(t.deletedAt),
        ),
      );
    return extractChanges(res) > 0;
  }
}
