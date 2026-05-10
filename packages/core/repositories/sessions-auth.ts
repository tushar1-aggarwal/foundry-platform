/**
 * SessionsAuthRepository -- drizzle-backed adapter for the `sessions_auth`
 * table (migration 016).
 *
 * Stores server-side auth sessions for the cookie-based Google OIDC flow.
 *
 * SECURITY: the cookie value sent to the browser is a 256-bit random
 * token (the "raw cookie value"). The DB stores SHA-256(rawCookieValue)
 * in `sessions_auth.id`. Lookup hashes the inbound cookie value and
 * matches by id. This mirrors `ApiKeyManager.key_hash`: a DB-read leak
 * (SQL injection / backup compromise / replication-target breach) does
 * NOT yield active session credentials. The plaintext is only ever
 * present in browser memory + the request's Cookie header on the wire.
 *
 * Sliding expiry: callers bump `expires_at = now + ttlSec` via
 * `touchExpiry()`. Idle sessions hit the `expires_at < now` check at
 * the next access and are rejected.
 *
 * `team_chain` is a JSON array of team ids ordered from the user's
 * team upward to HoD. Computed at login and cached for the session
 * lifetime.
 *
 * Cleanup paths:
 *   - `deleteExpiredForUser(userId)` -- called inside the login
 *     transaction so returning users self-heal their own dead rows.
 *     No periodic sweep needed in Phase 1.
 *   - `deleteExpired()` -- optional periodic sweep for users who never
 *     come back at all.
 */

import { createHash, randomBytes } from "crypto";
import { and, eq, gte, lt } from "drizzle-orm";
import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { now } from "../util/time.js";

export interface SessionsAuthRow {
  /** SHA-256 hash of the cookie value. NOT the cookie value itself. */
  id: string;
  user_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  /** JSON-encoded array of team ids, team -> HoD. Null if not yet computed. */
  team_chain: string | null;
  user_agent: string | null;
  ip: string | null;
}

type DrizzleSelectSessionAuth = {
  id: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  teamChain: string | null;
  userAgent: string | null;
  ip: string | null;
};

function toPublic(row: DrizzleSelectSessionAuth): SessionsAuthRow {
  return {
    id: row.id,
    user_id: row.userId,
    created_at: row.createdAt,
    last_seen_at: row.lastSeenAt,
    expires_at: row.expiresAt,
    team_chain: row.teamChain ?? null,
    user_agent: row.userAgent ?? null,
    ip: row.ip ?? null,
  };
}

export interface CreateSessionAuthInput {
  userId: string;
  /** Sliding TTL in seconds. `expires_at` is set to `now + ttlSec`. */
  ttlSec: number;
  /** Team chain ids ordered team -> HoD. `null` to leave un-cached. */
  teamChain?: string[] | null;
  userAgent?: string | null;
  ip?: string | null;
}

export interface CreateSessionAuthResult {
  /**
   * Raw cookie value. The CALLER must put this in the Set-Cookie header.
   * 64 hex chars (256 bits of entropy). NOT stored in the DB; only the
   * hash of it (in `row.id`) is stored. The plaintext is irrecoverable
   * after this method returns.
   */
  cookieValue: string;
  /** Persisted row (with `id` = SHA-256 hash of `cookieValue`). */
  row: SessionsAuthRow;
}

/** Hash a cookie value the same way `create()` does. Exposed for callers
 *  that need the row id deterministically (e.g. admin / test tooling). */
export function hashCookieValue(cookieValue: string): string {
  return createHash("sha256").update(cookieValue).digest("hex");
}

export class SessionsAuthRepository {
  private _d: DrizzleClient | null = null;

  constructor(private db: DatabaseAdapter) {}

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  /**
   * Create a fresh session row for `userId`. Returns BOTH the row
   * (with hashed `id`) and the raw cookie value. The caller writes the
   * raw value into Set-Cookie; the plaintext is never recoverable from
   * the row.
   *
   * The same transaction also self-heals: deletes any of this user's
   * prior expired rows so orphans don't accumulate without a periodic
   * sweep.
   */
  async create(input: CreateSessionAuthInput): Promise<CreateSessionAuthResult> {
    // 32 bytes = 256 bits of entropy. Hex-encoded for URL/cookie safety.
    const cookieValue = randomBytes(32).toString("hex");
    const id = hashCookieValue(cookieValue);
    const ts = now();
    const expiresAt = isoOffset(ts, input.ttlSec);
    const teamChainJson = input.teamChain == null ? null : JSON.stringify(input.teamChain);

    const row = await this.db.transaction(async () => {
      const d = this.d();
      const t = d.schema.sessionsAuth;
      // Insert the new session.
      await (d.db as any).insert(t).values({
        id,
        userId: input.userId,
        createdAt: ts,
        lastSeenAt: ts,
        expiresAt,
        teamChain: teamChainJson,
        userAgent: input.userAgent ?? null,
        ip: input.ip ?? null,
      });
      // Self-heal: drop this user's previously expired rows.
      await (d.db as any).delete(t).where(and(eq(t.userId, input.userId), lt(t.expiresAt, ts)));
      const out = await this.getById(id);
      if (!out) throw new Error("sessions_auth row missing immediately after insert");
      return out;
    });

    return { cookieValue, row };
  }

