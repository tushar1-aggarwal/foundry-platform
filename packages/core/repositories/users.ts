/**
 * UserRepository -- drizzle-backed adapter for the `users` table.
 *
 * Users are soft-deletable identities; email uniqueness is enforced by a
 * partial unique index scoped to live rows. Public surface preserved
 * from the pre-cutover hand-rolled SQL version.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { now } from "../util/time.js";
import { extractChanges } from "./tenants.js";

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One row in the TenantsTab "Users in this tenant" roll-up. Distinct
 * users with ≥1 live membership in any live team of the tenant; each
 * row carries the user's memberships within this tenant. Orphans and
 * cross-tenant users are NOT included (those have no place in a
 * tenant-anchored audit view).
 */
export interface TenantUserRow {
  id: string;
  email: string;
  name: string | null;
  memberships: Array<{ team_id: string; team_slug: string; team_name: string; role: string }>;
}

/**
 * Row returned by `listWithTenantTeamCount` -- the user row plus a
 * count of how many DISTINCT live teams in `tenantId` the user
 * currently belongs to. `team_count === 0` means "no memberships in
 * this tenant" (either an orphan globally OR a member of another
 * tenant only -- the UI doesn't distinguish, to avoid cross-tenant
 * existence leaks).
 */
export interface UserWithTenantTeamCount extends UserRow {
  team_count: number;
}

/**
 * A row in the tenant-scoped user-search result.
 *
 * `existing_role` is the user's role in the context team (the team
 * passed via `opts.contextTeamId`); `null` means "not in that team".
 *
 * `other_memberships` lists the user's other live memberships in the
 * SAME tenant (i.e. excluding the context team). The TeamsTab picker
 * renders these as a tag so the admin sees "already in: TM1 (admin)"
 * before adding a second membership in the current team. Memberships
 * in *other* tenants are intentionally NOT exposed (privacy).
 *
 * `orphan` is true iff the user has zero live memberships ANYWHERE.
 * Orphans are included in search results (they're a legitimate "I
 * lost this user, let me re-attach them" case) but tagged so the
 * admin knows the user has no current home.
 */
export interface TenantSearchUser {
  id: string;
  email: string;
  name: string | null;
  existing_role: string | null;
  other_memberships: Array<{ team_id: string; team_name: string; role: string }>;
  orphan: boolean;
}

export interface ListOptions {
  includeDeleted?: boolean;
}

