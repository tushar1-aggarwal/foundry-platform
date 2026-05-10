/**
 * API key management for multi-tenant auth.
 *
 * Keys follow the format: ark_<tenantId>_<random>
 * The key hash is SHA-256 (API keys are high-entropy, so bcrypt is unnecessary).
 */

import { createHash, randomBytes } from "crypto";
import type { DatabaseAdapter } from "../database/index.js";
import type { TenantContext, ApiKey } from "../../types/index.js";
import { now } from "../util/time.js";
import { MembershipRepository } from "../repositories/memberships.js";
import { TeamRepository } from "../repositories/teams.js";
import { getAncestorChain, TeamChainError } from "../scoping/team-chain.js";
import { logError } from "../observability/structured-log.js";

// ── Row type ─────────────────────────────────────────────────────────────────

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  key_hash: string;
  name: string;
  role: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  user_id: string | null;
}

function rowToApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    keyHash: row.key_hash,
    name: row.name,
    role: row.role as ApiKey["role"],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at ?? null,
    deletedBy: row.deleted_by ?? null,
    userId: row.user_id ?? null,
  };
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// ── ApiKeyManager ────────────────────────────────────────────────────────────

export class ApiKeyManager {
  constructor(private db: DatabaseAdapter) {}

  /**
   * Create a new API key. Returns the plaintext key (only shown once) and
   * the persisted record id.
   *
   * `userId` is the self-service ownership column. Pass `null` for admin
   * / tenant-level keys (the legacy code path). Pass a real `users.id`
   * for keys minted via the self-service `apikey/*` surface; the handler
   * is responsible for asserting `requireRealUser` before calling this --
   * the manager does NOT validate that the userId exists (deliberately
   * decoupled, per the soft-pointer convention).
   */
  async create(
    tenantId: string,
    name: string,
    role: "admin" | "member" | "viewer" | "worker" = "member",
    expiresAt?: string,
    userId: string | null = null,
  ): Promise<{ key: string; id: string }> {
    const id = `ak-${randomBytes(4).toString("hex")}`;
    const secret = randomBytes(24).toString("hex");
    const key = `ark_${tenantId}_${secret}`;
    const keyHash = hashKey(key);
    const ts = now();

    await this.db
      .prepare(
        `
      INSERT INTO api_keys (id, tenant_id, key_hash, name, role, created_at, last_used_at, expires_at, user_id)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `,
      )
      .run(id, tenantId, keyHash, name, role, ts, expiresAt ?? null, userId);

    return { key, id };
  }

  /**
   * Validate an API key and return the tenant context, or null if invalid/expired.
   *
   * Soft-deleted keys (migration 006) never match -- the SELECT filters on
   * `deleted_at IS NULL` so tombstoned rows can't authenticate even if
   * their hash collides with a live row in a different tenant. The partial
   * unique index `idx_api_keys_hash_live` guarantees uniqueness among
   * live rows.
   */
  async validate(key: string): Promise<TenantContext | null> {
    // Parse the key format: ark_<tenantId>_<secret>
    if (!key.startsWith("ark_")) return null;
    const parts = key.split("_");
    if (parts.length < 3) return null;
    // tenantId might contain underscores in the future, but for now it's the second segment
    const tenantId = parts[1];

    const keyHash = hashKey(key);
    const row = (await this.db
      .prepare("SELECT * FROM api_keys WHERE key_hash = ? AND tenant_id = ? AND deleted_at IS NULL")
      .get(keyHash, tenantId)) as ApiKeyRow | undefined;

    if (!row) return null;

    // Check expiry
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return null;
    }

