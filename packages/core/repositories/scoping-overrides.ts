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
  /**
   * Actor identifier for the last set/update. Opaque string -- NOT
   * necessarily a `users.id`: cookie callers store their real users.id
   * here, admin api-key callers store the api_keys row id (`ak-...`),
   * local-mode admin stores the literal `"local"`. NULL for pre-Phase-2
   * rows that predate this column. Audit consumers should treat as
   * opaque.
   */
  set_by: string | null;
  /**
   * Actor identifier for the soft-delete. Same opacity rules as
   * `set_by`. NULL for live rows.
   */
  deleted_by: string | null;
}

export interface ListForTenantOptions {
  scope_kind?: ScopeKind;
  scope_id?: string;
  key?: string;
  includeDeleted?: boolean;
  /**
   * Safety cap on rows returned. Defaults to `DEFAULT_LIST_LIMIT`
   * (1000). Pagination is not implemented in Phase 2; this cap exists
   * to prevent a runaway DB read if a tenant somehow accumulates a
   * pathological number of overrides. A future PR will add proper
   * cursor pagination if a tenant approaches the cap.
   */
  limit?: number;
}

/**
 * Default ceiling on `listForTenant` results. A typical tenant has well
 * under 100 overrides; this cap is defense-in-depth, not a usability
 * setting.
 */
export const DEFAULT_LIST_LIMIT = 1000;

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
  setBy: string | null;
  deletedBy: string | null;
};

