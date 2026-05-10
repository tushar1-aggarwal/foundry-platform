/**
 * SessionsAuthRepository tests.
 *
 * Covers:
 *   - create() inserts a row, returns {cookieValue, row}; row.id is
 *     SHA-256(cookieValue) (decision #8 in pr3a-plan)
 *   - create() self-heals: deletes the same user's prior expired rows
 *   - create() does NOT delete other users' expired rows
 *   - cookieValue has 256 bits of entropy and is not the row id
 *   - hashCookieValue is deterministic; row.id is NOT recoverable into cookieValue
 *   - getActive(cookieValue) returns null for missing AND expired rows
 *   - get(cookieValue) (includes expired) and getById(id) parallel paths
 *   - touchExpiry(cookieValue) bumps expires_at + last_seen_at; rejects expired
 *   - deleteByCookieValue / deleteById / deleteByUserId / deleteExpired
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database/index.js";
import { MigrationRunner } from "../../migrations/runner.js";
import { UserManager } from "../../auth/users.js";
import { SessionsAuthRepository, hashCookieValue } from "../sessions-auth.js";

async function freshDb(): Promise<DatabaseAdapter> {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  await new MigrationRunner(db, "sqlite").apply();
  return db;
}

async function makeUser(db: DatabaseAdapter, email: string): Promise<string> {
  const um = new UserManager(db);
  const u = await um.upsertByEmail({ email });
  return u.id;
}

/** Force a row's expires_at into the past (UTC) for expiry tests. */
async function expireRow(db: DatabaseAdapter, id: string): Promise<void> {
  const past = new Date(Date.now() - 60_000).toISOString();
  await db.exec(`UPDATE sessions_auth SET expires_at = '${past}' WHERE id = '${id}'`);
}

