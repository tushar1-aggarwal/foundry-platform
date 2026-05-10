/**
 * AuthSessionManager tests.
 *
 * Validates that a cookie value resolves to a wire TenantContext only when
 * every link in the chain is live: session row + user + membership + team
 * + tenant. Each missing link returns null. Mirrors how a request would
 * arrive through `materializeContext`'s cookie path.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database/index.js";
import { MigrationRunner } from "../../migrations/runner.js";
import { TenantManager } from "../tenants.js";
import { TeamManager } from "../teams.js";
import { UserManager } from "../users.js";
import { AuthSessionManager } from "../sessions.js";
import { SessionsAuthRepository } from "../../repositories/sessions-auth.js";

interface Setup {
  db: DatabaseAdapter;
  tenants: TenantManager;
  teams: TeamManager;
  users: UserManager;
  authSessions: AuthSessionManager;
  sessionsRepo: SessionsAuthRepository;
}

interface SetupOpts {
  /** Default 300s -- skip touch on `last_seen_at` younger than this. Pass 0 to touch always. */
  refreshThresholdSec?: number;
  /** Default 3600s -- TTL window passed to touchExpiry. */
  ttlSec?: number;
}

async function setup(opts: SetupOpts = {}): Promise<Setup> {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  await new MigrationRunner(db, "sqlite").apply();
  return {
    db,
    tenants: new TenantManager(db),
    teams: new TeamManager(db),
    users: new UserManager(db),
    authSessions: new AuthSessionManager(db, {
      ttlSec: opts.ttlSec ?? 3600,
      refreshThresholdSec: opts.refreshThresholdSec ?? 300,
    }),
    sessionsRepo: new SessionsAuthRepository(db),
  };
}

/** Force a sessions_auth row's last_seen_at into the past (in seconds). */
async function backdateLastSeen(db: DatabaseAdapter, id: string, secondsAgo: number): Promise<void> {
  const past = new Date(Date.now() - secondsAgo * 1000).toISOString();
  await db.exec(`UPDATE sessions_auth SET last_seen_at = '${past}' WHERE id = '${id}'`);
}

/** Force a sessions_auth row's expires_at into the past. */
async function expireRow(db: DatabaseAdapter, id: string): Promise<void> {
  const past = new Date(Date.now() - 60_000).toISOString();
  await db.exec(`UPDATE sessions_auth SET expires_at = '${past}' WHERE id = '${id}'`);
}

describe("AuthSessionManager.validate", () => {
  it("returns null for empty cookie value", async () => {
    const s = await setup();
    expect(await s.authSessions.validate("")).toBeNull();
    await s.db.close();
  });

  it("returns null for an unknown session id", async () => {
    const s = await setup();
    expect(await s.authSessions.validate("s-doesnotexist")).toBeNull();
    await s.db.close();
  });

  it("returns null when the session is expired", async () => {
    const s = await setup();
    const tenant = await s.tenants.create({ slug: "ocl", name: "OCL" });
    const team = await s.teams.create({ tenant_id: tenant.id, slug: "agentic", name: "Agentic" });
    const user = await s.users.create({ email: "alice@paytm.com" });
    await s.teams.addMember(team.id, user.id);

    const session = await s.sessionsRepo.create({ userId: user.id, ttlSec: 3600 });
    await expireRow(s.db, session.row.id);

    expect(await s.authSessions.validate(session.cookieValue)).toBeNull();
    await s.db.close();
  });

  it("returns null when the underlying user has been soft-deleted", async () => {
    const s = await setup();
    const tenant = await s.tenants.create({ slug: "ocl", name: "OCL" });
    const team = await s.teams.create({ tenant_id: tenant.id, slug: "agentic", name: "Agentic" });
    const user = await s.users.create({ email: "alice@paytm.com" });
    await s.teams.addMember(team.id, user.id);
    const session = await s.sessionsRepo.create({ userId: user.id, ttlSec: 3600 });

    await s.users.delete(user.id);
    expect(await s.authSessions.validate(session.cookieValue)).toBeNull();

    await s.db.close();
  });

  it("returns null when the user has no live membership", async () => {
    const s = await setup();
    const user = await s.users.create({ email: "alice@paytm.com" });
    // No team, no membership.

    const session = await s.sessionsRepo.create({ userId: user.id, ttlSec: 3600 });
    expect(await s.authSessions.validate(session.cookieValue)).toBeNull();

    await s.db.close();
  });

  it("returns wire TenantContext on the happy path", async () => {
    const s = await setup();
    const tenant = await s.tenants.create({ slug: "ocl", name: "OCL" });
    const team = await s.teams.create({ tenant_id: tenant.id, slug: "agentic", name: "Agentic" });
    const user = await s.users.create({ email: "alice@paytm.com", name: "Alice" });
    await s.teams.addMember(team.id, user.id, "member");

    const session = await s.sessionsRepo.create({ userId: user.id, ttlSec: 3600 });
    const ctx = await s.authSessions.validate(session.cookieValue);

    expect(ctx).not.toBeNull();
    expect(ctx!.tenantId).toBe(tenant.id);
    expect(ctx!.userId).toBe(user.id);
    expect(ctx!.role).toBe("member");

    await s.db.close();
  });

  it("collapses membership role 'owner' to wire role 'admin'", async () => {
    const s = await setup();
    const tenant = await s.tenants.create({ slug: "ocl", name: "OCL" });
    const team = await s.teams.create({ tenant_id: tenant.id, slug: "agentic", name: "Agentic" });
    const user = await s.users.create({ email: "alice@paytm.com" });
    await s.teams.addMember(team.id, user.id, "owner");

    const session = await s.sessionsRepo.create({ userId: user.id, ttlSec: 3600 });
    const ctx = await s.authSessions.validate(session.cookieValue);

    expect(ctx?.role).toBe("admin");
    await s.db.close();
  });

  it("returns null when the membership team has been soft-deleted", async () => {
    const s = await setup();
    const tenant = await s.tenants.create({ slug: "ocl", name: "OCL" });
    const team = await s.teams.create({ tenant_id: tenant.id, slug: "agentic", name: "Agentic" });
    const user = await s.users.create({ email: "alice@paytm.com" });
    await s.teams.addMember(team.id, user.id);
    const session = await s.sessionsRepo.create({ userId: user.id, ttlSec: 3600 });

    await s.teams.delete(team.id);
    expect(await s.authSessions.validate(session.cookieValue)).toBeNull();

    await s.db.close();
  });

  it("exposes the underlying SessionsAuthRepository for callers that need touch / delete", async () => {
    const s = await setup();
    expect(s.authSessions.sessions).toBeInstanceOf(SessionsAuthRepository);
    await s.db.close();
  });
});

