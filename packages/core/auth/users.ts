/**
 * UserManager -- CRUD for user identities, keyed by email.
 *
 * Authentication (password, OIDC, JWT verification, ...) is out of scope.
 * Users here are durable identities that memberships hang off. An auth
 * layer that has just validated a credential calls `upsertByEmail` to
 * create-or-fetch the user without worrying about races.
 *
 * Mirrors `TenantPolicyManager`: lazy `ensureSchema()`, async end-to-end.
 */

import type { DatabaseAdapter } from "../database/index.js";
import {
  UserRepository,
  type ListOptions,
  type TenantSearchUser,
  type TenantUserRow,
  type UserRow,
  type UserWithTenantTeamCount,
} from "../repositories/users.js";
import { MembershipRepository, type MembershipWithTeamTenant } from "../repositories/memberships.js";
import { logDebug } from "../observability/structured-log.js";

export type User = UserRow;
export type { TenantSearchUser, TenantUserRow, UserWithTenantTeamCount, MembershipWithTeamTenant };

const MIN_SEARCH_LEN = 3;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertEmail(email: string): void {
  if (!EMAIL_RE.test(email)) {
    throw new Error(`Invalid email '${email}'`);
  }
}

export class UserManager {
  private _initialized: Promise<void> | null = null;
  private _repo: UserRepository;
  private _memberships: MembershipRepository;

  constructor(private db: DatabaseAdapter) {
    this._repo = new UserRepository(db);
    this._memberships = new MembershipRepository(db);
  }

  private async ensureSchema(): Promise<void> {
    if (this._initialized) return this._initialized;
    this._initialized = (async () => {
      try {
        await this.db.exec(
          `CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            name TEXT,
            deleted_at TEXT,
            deleted_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`,
        );
      } catch {
        logDebug("general", "users table exists");
      }
    })();
    return this._initialized;
  }

  async list(opts: ListOptions = {}): Promise<User[]> {
    await this.ensureSchema();
    return this._repo.list(opts);
  }

  /**
   * Tenant-scoped user listing for the UsersTab under the
   * tenant-admin model: users with ≥1 membership in `tenantId` OR
   * global orphans. Cross-tenant-only users are filtered out at the
   * repo. Each row carries a `team_count` scoped to `tenantId`.
   */
  async listInTenantOrOrphanWithTeamCount(tenantId: string): Promise<UserWithTenantTeamCount[]> {
    await this.ensureSchema();
    return this._repo.listInTenantOrOrphanWithTeamCount(tenantId);
  }

  async get(idOrEmail: string, opts: ListOptions = {}): Promise<User | null> {
    await this.ensureSchema();
    const byId = await this._repo.get(idOrEmail, opts);
    if (byId) return byId;
    return this._repo.getByEmail(idOrEmail, opts);
  }

  async create(opts: { email: string; name?: string | null }): Promise<User> {
    await this.ensureSchema();
    assertEmail(opts.email);
    const existing = await this._repo.getByEmail(opts.email);
    if (existing) throw new Error(`User with email '${opts.email}' already exists`);
    return this._repo.create(opts);
  }

  async upsertByEmail(opts: { email: string; name?: string | null }): Promise<User> {
    await this.ensureSchema();
    assertEmail(opts.email);
    return this._repo.upsertByEmail(opts);
  }

  /**
   * Soft-delete a user and cascade to their memberships inside a
   * transaction. Idempotent.
   *
   * `actingUserId` is the id of the caller performing the delete (from
   * `ctx.userId`); it's recorded in `deleted_by` on both the user row AND
   * every cascaded membership. `null` (the default) means "system" deleter.
   *
   * Note: `actingUserId` is distinct from the `id` being deleted -- a user
   * can't be both the target and the actor unless an admin is revoking
   * their own account.
   */
  async delete(id: string, actingUserId: string | null = null): Promise<boolean> {
    await this.ensureSchema();
    return this.db.transaction(async () => {
      const ok = await this._repo.softDelete(id, actingUserId);
      if (!ok) return false;
      await this._memberships.softRemoveByUser(id, actingUserId);
      return true;
    });
  }

  async restore(id: string): Promise<boolean> {
    await this.ensureSchema();
    return this._repo.restore(id);
  }

  /**
   * Tenant-scoped user search for autocomplete UIs. This layer enforces
   * the 3-char minimum (returns `[]` for shorter inputs); the underlying
   * `UserRepository.searchByTenant` caps results at 50 regardless of the
   * caller-supplied `limit`.
   *
   * If `contextTeamId` is supplied, each row carries the user's existing
   * role in that team (or `null`); the TeamsTab combobox uses this to
   * tag already-members and flip the Add/Update-role button.
   */
  async searchByTenant(
    tenantId: string,
    q: string,
    opts: { limit?: number; contextTeamId?: string } = {},
  ): Promise<TenantSearchUser[]> {
    await this.ensureSchema();
    const trimmed = q.trim();
    if (trimmed.length < MIN_SEARCH_LEN) return [];
    return this._repo.searchByTenant(tenantId, trimmed, opts);
  }

  /**
   * Per-user membership listing joined with team + tenant identity.
   * Live rows only -- a row is included iff the membership, its team,
   * and the tenant are all live. Used by the UsersTab memberships
   * drawer to render where a user lives and as what.
   *
   * Optional `tenantId` narrows the result to memberships in that
   * tenant only. Handlers running under the tenant-admin model pass
   * `ctx.tenantId` so cross-tenant memberships of the same user stay
   * invisible to admins outside their tenant.
   */
  async listMemberships(userId: string, opts: { tenantId?: string } = {}): Promise<MembershipWithTeamTenant[]> {
    await this.ensureSchema();
    return this._memberships.listByUserWithTeamTenant(userId, opts);
  }

  /**
   * Tenant-anchored user roll-up for the TenantsTab. Read-only -- the
   * mutation surface stays on TeamsTab + UsersTab.
   */
  async listTenantUsers(tenantId: string): Promise<TenantUserRow[]> {
    await this.ensureSchema();
    return this._repo.listTenantUsers(tenantId);
  }

  /**
   * Counts live memberships for `userId`, split by whether the team's
   * tenant matches `tenantId`. The tenant-admin handlers for
   * admin/user/{get,delete} use this to gate visibility + deletion
   * decisions without two separate queries.
   */
  async tenantMembershipStats(userId: string, tenantId: string): Promise<{ in_tenant: number; out_of_tenant: number }> {
    await this.ensureSchema();
    return this._memberships.tenantMembershipStats(userId, tenantId);
  }
}