  /**
   * Fetch by raw cookie value. Hashes input then looks up by id.
   * Returns null for missing OR expired rows; callers don't need to
   * filter.
   */
  async getActive(cookieValue: string): Promise<SessionsAuthRow | null> {
    if (!cookieValue) return null;
    const id = hashCookieValue(cookieValue);
    const d = this.d();
    const t = d.schema.sessionsAuth;
    const ts = now();
    // expiresAt is ISO-8601 text -- lexicographic >= is correct for the format.
    const rows = await (d.db as any)
      .select()
      .from(t)
      .where(and(eq(t.id, id), gte(t.expiresAt, ts)))
      .limit(1);
    const row = (rows as DrizzleSelectSessionAuth[])[0];
    return row ? toPublic(row) : null;
  }

  /** Fetch by raw cookie value INCLUDING expired rows -- for cleanup / debugging. */
  async get(cookieValue: string): Promise<SessionsAuthRow | null> {
    if (!cookieValue) return null;
    return this.getById(hashCookieValue(cookieValue));
  }

  /**
   * Fetch by row id (hash) directly. Admin / test tooling that already
   * has the hash uses this; ordinary auth flow uses `getActive` /
   * `get` with the raw cookie value.
   */
  async getById(id: string): Promise<SessionsAuthRow | null> {
    const d = this.d();
    const t = d.schema.sessionsAuth;
    const rows = await (d.db as any).select().from(t).where(eq(t.id, id)).limit(1);
    const row = (rows as DrizzleSelectSessionAuth[])[0];
    return row ? toPublic(row) : null;
  }

  /**
   * Sliding-window touch. Hashes the cookie value; if the row exists
   * AND isn't expired, updates `last_seen_at = now` and `expires_at =
   * now + ttlSec`, then returns the updated row. Returns null if the
   * row is missing or was already expired (caller should treat as 401).
   */
  async touchExpiry(cookieValue: string, ttlSec: number): Promise<SessionsAuthRow | null> {
    if (!cookieValue) return null;
    const id = hashCookieValue(cookieValue);
    const d = this.d();
    const t = d.schema.sessionsAuth;
    const ts = now();
    const expiresAt = isoOffset(ts, ttlSec);
    // Conditional update: only touch live rows. ISO-8601 lexicographic compare.
    await (d.db as any)
      .update(t)
      .set({ lastSeenAt: ts, expiresAt })
      .where(and(eq(t.id, id), gte(t.expiresAt, ts)));
    // Drizzle drivers vary on how they expose changes-count, so refetch
    // and confirm the update landed by checking the new expires_at.
    const row = await this.getById(id);
    if (!row || row.expires_at !== expiresAt) return null;
    return row;
  }

  /** Delete a single session by raw cookie value (logout). Idempotent. */
  async deleteByCookieValue(cookieValue: string): Promise<void> {
    if (!cookieValue) return;
    const id = hashCookieValue(cookieValue);
    return this.deleteById(id);
  }

  /** Delete a single session by row id (admin / cleanup paths). Idempotent. */
  async deleteById(id: string): Promise<void> {
    const d = this.d();
    const t = d.schema.sessionsAuth;
    await (d.db as any).delete(t).where(eq(t.id, id));
  }

  /** Delete all sessions for a user (force-logout, password reset, etc.). */
  async deleteByUserId(userId: string): Promise<void> {
    const d = this.d();
    const t = d.schema.sessionsAuth;
    await (d.db as any).delete(t).where(eq(t.userId, userId));
  }

  /** Delete a user's expired rows. Used at login by `create()`; exposed for tests. */
  async deleteExpiredForUser(userId: string): Promise<void> {
    const d = this.d();
    const t = d.schema.sessionsAuth;
    const ts = now();
    await (d.db as any).delete(t).where(and(eq(t.userId, userId), lt(t.expiresAt, ts)));
  }

  /**
   * Periodic sweep: delete every expired row across all users. Optional
   * in Phase 1; the per-user self-heal at login covers most cases.
   */
  async deleteExpired(): Promise<void> {
    const d = this.d();
    const t = d.schema.sessionsAuth;
    const ts = now();
    await (d.db as any).delete(t).where(lt(t.expiresAt, ts));
  }
}

/** Compute `now()` + `seconds` in ISO-8601 format consistent with `util/time.now`. */
function isoOffset(nowIso: string, seconds: number): string {
  return new Date(new Date(nowIso).getTime() + seconds * 1000).toISOString();
}