type DrizzleSelectUser = {
  id: string;
  email: string;
  name: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

function toPublic(row: DrizzleSelectUser): UserRow {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? null,
    deleted_at: row.deletedAt ?? null,
    deleted_by: row.deletedBy ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export class UserRepository {
  private _d: DrizzleClient | null = null;

  constructor(private db: DatabaseAdapter) {}

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  async list(opts: ListOptions = {}): Promise<UserRow[]> {
    const d = this.d();
    const u = d.schema.users;
    const rows = opts.includeDeleted
      ? await (d.db as any).select().from(u).orderBy(asc(u.email))
      : await (d.db as any).select().from(u).where(isNull(u.deletedAt)).orderBy(asc(u.email));
    return (rows as DrizzleSelectUser[]).map(toPublic);
  }

  async get(id: string, opts: ListOptions = {}): Promise<UserRow | null> {
    const d = this.d();
    const u = d.schema.users;
    const where = opts.includeDeleted ? eq(u.id, id) : and(eq(u.id, id), isNull(u.deletedAt));
    const rows = await (d.db as any).select().from(u).where(where).limit(1);
    const row = (rows as DrizzleSelectUser[])[0];
    return row ? toPublic(row) : null;
  }

  async getByEmail(email: string, opts: ListOptions = {}): Promise<UserRow | null> {
    const d = this.d();
    const u = d.schema.users;
    const where = opts.includeDeleted ? eq(u.email, email) : and(eq(u.email, email), isNull(u.deletedAt));
    const rows = await (d.db as any).select().from(u).where(where).limit(1);
    const row = (rows as DrizzleSelectUser[])[0];
    return row ? toPublic(row) : null;
  }

  async create(u: { email: string; name?: string | null }): Promise<UserRow> {
    const id = `u-${randomBytes(6).toString("hex")}`;
    const ts = now();
    const d = this.d();
    await (d.db as any).insert(d.schema.users).values({
      id,
      email: u.email,
      name: u.name ?? null,
      createdAt: ts,
      updatedAt: ts,
    });
    return (await this.get(id))!;
  }

  async upsertByEmail(u: { email: string; name?: string | null }): Promise<UserRow> {
    const existing = await this.getByEmail(u.email);
    if (existing) {
      if (u.name !== undefined && u.name !== existing.name) {
        const d = this.d();
        await (d.db as any)
          .update(d.schema.users)
          .set({ name: u.name ?? null, updatedAt: now() })
          .where(eq(d.schema.users.id, existing.id));
        return (await this.get(existing.id))!;
      }
      return existing;
    }
    return this.create(u);
  }

  async softDelete(id: string, userId: string | null = null): Promise<boolean> {
    const d = this.d();
    const u = d.schema.users;
    const rows = await (d.db as any).select({ deletedAt: u.deletedAt }).from(u).where(eq(u.id, id)).limit(1);
    const existing = (rows as Array<{ deletedAt: string | null }>)[0];
    if (!existing) return false;
    if (existing.deletedAt) return true;
    const ts = now();
    const res = await (d.db as any)
      .update(u)
      .set({ deletedAt: ts, deletedBy: userId, updatedAt: ts })
      .where(and(eq(u.id, id), isNull(u.deletedAt)));
    return extractChanges(res) > 0;
  }

  async restore(id: string): Promise<boolean> {
    const d = this.d();
    const u = d.schema.users;
    const res = await (d.db as any)
      .update(u)
      .set({ deletedAt: null, deletedBy: null, updatedAt: now() })
      .where(eq(u.id, id));
    return extractChanges(res) > 0;
  }

  /**
   * Full user list annotated with a tenant-scoped team count per row.
   * The count is the number of DISTINCT live teams in `tenantId` the
   * user currently belongs to (live membership + live team). Used by
   * the UsersTab `Memberships` column so admins can spot orphans at
   * a glance without opening the drawer.
   *
   * Two queries: one for users (sorted by email), one GROUP BY for
   * counts. Merged in JS. Avoids drizzle's subquery JOIN gymnastics
   * and matches the two-query style used by `searchByTenant`.
   */
  async listWithTenantTeamCount(tenantId: string): Promise<UserWithTenantTeamCount[]> {
    const d = this.d();
    const u = d.schema.users;
    const m = d.schema.memberships;
    const t = d.schema.teams;
    const userRows = (await (d.db as any)
      .select()
      .from(u)
      .where(isNull(u.deletedAt))
      .orderBy(asc(u.email))) as DrizzleSelectUser[];
    if (userRows.length === 0) return [];
    const userIds = userRows.map((r) => r.id);
    // COUNT(DISTINCT team_id) per user. SQLite's count(DISTINCT) is
    // expressed via sql template since drizzle's count() helper doesn't
    // accept the DISTINCT modifier as of the version pinned here.
    const counts = (await (d.db as any)
      .select({ userId: m.userId, count: sql<number>`COUNT(DISTINCT ${m.teamId})` })
      .from(m)
      .innerJoin(t, eq(t.id, m.teamId))
      .where(and(inArray(m.userId, userIds), isNull(m.deletedAt), isNull(t.deletedAt), eq(t.tenantId, tenantId)))
      .groupBy(m.userId)) as Array<{ userId: string; count: number }>;
    const countByUser = new Map<string, number>();
    for (const c of counts) countByUser.set(c.userId, Number(c.count));
    return userRows.map((row) => ({ ...toPublic(row), team_count: countByUser.get(row.id) ?? 0 }));
  }

  /**
   * Tenant-anchored user roll-up. Returns distinct live users that have
   * ≥1 live membership in any live team of `tenantId`, each carrying
   * their (team, role) memberships within this tenant. Sorted by email.
   *
   * Used by the TenantsTab "Users in this tenant" section -- read-only
   * directory; mutation surface stays in TeamsTab + UsersTab.
   */
  async listTenantUsers(tenantId: string): Promise<TenantUserRow[]> {
    const d = this.d();
    const u = d.schema.users;
    const m = d.schema.memberships;
    const t = d.schema.teams;
    const rows = (await (d.db as any)
      .select({
        id: u.id,
        email: u.email,
        name: u.name,
        teamId: t.id,
        teamSlug: t.slug,
        teamName: t.name,
        role: m.role,
      })
      .from(u)
      .innerJoin(m, eq(m.userId, u.id))
      .innerJoin(t, eq(t.id, m.teamId))
      .where(and(isNull(u.deletedAt), isNull(m.deletedAt), isNull(t.deletedAt), eq(t.tenantId, tenantId)))
      .orderBy(asc(u.email), asc(t.name))) as Array<{
      id: string;
      email: string;
      name: string | null;
      teamId: string;
      teamSlug: string;
      teamName: string;
      role: string;
    }>;
    const byUser = new Map<string, TenantUserRow>();
    for (const r of rows) {
      let row = byUser.get(r.id);
      if (!row) {
        row = { id: r.id, email: r.email, name: r.name ?? null, memberships: [] };
        byUser.set(r.id, row);
      }
      row.memberships.push({ team_id: r.teamId, team_slug: r.teamSlug, team_name: r.teamName, role: r.role });
    }
    return Array.from(byUser.values());
  }

  /**
   * Tenant-scoped autocomplete search.
   *
   * Returns live users matching `q` (LIKE `%q%` on email or name; SQLite
   * LIKE is ASCII case-insensitive) who EITHER have at least one live
   * membership in this tenant, OR are orphans (zero live memberships
   * anywhere). Users that exist only in OTHER tenants are filtered out
   * -- a tenant admin must not see them.
   *
   * Each row is annotated with:
   *   - `existing_role`: the user's role in `opts.contextTeamId` (or null).
   *   - `other_memberships`: live memberships in this tenant EXCLUDING
   *     the context team; the picker renders these as an "also in: ..."
   *     tag so the admin knows what they're adding to.
   *   - `orphan`: true iff the user has zero live memberships anywhere;
   *     such users have no current home and re-attaching them is the
   *     intended workflow (also covers cascade-orphans).
   *
   * Limit is bounded server-side at 50; the typical UI cap is 20.
   * Callers (UserManager) enforce a 3-char minimum -- the repo does
   * not, so unit tests can exercise shorter queries directly.
   */
  async searchByTenant(
    tenantId: string,
    q: string,
    opts: { limit?: number; contextTeamId?: string } = {},
  ): Promise<TenantSearchUser[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    // Escape SQL LIKE wildcards in the user-supplied query so that
    // searching for "test%" matches a literal percent sign and not
    // "anything starting with test". Drizzle parameterises the binding
    // (so this is not SQLi), but `like()` does not know to escape
    // wildcards -- we have to do it ourselves and add an explicit
    // ESCAPE clause to the SQL.
    const escaped = q.replace(/[%_\\]/g, "\\$&");
    const pattern = `%${escaped}%`;
    const d = this.d();
    const u = d.schema.users;
    const m = d.schema.memberships;
    const t = d.schema.teams;

    // 1. All live users matching the query, capped at 3x the final
    // limit so we have slack to filter out users-in-other-tenants and
    // still hit `limit` results when possible.
    const candidates = await (d.db as any)
      .select({ id: u.id, email: u.email, name: u.name })
      .from(u)
      .where(
        and(
          isNull(u.deletedAt),
          or(sql`${u.email} LIKE ${pattern} ESCAPE '\\'`, sql`${u.name} LIKE ${pattern} ESCAPE '\\'`),
        ),
      )
      .orderBy(asc(u.email))
      .limit(limit * 3);
    const candidateRows = candidates as Array<{ id: string; email: string; name: string | null }>;
    if (candidateRows.length === 0) return [];
    const ids = candidateRows.map((r) => r.id);

    // 2. Their live memberships in THIS tenant (joined with team name
    // so we can build `other_memberships` without a second hop).
    const tenantMemRows = (await (d.db as any)
      .select({
        userId: m.userId,
        teamId: m.teamId,
        role: m.role,
        teamName: t.name,
      })
      .from(m)
      .innerJoin(t, eq(t.id, m.teamId))
      .where(
        and(inArray(m.userId, ids), isNull(m.deletedAt), isNull(t.deletedAt), eq(t.tenantId, tenantId)),
      )) as Array<{ userId: string; teamId: string; role: string; teamName: string }>;
    const tenantMemsByUser = new Map<string, Array<{ teamId: string; teamName: string; role: string }>>();
    for (const row of tenantMemRows) {
      let arr = tenantMemsByUser.get(row.userId);
      if (!arr) {
        arr = [];
        tenantMemsByUser.set(row.userId, arr);
      }
      arr.push({ teamId: row.teamId, teamName: row.teamName, role: row.role });
    }

    // 3. Which of these users have ANY live membership at all? We only
    // need the existence, not the rows. A user not in this map AND not
    // in tenantMemsByUser is an orphan.
    const anyMemRows = (await (d.db as any)
      .select({ userId: m.userId })
      .from(m)
      .where(and(inArray(m.userId, ids), isNull(m.deletedAt)))) as Array<{ userId: string }>;
    const hasAnyMembership = new Set<string>();
    for (const row of anyMemRows) hasAnyMembership.add(row.userId);

    // 4. Assemble. Drop users that live only in other tenants (privacy).
    const out: TenantSearchUser[] = [];
    for (const u0 of candidateRows) {
      const tenantMems = tenantMemsByUser.get(u0.id) ?? [];
      const orphan = !hasAnyMembership.has(u0.id);
      const inThisTenant = tenantMems.length > 0;
      if (!inThisTenant && !orphan) continue; // lives only elsewhere -- hide
      let existingRole: string | null = null;
      const otherMemberships: Array<{ team_id: string; team_name: string; role: string }> = [];
      for (const tm of tenantMems) {
        if (opts.contextTeamId && tm.teamId === opts.contextTeamId) {
          existingRole = tm.role;
        } else {
          otherMemberships.push({ team_id: tm.teamId, team_name: tm.teamName, role: tm.role });
        }
      }
      out.push({
        id: u0.id,
        email: u0.email,
        name: u0.name ?? null,
        existing_role: existingRole,
        other_memberships: otherMemberships,
        orphan,
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}