describe("SessionsAuthRepository", () => {
  it("create() returns {cookieValue, row}; row.id == SHA-256(cookieValue)", async () => {
    const db = await freshDb();
    const userId = await makeUser(db, "alice@example.com");
    const repo = new SessionsAuthRepository(db);

    const before = Date.now();
    const { cookieValue, row } = await repo.create({ userId, ttlSec: 3600 });
    const after = Date.now();

    // Cookie value is 256 bits of entropy = 64 hex chars
    expect(cookieValue).toHaveLength(64);
    expect(cookieValue).toMatch(/^[0-9a-f]+$/);

    // Row id is the hash of the cookie value (decision #8: never store plaintext)
    expect(row.id).toBe(hashCookieValue(cookieValue));
    expect(row.id).not.toBe(cookieValue);
    expect(row.id).toHaveLength(64); // SHA-256 hex
    expect(row.id).toMatch(/^[0-9a-f]+$/);

    expect(row.user_id).toBe(userId);
    expect(row.team_chain).toBeNull();
    expect(new Date(row.created_at).getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(new Date(row.last_seen_at).getTime()).toBeGreaterThanOrEqual(before - 1);

    const expiresMs = new Date(row.expires_at).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 3600 * 1000 - 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + 3600 * 1000 + 1000);

    await db.close();
  });

  it("hashCookieValue is deterministic and exposed for callers that already have the hash", () => {
    const a = hashCookieValue("abc");
    const b = hashCookieValue("abc");
    expect(a).toBe(b);
    // Sanity: matches SHA-256 of the input
    expect(a).toBe(createHash("sha256").update("abc").digest("hex"));
  });

  it("each create() call yields a distinct, unguessable cookieValue", async () => {
    const db = await freshDb();
    const userId = await makeUser(db, "alice@example.com");
    const repo = new SessionsAuthRepository(db);
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { cookieValue } = await repo.create({ userId, ttlSec: 3600 });
      seen.add(cookieValue);
    }
    expect(seen.size).toBe(50);
    await db.close();
  });

  it("create() persists team_chain as JSON when provided", async () => {
    const db = await freshDb();
    const userId = await makeUser(db, "alice@example.com");
    const repo = new SessionsAuthRepository(db);

    const { row } = await repo.create({
      userId,
      ttlSec: 3600,
      teamChain: ["t-leaf", "t-parent", "t-hod"],
      userAgent: "ua",
      ip: "127.0.0.1",
    });

    expect(row.team_chain).toBe(JSON.stringify(["t-leaf", "t-parent", "t-hod"]));
    expect(row.user_agent).toBe("ua");
    expect(row.ip).toBe("127.0.0.1");

    await db.close();
  });

  it("create() self-heals: deletes this user's prior expired rows in the same tx", async () => {
    const db = await freshDb();
    const userId = await makeUser(db, "alice@example.com");
    const repo = new SessionsAuthRepository(db);

    const stale = await repo.create({ userId, ttlSec: 3600 });
    await expireRow(db, stale.row.id);
    expect(await repo.getById(stale.row.id)).not.toBeNull();

    // Login again -- self-heal removes the stale row.
    const fresh = await repo.create({ userId, ttlSec: 3600 });
    expect(await repo.getById(stale.row.id)).toBeNull();
    expect(await repo.getById(fresh.row.id)).not.toBeNull();

    await db.close();
  });

  it("create() does NOT delete OTHER users' expired rows", async () => {
    const db = await freshDb();
    const aliceId = await makeUser(db, "alice@example.com");
    const bobId = await makeUser(db, "bob@example.com");
    const repo = new SessionsAuthRepository(db);

    const bobStale = await repo.create({ userId: bobId, ttlSec: 3600 });
    await expireRow(db, bobStale.row.id);

    await repo.create({ userId: aliceId, ttlSec: 3600 });
    expect(await repo.getById(bobStale.row.id)).not.toBeNull();

    await db.close();
  });

  it("getActive(cookieValue) hashes input and returns null for expired rows", async () => {
    const db = await freshDb();
    const userId = await makeUser(db, "alice@example.com");
    const repo = new SessionsAuthRepository(db);

    const { cookieValue, row } = await repo.create({ userId, ttlSec: 3600 });
    expect(await repo.getActive(cookieValue)).not.toBeNull();

    await expireRow(db, row.id);
    expect(await repo.getActive(cookieValue)).toBeNull();
    // get() (includes expired) still finds the row.
    expect(await repo.get(cookieValue)).not.toBeNull();

    await db.close();
  });

  it("getActive() returns null for empty cookie value (defensive guard)", async () => {
    const db = await freshDb();
    const repo = new SessionsAuthRepository(db);
    expect(await repo.getActive("")).toBeNull();
    await db.close();
  });

  it("touchExpiry(cookieValue) bumps last_seen_at and expires_at on a live row", async () => {
    const db = await freshDb();
    const userId = await makeUser(db, "alice@example.com");
    const repo = new SessionsAuthRepository(db);

    const { cookieValue, row } = await repo.create({ userId, ttlSec: 60 });
    await Bun.sleep(20);
    const touched = await repo.touchExpiry(cookieValue, 3600);

    expect(touched).not.toBeNull();
    expect(touched!.last_seen_at >= row.last_seen_at).toBe(true);
    expect(new Date(touched!.expires_at).getTime()).toBeGreaterThan(new Date(row.expires_at).getTime());

    await db.close();
  });

  it("touchExpiry() returns null for an already-expired row", async () => {
    const db = await freshDb();
    const userId = await makeUser(db, "alice@example.com");
    const repo = new SessionsAuthRepository(db);

    const { cookieValue, row } = await repo.create({ userId, ttlSec: 3600 });
    await expireRow(db, row.id);

    const result = await repo.touchExpiry(cookieValue, 3600);
    expect(result).toBeNull();

    await db.close();
  });

  it("touchExpiry() returns null for a missing cookieValue", async () => {
    const db = await freshDb();
    const repo = new SessionsAuthRepository(db);
    const result = await repo.touchExpiry("nonexistent-cookie", 3600);
    expect(result).toBeNull();
    await db.close();
  });

  it("deleteByCookieValue() removes the matching row; deleteByUserId() removes all of a user's", async () => {
    const db = await freshDb();
    const aliceId = await makeUser(db, "alice@example.com");
    const bobId = await makeUser(db, "bob@example.com");
    const repo = new SessionsAuthRepository(db);

    const a1 = await repo.create({ userId: aliceId, ttlSec: 3600 });
    const a2 = await repo.create({ userId: aliceId, ttlSec: 3600 });
    const b1 = await repo.create({ userId: bobId, ttlSec: 3600 });

    await repo.deleteByCookieValue(a1.cookieValue);
    expect(await repo.getById(a1.row.id)).toBeNull();
    expect(await repo.getById(a2.row.id)).not.toBeNull();
    expect(await repo.getById(b1.row.id)).not.toBeNull();

    await repo.deleteByUserId(aliceId);
    expect(await repo.getById(a2.row.id)).toBeNull();
    expect(await repo.getById(b1.row.id)).not.toBeNull();

    await db.close();
  });

  it("deleteByCookieValue() is idempotent on missing", async () => {
    const db = await freshDb();
    const repo = new SessionsAuthRepository(db);
    await repo.deleteByCookieValue("never-existed");
    // No throw is the assertion.
    await db.close();
  });

  it("deleteExpired() removes only expired rows, regardless of user", async () => {
    const db = await freshDb();
    const aliceId = await makeUser(db, "alice@example.com");
    const bobId = await makeUser(db, "bob@example.com");
    const repo = new SessionsAuthRepository(db);

    const aLive = await repo.create({ userId: aliceId, ttlSec: 3600 });
    const aDead = await repo.create({ userId: aliceId, ttlSec: 3600 });
    const bLive = await repo.create({ userId: bobId, ttlSec: 3600 });
    const bDead = await repo.create({ userId: bobId, ttlSec: 3600 });

    await expireRow(db, aDead.row.id);
    await expireRow(db, bDead.row.id);

    await repo.deleteExpired();

    expect(await repo.getById(aLive.row.id)).not.toBeNull();
    expect(await repo.getById(bLive.row.id)).not.toBeNull();
    expect(await repo.getById(aDead.row.id)).toBeNull();
    expect(await repo.getById(bDead.row.id)).toBeNull();

    await db.close();
  });

  it("deleteExpiredForUser() only touches one user's expired rows", async () => {
    const db = await freshDb();
    const aliceId = await makeUser(db, "alice@example.com");
    const bobId = await makeUser(db, "bob@example.com");
    const repo = new SessionsAuthRepository(db);

    const aDead = await repo.create({ userId: aliceId, ttlSec: 3600 });
    const bDead = await repo.create({ userId: bobId, ttlSec: 3600 });
    await expireRow(db, aDead.row.id);
    await expireRow(db, bDead.row.id);

    await repo.deleteExpiredForUser(aliceId);
    expect(await repo.getById(aDead.row.id)).toBeNull();
    expect(await repo.getById(bDead.row.id)).not.toBeNull();

    await db.close();
  });
});