/**
 * Best-effort detection of a UNIQUE-constraint violation across our two
 * supported dialects. SQLite (bun:sqlite) surfaces it as a SqliteError
 * with code "SQLITE_CONSTRAINT_UNIQUE" or a message containing
 * "UNIQUE constraint failed"; postgres (pg) uses SQLSTATE 23505.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "23505") return true;
  if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  if (typeof e.message === "string" && e.message.includes("UNIQUE constraint failed")) return true;
  return false;
}

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
    set_by: row.setBy ?? null,
    deleted_by: row.deletedBy ?? null,
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
   * (they remain a tombstone of the prior override). Optional `setBy`
   * is recorded on both insert and update.
   *
   * Concurrent-set safety: the partial unique index
   * `(scope_kind, scope_id, key, tenant_id) WHERE deleted_at IS NULL`
   * means two concurrent inserts for the same key race -- the second one
   * hits a UNIQUE violation. We catch that and fall through to UPDATE.
   * Bounded retry (max 2) so a persistent constraint problem still
   * propagates rather than infinite-looping.
   *
   * Returned row is constructed from the values we just wrote rather
   * than re-fetched. Saves a SELECT on every call AND closes a small
   * race (a concurrent delete landing between our write and the
   * re-fetch would have made the old `(await this.get(k))!` throw a
   * non-null-assertion error from a row that's now tombstoned). The
   * row is "what we just set," which is exactly what the caller asked
   * for -- tombstoning by someone else immediately after is the next
   * caller's concern, not ours.
   */
  async set(k: ScopingOverrideKey, value: unknown, setBy: string | null = null): Promise<ScopingOverrideRow> {
    const valueJson = JSON.stringify(value);
    const d = this.d();
    const t = d.schema.scopingOverrides;
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.get(k);
      const ts = now();
      if (existing) {
        await (d.db as any).update(t).set({ valueJson, updatedAt: ts, setBy }).where(eq(t.id, existing.id));
        return {
          id: existing.id,
          scope_kind: k.scope_kind,
          scope_id: k.scope_id,
          key: k.key,
          value_json: valueJson,
          tenant_id: k.tenant_id,
          created_at: existing.created_at,
          updated_at: ts,
          // existing.deleted_at is null by definition (get() filtered it).
          // existing.deleted_by SHOULD be null too -- delete() sets both
          // together and nothing else touches deleted_by -- but mirror
          // whatever the DB has so a future caller-pattern (or raw-SQL
          // corruption) doesn't read a stale-cached null here.
          deleted_at: null,
          set_by: setBy,
          deleted_by: existing.deleted_by,
        };
      }
      const id = crypto.randomUUID();
      try {
        await (d.db as any).insert(t).values({
          id,
          scopeKind: k.scope_kind,
          scopeId: k.scope_id,
          key: k.key,
          valueJson,
          tenantId: k.tenant_id,
          createdAt: ts,
          updatedAt: ts,
          setBy,
        });
        return {
          id,
          scope_kind: k.scope_kind,
          scope_id: k.scope_id,
          key: k.key,
          value_json: valueJson,
          tenant_id: k.tenant_id,
          created_at: ts,
          updated_at: ts,
          deleted_at: null,
          set_by: setBy,
          deleted_by: null,
        };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Concurrent insert won the race; loop and take the UPDATE path.
      }
    }
    throw new Error(
      `scoping_overrides.set: repeated UNIQUE violation for (${k.scope_kind}, ${k.scope_id}, ${k.key}, ${k.tenant_id})`,
    );
  }

  /**
   * Tenant-scoped fetch by primary id.
   *
   * **Returns tombstoned rows.** This is the deliberate asymmetry with
   * every other read on this repository (`get`, `getMany`,
   * `listForTenant` without `includeDeleted`) -- those all filter
   * `WHERE deleted_at IS NULL` because they serve the runtime resolver
   * path, where applying a tombstoned override would be a correctness
   * bug. `getById` serves the admin audit drill-down path
   * (`admin/scoping/get`, `ark scoping get <id>`, the dashboard audit
   * drawer): operators clicking into a row -- including a row they
   * just deleted -- need to see the full audit context. The returned
   * row carries `deleted_at` / `deleted_by` so the caller can render
   * "(deleted)" indicators (the CLI's `formatRow` and the dashboard's
   * `ScopingAuditDrawer` both do this).
   *
   * Cross-tenant guard is still strict: returns null when the id is
   * missing OR belongs to a different tenant. Never leaks cross-tenant
   * rows even if a caller guesses an id.
   */
  async getById(id: string, tenantId: string): Promise<ScopingOverrideRow | null> {
    const d = this.d();
    const t = d.schema.scopingOverrides;
    const rows = await (d.db as any)
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
      .limit(1);
    const row = (rows as DrizzleSelectScopingOverride[])[0];
    return row ? toPublic(row) : null;
  }

  /**
   * List overrides for `tenantId`, with optional filters on
   * `scope_kind` / `scope_id` / `key` and an `includeDeleted` toggle.
   * Tenant filter is always applied -- callers can never accidentally
   * (or maliciously) read another tenant's rows.
   */
  async listForTenant(tenantId: string, opts: ListForTenantOptions = {}): Promise<ScopingOverrideRow[]> {
    const d = this.d();
    const t = d.schema.scopingOverrides;
    const conds = [eq(t.tenantId, tenantId)];
    if (opts.scope_kind !== undefined) conds.push(eq(t.scopeKind, opts.scope_kind));
    if (opts.scope_id !== undefined) conds.push(eq(t.scopeId, opts.scope_id));
    if (opts.key !== undefined) conds.push(eq(t.key, opts.key));
    if (!opts.includeDeleted) conds.push(isNull(t.deletedAt));
    const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
    const rows = await (d.db as any)
      .select()
      .from(t)
      .where(and(...conds))
      .limit(limit);
    return (rows as DrizzleSelectScopingOverride[]).map(toPublic);
  }

  /**
   * Soft-delete by primary id, tenant-scoped. Returns true on success,
   * false if the id is missing or belongs to a different tenant.
   * Idempotent: re-deleting an already-deleted row returns false (no
   * live row to UPDATE), which the caller can treat as success.
   */
  async deleteById(id: string, tenantId: string, deletedBy: string | null = null): Promise<boolean> {
    const d = this.d();
    const t = d.schema.scopingOverrides;
    const ts = now();
    const res = await (d.db as any)
      .update(t)
      .set({ deletedAt: ts, updatedAt: ts, deletedBy })
      .where(and(eq(t.id, id), eq(t.tenantId, tenantId), isNull(t.deletedAt)));
    return extractChanges(res) > 0;
  }

  /**
   * Soft-delete the live row matching `k`. Returns true if a row was
   * deleted, false if none existed (idempotent on repeat). Optional
   * `deletedBy` is recorded for audit.
   */
  async delete(k: ScopingOverrideKey, deletedBy: string | null = null): Promise<boolean> {
    const d = this.d();
    const t = d.schema.scopingOverrides;
    const ts = now();
    const res = await (d.db as any)
      .update(t)
      .set({ deletedAt: ts, updatedAt: ts, deletedBy })
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