describe("AuthSessionManager.validate sliding expiry", () => {
  async function happyPathSetup(opts: SetupOpts = {}): Promise<Setup & { cookieValue: string; rowId: string }> {
    const s = await setup(opts);
    const tenant = await s.tenants.create({ slug: "ocl", name: "OCL" });
    const team = await s.teams.create({ tenant_id: tenant.id, slug: "agentic", name: "Agentic" });
    const user = await s.users.create({ email: "alice@paytm.com" });
    await s.teams.addMember(team.id, user.id, "member");
    const session = await s.sessionsRepo.create({ userId: user.id, ttlSec: 3600 });
    return { ...s, cookieValue: session.cookieValue, rowId: session.row.id };
  }

  it("touches expiry when last_seen_at is older than refreshThresholdSec", async () => {
    const s = await happyPathSetup({ refreshThresholdSec: 60, ttlSec: 7200 });
    await backdateLastSeen(s.db, s.rowId, 120);

    const before = await s.sessionsRepo.getById(s.rowId);
    expect(before).not.toBeNull();
    const beforeExpires = before!.expires_at;

    const ctx = await s.authSessions.validate(s.cookieValue);
    expect(ctx).not.toBeNull();

    const after = await s.sessionsRepo.getById(s.rowId);
    expect(after).not.toBeNull();
    // expires_at advanced (sliding window applied)
    expect(after!.expires_at > beforeExpires).toBe(true);
    // last_seen_at advanced (was 120s ago, now within ~1s of "now")
    const lastSeenAge = Date.now() - Date.parse(after!.last_seen_at);
    expect(lastSeenAge).toBeLessThan(2000);

    await s.db.close();
  });

  it("does NOT touch expiry when last_seen_at is within the threshold (hot session)", async () => {
    const s = await happyPathSetup({ refreshThresholdSec: 300, ttlSec: 7200 });

    const before = await s.sessionsRepo.getById(s.rowId);
    expect(before).not.toBeNull();
    const beforeExpires = before!.expires_at;
    const beforeLastSeen = before!.last_seen_at;

    const ctx = await s.authSessions.validate(s.cookieValue);
    expect(ctx).not.toBeNull();

    const after = await s.sessionsRepo.getById(s.rowId);
    expect(after!.expires_at).toBe(beforeExpires);
    expect(after!.last_seen_at).toBe(beforeLastSeen);

    await s.db.close();
  });

  it("returns ctx successfully even when touchExpiry throws (best-effort refresh)", async () => {
    const s = await happyPathSetup({ refreshThresholdSec: 60, ttlSec: 7200 });
    await backdateLastSeen(s.db, s.rowId, 120);

    // Make touchExpiry throw on the next call. The validation must still
    // return a valid context -- a refresh blip cannot log the user out.
    const orig = s.sessionsRepo.touchExpiry.bind(s.sessionsRepo);
    (s.authSessions.sessions as any).touchExpiry = async () => {
      throw new Error("simulated DB outage");
    };

    const ctx = await s.authSessions.validate(s.cookieValue);
    expect(ctx).not.toBeNull();
    expect(ctx!.role).toBe("member");

    // Restore so the after-state read works (and to be a good citizen).
    (s.authSessions.sessions as any).touchExpiry = orig;
    await s.db.close();
  });

  it("returns ctx successfully when touchExpiry returns null (race: row deleted between getActive and touch)", async () => {
    const s = await happyPathSetup({ refreshThresholdSec: 60, ttlSec: 7200 });
    await backdateLastSeen(s.db, s.rowId, 120);

    (s.authSessions.sessions as any).touchExpiry = async () => null;

    const ctx = await s.authSessions.validate(s.cookieValue);
    expect(ctx).not.toBeNull();
    expect(ctx!.role).toBe("member");

    await s.db.close();
  });
});