    // Update last_used_at
    await this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), row.id);

    // Decision #11 + #12 (confirmed by Yana 2026-05-08): branch the team
    // chain on `api_keys.user_id`.
    //   - Owner set (self-service mint): `scopingUserId` is the owner's
    //     `users.id` and `teamChain` is the owner's [team, parent, ...,
    //     hod] chain -- same resolution chain as the owner's cookie
    //     session. `userId` stays the `ak-...` sentinel so the
    //     `requireRealUser` identity gate (PR #4) still blocks api-key
    //     callers from minting more keys.
    //   - Owner NULL (admin mint via admin/apikey/create -- service
    //     account / CI): tenant-only. No user-level or team-level
    //     overrides apply.
    let scopingUserId: string | null = null;
    let teamChain: string[] = [];
    if (row.user_id) {
      scopingUserId = row.user_id;
      teamChain = await this.computeOwnerTeamChain(row.user_id);
    }

    return {
      tenantId: row.tenant_id,
      userId: row.id, // API key id serves as the user identity for key-based auth
      role: row.role as TenantContext["role"],
      scopingUserId,
      teamChain,
    };
  }

  /**
   * Walk the owner's primary live membership team chain. Returns the
   * chain or `[]` if the owner has no live membership. On a chain-broken
   * data condition (cycle / depth-cap), logs the offending team_id and
   * returns `[]` -- a self-service api-key Bearer should NOT 401 the
   * caller for an org-data bug they didn't cause; the resolver will
   * fall through to tenant-level overrides instead.
   */
  private async computeOwnerTeamChain(ownerUserId: string): Promise<string[]> {
    const memberships = new MembershipRepository(this.db);
    const teams = new TeamRepository(this.db);
    const list = await memberships.listByUser(ownerUserId);
    if (list.length === 0) return [];
    const primary = list[0];
    try {
      return await getAncestorChain(teams, primary.team_id);
    } catch (err) {
      if (err instanceof TeamChainError) {
        logError(
          "auth",
          `api-key team chain broken at ${err.atTeamId} (${err.kind}) for owner=${ownerUserId} -- contact admin to fix parent_team_id`,
        );
        return [];
      }
      throw err;
    }
  }

  /**
   * List all live API keys for a tenant (key hashes are included but not the plaintext keys).
   * Soft-deleted rows are hidden by default; pass `{ includeDeleted: true }` to see them.
   */
  async list(tenantId: string, opts: { includeDeleted?: boolean } = {}): Promise<ApiKey[]> {
    const sql = opts.includeDeleted
      ? "SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC"
      : "SELECT * FROM api_keys WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC";
    const rows = (await this.db.prepare(sql).all(tenantId)) as ApiKeyRow[];
    return rows.map(rowToApiKey);
  }

  /**
   * List a single user's live API keys (self-service surface). Filters
   * to `user_id = userId AND tenant_id = tenantId AND deleted_at IS NULL`.
   *
   * `tenantId` is included in the WHERE clause as defense in depth (same
   * audit-driven concern that motivated `scoping_overrides` putting
   * tenant_id in the unique-index + every lookup): if any future
   * id-generator change collapses uniqueness across tenants, a missing
   * tenant filter would cross-leak api keys.
   *
   * Soft-deleted rows are NEVER returned -- the self-service UI doesn't
   * have an "include revoked" toggle.
   */
  async listForUser(userId: string, tenantId: string): Promise<ApiKey[]> {
    const rows = (await this.db
      .prepare(
        "SELECT * FROM api_keys WHERE user_id = ? AND tenant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
      )
      .all(userId, tenantId)) as ApiKeyRow[];
    return rows.map(rowToApiKey);
  }

  /**
   * Count a user's live API keys -- used by the handler-side per-user cap
   * check before allowing a new self-service create. Scoped by
   * `tenantId` for the same defense-in-depth reason as `listForUser`.
   */
  async countLiveForUser(userId: string, tenantId: string): Promise<number> {
    const row = (await this.db
      .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND tenant_id = ? AND deleted_at IS NULL")
      .get(userId, tenantId)) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Revoke a self-service key, scoped to the calling user AND tenant.
   * Loads the row, asserts `user_id === userId AND tenant_id === tenantId`,
   * then soft-deletes. Returns:
   *   - `true`  if revoke succeeded (or the row was already revoked -- idempotent),
   *   - `false` if no row matched, `user_id` did not match, or
   *     `tenant_id` did not match the caller.
   *
   * The handler maps `false` to FORBIDDEN. Callers that need to distinguish
   * "missing key" from "wrong owner" should look up via `listForUser`
   * first; the conflation is deliberate to avoid leaking key-id existence
   * to a non-owner caller.
   *
   * Tenant filter is defense-in-depth (matches `listForUser` /
   * `countLiveForUser` / `scoping_overrides`).
   */
  async revokeAsUser(userId: string, tenantId: string, id: string): Promise<boolean> {
    const row = (await this.db.prepare("SELECT user_id, tenant_id, deleted_at FROM api_keys WHERE id = ?").get(id)) as
      | { user_id: string | null; tenant_id: string; deleted_at: string | null }
      | undefined;
    if (!row) return false;
    if (row.user_id !== userId) return false;
    if (row.tenant_id !== tenantId) return false;
    if (row.deleted_at) return true; // idempotent
    const ts = now();
    const res = await this.db
      .prepare(
        // Scope the UPDATE to (id, user_id, tenant_id) so a concurrent
        // revoke from the same owner that lands first does not flip our
        // result to FORBIDDEN. `changes === 0` here only means "another
        // tx already deleted this row" -- which, given we just verified
        // ownership, is still success. Treat zero-changes as idempotent.
        "UPDATE api_keys SET deleted_at = ?, deleted_by = ? WHERE id = ? AND user_id = ? AND tenant_id = ? AND deleted_at IS NULL",
      )
      .run(ts, userId, id, userId, tenantId);
    if (res.changes > 0) return true;
    // The pre-check confirmed ownership and a live row, but the UPDATE
    // affected nothing. Either the row was just revoked by another
    // concurrent call from the same owner, or its owner/tenant changed
    // out from under us. Re-read once to disambiguate; if it's now
    // deleted we report idempotent success, otherwise treat as failure.
    const after = (await this.db
      .prepare("SELECT deleted_at, user_id, tenant_id FROM api_keys WHERE id = ?")
      .get(id)) as { deleted_at: string | null; user_id: string | null; tenant_id: string } | undefined;
    if (after && after.deleted_at && after.user_id === userId && after.tenant_id === tenantId) return true;
    return false;
  }

  /**
   * Revoke (soft-delete) an API key by id. Sets `deleted_at` + `deleted_by`
   * so the audit trail survives. Idempotent: calling on an already-revoked
   * key returns `true` without overwriting the original audit fields.
   *
   * When `tenantId` is provided the revoke is scoped to that tenant so a
   * caller in tenant A cannot revoke tenant B's keys by guessing an id.
   * When omitted (local CLI / admin tooling) the key is revoked regardless
   * of tenant -- callers that reach this path already hold the local DB
   * file and have full access anyway.
   *
   * `deletedBy` records who revoked the key (from `ctx.userId`). Null means
   * "system" deleter.
   */
  async revoke(id: string, tenantId?: string, deletedBy: string | null = null): Promise<boolean> {
    const lookupSql = tenantId
      ? "SELECT deleted_at FROM api_keys WHERE id = ? AND tenant_id = ?"
      : "SELECT deleted_at FROM api_keys WHERE id = ?";
    const existing = (await (tenantId
      ? this.db.prepare(lookupSql).get(id, tenantId)
      : this.db.prepare(lookupSql).get(id))) as { deleted_at: string | null } | undefined;
    if (!existing) return false;
    if (existing.deleted_at) return true;

    const ts = now();
    if (tenantId) {
      const res = await this.db
        .prepare(
          "UPDATE api_keys SET deleted_at = ?, deleted_by = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
        )
        .run(ts, deletedBy, id, tenantId);
      return res.changes > 0;
    }
    const res = await this.db
      .prepare("UPDATE api_keys SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL")
      .run(ts, deletedBy, id);
    return res.changes > 0;
  }

  /**
   * Restore a soft-deleted API key. Clears both `deleted_at` and
   * `deleted_by`. Used by admin tooling to undo an accidental revoke.
   * Tenant scoping matches `revoke()` so one tenant can't resurrect
   * another tenant's tombstones.
   */
  async restore(id: string, tenantId?: string): Promise<boolean> {
    if (tenantId) {
      const res = await this.db
        .prepare(
          "UPDATE api_keys SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND tenant_id = ? AND deleted_at IS NOT NULL",
        )
        .run(id, tenantId);
      return res.changes > 0;
    }
    const res = await this.db
      .prepare("UPDATE api_keys SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND deleted_at IS NOT NULL")
      .run(id);
    return res.changes > 0;
  }

  /**
   * Rotate an API key: revoke the old one and create a new one with the same metadata.
   *
   * When `tenantId` is provided the lookup and revoke are scoped to that
   * tenant -- this prevents a caller from rotating another tenant's keys
   * (which would both invalidate the victim's key and leak a new key
   * belonging to the victim's tenant back to the attacker).
   *
   * Rotate looks up only live rows: a tombstoned key cannot be rotated.
   */
  async rotate(id: string, tenantId?: string, deletedBy: string | null = null): Promise<{ key: string } | null> {
    const sql = tenantId
      ? "SELECT * FROM api_keys WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL"
      : "SELECT * FROM api_keys WHERE id = ? AND deleted_at IS NULL";
    const row = (await (tenantId ? this.db.prepare(sql).get(id, tenantId) : this.db.prepare(sql).get(id))) as
      | ApiKeyRow
      | undefined;
    if (!row) return null;

    await this.revoke(id, tenantId, deletedBy);
    const result = await this.create(row.tenant_id, row.name, row.role as ApiKey["role"], row.expires_at ?? undefined);
    return { key: result.key };
  }
}
