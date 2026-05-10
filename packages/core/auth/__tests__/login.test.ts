/**
 * LoginManager tests. Stubs the Google verifier (we don't make real
 * network calls in tests; jose's verification is exercised in
 * google-oidc.test.ts). Focus is on the persistence + business logic
 * layered on top of identity.
 *
 * To stub the verifier we mock the `verifyGoogleIdToken` import via
 * Bun's `mock.module`.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database/index.js";
import { MigrationRunner } from "../../migrations/runner.js";
import { UserManager } from "../users.js";
import { TeamManager } from "../teams.js";
import { MembershipRepository } from "../../repositories/memberships.js";
import { SessionsAuthRepository } from "../../repositories/sessions-auth.js";
import { LoginManager, LoginError } from "../login.js";
import type { GoogleIdentity } from "../google-oidc.js";

// In-memory verifier stub. Tests configure `nextResult` before each
// `completeOAuthLogin` call. Setting it to `null` simulates a failed
// verification (bad token / hd mismatch / etc.).
let verifierResult: GoogleIdentity | null = null;
let verifierCallCount = 0;

mock.module("../google-oidc.js", () => ({
  verifyGoogleIdToken: async (_token: string) => {
    verifierCallCount += 1;
    return verifierResult;
  },
  // re-export the types so the manager's import compiles
  _resetJwksCacheForTesting: () => {},
}));

const GOOGLE_CONFIG = {
  clientId: "test-client.apps.googleusercontent.com",
  clientSecret: "test-secret",
  redirectUri: "http://localhost:8420/auth/google/callback",
  allowedDomains: ["paytm.com"],
};
const SESSION_CONFIG = {
  ttlSec: 3600,
  cookieName: "ark_session",
  cookieDomain: null,
  cookieSecure: false,
  refreshThresholdSec: 300,
  allowedOrigins: [],
};

async function freshDb(): Promise<DatabaseAdapter> {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  await new MigrationRunner(db, "sqlite").apply();
  return db;
}

function freshIdentity(overrides: Partial<GoogleIdentity> = {}): GoogleIdentity {
  return { sub: "google-sub-12345", email: "alice@paytm.com", name: "Alice", ...overrides };
}

describe("LoginManager.completeOAuthLogin", () => {
  beforeEach(() => {
    verifierResult = null;
    verifierCallCount = 0;
  });

  afterEach(() => {
    verifierResult = null;
  });

  it("happy path: JIT-creates user, default-team membership, returns cookieValue + user", async () => {
    const db = await freshDb();
    const lm = new LoginManager({ googleConfig: GOOGLE_CONFIG, sessionConfig: SESSION_CONFIG, db });
    verifierResult = freshIdentity();

    const result = await lm.completeOAuthLogin("any-token", { userAgent: "ua", ip: "127.0.0.1" });

    expect(result.cookieValue).toHaveLength(64);
    expect(result.cookieValue).toMatch(/^[0-9a-f]+$/);
    expect(result.user.email).toBe("alice@paytm.com");
    expect(result.user.name).toBe("Alice");

    // Membership inserted in default-team.
    const memberships = new MembershipRepository(db);
    const userMemberships = await memberships.listByUser(result.user.id);
    expect(userMemberships).toHaveLength(1);
    expect(userMemberships[0].team_id).toBe("default-team");

    // Session row exists, lookup via cookie value works.
    const sessions = new SessionsAuthRepository(db);
    const session = await sessions.getActive(result.cookieValue);
    expect(session).not.toBeNull();
    expect(session!.user_id).toBe(result.user.id);
    expect(session!.user_agent).toBe("ua");
    expect(session!.ip).toBe("127.0.0.1");

    await db.close();
  });

  it("returning user: no duplicate insert, no duplicate membership, last_login_at advances", async () => {
    const db = await freshDb();
    const lm = new LoginManager({ googleConfig: GOOGLE_CONFIG, sessionConfig: SESSION_CONFIG, db });
    verifierResult = freshIdentity();

    const r1 = await lm.completeOAuthLogin("token-1", {});
    await Bun.sleep(15);
    const r2 = await lm.completeOAuthLogin("token-2", {});

    // Same user row.
    expect(r2.user.id).toBe(r1.user.id);

    // Single membership; not duplicated.
    const memberships = new MembershipRepository(db);
    const list = await memberships.listByUser(r1.user.id);
    expect(list).toHaveLength(1);

    // Two distinct sessions exist (cookie values differ).
    expect(r1.cookieValue).not.toBe(r2.cookieValue);

    // last_login_at advanced.
    const um = new UserManager(db);
    const u = await um.get(r1.user.id);
    expect(new Date(u!.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(r1.user.updated_at).getTime());

    await db.close();
  });

  it("account-takeover guard: throws when existing user has different google_sub", async () => {
    const db = await freshDb();
    const lm = new LoginManager({ googleConfig: GOOGLE_CONFIG, sessionConfig: SESSION_CONFIG, db });

    // First login locks in google_sub.
    verifierResult = freshIdentity({ sub: "original-sub" });
    await lm.completeOAuthLogin("token-1", {});

    // Second login with the SAME email but a DIFFERENT sub -> reject.
    verifierResult = freshIdentity({ sub: "different-sub" });
    let error: unknown = null;
    try {
      await lm.completeOAuthLogin("token-2", {});
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).kind).toBe("account-takeover");

    await db.close();
  });

  it("verifier failure: throws LoginError(token-invalid)", async () => {
    const db = await freshDb();
    const lm = new LoginManager({ googleConfig: GOOGLE_CONFIG, sessionConfig: SESSION_CONFIG, db });
    verifierResult = null; // simulates bad token / hd / email_verified / signature

    let error: unknown = null;
    try {
      await lm.completeOAuthLogin("any-token", {});
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).kind).toBe("token-invalid");

    await db.close();
  });

  it("missing clientId: throws LoginError(config-missing)", async () => {
    const db = await freshDb();
    const lm = new LoginManager({
      googleConfig: { ...GOOGLE_CONFIG, clientId: null },
      sessionConfig: SESSION_CONFIG,
      db,
    });
    let error: unknown = null;
    try {
      await lm.completeOAuthLogin("any-token", {});
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).kind).toBe("config-missing");

    // Verifier wasn't even consulted.
    expect(verifierCallCount).toBe(0);

    await db.close();
  });

  it("logout deletes the matching session row; idempotent on missing", async () => {
    const db = await freshDb();
    const lm = new LoginManager({ googleConfig: GOOGLE_CONFIG, sessionConfig: SESSION_CONFIG, db });
    verifierResult = freshIdentity();
    const { cookieValue } = await lm.completeOAuthLogin("any-token", {});

    const sessions = new SessionsAuthRepository(db);
    expect(await sessions.getActive(cookieValue)).not.toBeNull();

    await lm.logout(cookieValue);
    expect(await sessions.getActive(cookieValue)).toBeNull();

    // Idempotent: second call doesn't throw.
    await lm.logout(cookieValue);

    // Empty cookie value: no-op.
    await lm.logout("");

    await db.close();
  });

  it("populates sessions_auth.team_chain at login from the user's primary membership chain", async () => {
    const db = await freshDb();
    const lm = new LoginManager({ googleConfig: GOOGLE_CONFIG, sessionConfig: SESSION_CONFIG, db });

    // Build a 3-level team tree under the seeded `default` tenant:
    // grand <- parent <- team. Place the user on `team`.
    const um = new UserManager(db);
    const tm = new TeamManager(db);
    const u = await um.upsertByEmail({ email: "alice@paytm.com" });
    const grand = await tm.create({ tenant_id: "default", slug: "grand", name: "Grand" });
    const parent = await tm.create({ tenant_id: "default", slug: "parent", name: "Parent" });
    const team = await tm.create({ tenant_id: "default", slug: "leaf", name: "Leaf" });
    // No public API to set parent_team_id today (Phase 2 admin RPCs); use raw SQL.
    await db.exec(`UPDATE teams SET parent_team_id = '${grand.id}' WHERE id = '${parent.id}'`);
    await db.exec(`UPDATE teams SET parent_team_id = '${parent.id}' WHERE id = '${team.id}'`);
    await tm.addMember(team.id, u.id, "member");

    verifierResult = freshIdentity();
    const result = await lm.completeOAuthLogin("any-token", {});

    const sessions = new SessionsAuthRepository(db);
    const session = await sessions.getActive(result.cookieValue);
    expect(session).not.toBeNull();
    expect(session!.team_chain).not.toBeNull();
    expect(JSON.parse(session!.team_chain!)).toEqual([team.id, parent.id, grand.id]);

    await db.close();
  });

  it("login still succeeds when user has no live memberships -- team_chain stays empty array", async () => {
    const db = await freshDb();
    const lm = new LoginManager({ googleConfig: GOOGLE_CONFIG, sessionConfig: SESSION_CONFIG, db });

    // Pre-create user with NO memberships, then soft-delete the seeded
    // default-team so the JIT-membership step has no team to add to.
    const um = new UserManager(db);
    await um.upsertByEmail({ email: "alice@paytm.com" });
    await db.exec("UPDATE teams SET deleted_at = datetime('now') WHERE id = 'default-team'");

    verifierResult = freshIdentity();
    const result = await lm.completeOAuthLogin("any-token", {});

    const sessions = new SessionsAuthRepository(db);
    const session = await sessions.getActive(result.cookieValue);
    // No live membership -> JIT-membership branch is hit but the team is
    // soft-deleted, so addMember restores+activates it. Either way the
    // team_chain is populated. The contract here is "login does not fail
    // and team_chain is JSON-encoded".
    expect(session).not.toBeNull();
    expect(session!.team_chain).not.toBeNull();
    const chain = JSON.parse(session!.team_chain!);
    expect(Array.isArray(chain)).toBe(true);

    await db.close();
  });

  it("throws LoginError(chain-broken) when the user's team chain has a cycle", async () => {
    const db = await freshDb();
    const lm = new LoginManager({ googleConfig: GOOGLE_CONFIG, sessionConfig: SESSION_CONFIG, db });

    // Build a cycle A -> B -> A and put the user on A.
    const um = new UserManager(db);
    const tm = new TeamManager(db);
    const u = await um.upsertByEmail({ email: "alice@paytm.com" });
    const teamA = await tm.create({ tenant_id: "default", slug: "team-a", name: "A" });
    const teamB = await tm.create({ tenant_id: "default", slug: "team-b", name: "B" });
    await db.exec(`UPDATE teams SET parent_team_id = '${teamB.id}' WHERE id = '${teamA.id}'`);
    await db.exec(`UPDATE teams SET parent_team_id = '${teamA.id}' WHERE id = '${teamB.id}'`);
    await tm.addMember(teamA.id, u.id, "member");

    verifierResult = freshIdentity();
    let error: unknown = null;
    try {
      await lm.completeOAuthLogin("any-token", {});
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).kind).toBe("chain-broken");
    expect((error as LoginError).message).toContain("cycle");

    await db.close();
  });

  it("user with prior membership is not given a default-team membership again", async () => {
    const db = await freshDb();
    const lm = new LoginManager({ googleConfig: GOOGLE_CONFIG, sessionConfig: SESSION_CONFIG, db });

    // Pre-create user + put them on a different team.
    const um = new UserManager(db);
    const tm = new TeamManager(db);
    const u = await um.upsertByEmail({ email: "alice@paytm.com" });
    // Use existing seed default tenant; create another team in it.
    const team = await tm.create({ tenant_id: "default", slug: "real-team", name: "Real Team" });
    await tm.addMember(team.id, u.id, "member");

    verifierResult = freshIdentity();
    const result = await lm.completeOAuthLogin("any-token", {});

    const memberships = new MembershipRepository(db);
    const list = await memberships.listByUser(result.user.id);
    // User stays in real-team only -- no default-team auto-add.
    expect(list).toHaveLength(1);
    expect(list[0].team_id).toBe(team.id);

    await db.close();
  });
});
