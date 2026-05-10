/**
 * LoginManager -- Phase 1 Google OIDC login lifecycle.
 *
 * The bridge between the Google OIDC verifier (`google-oidc.ts`) and the
 * persistent session/user state. Two public methods:
 *
 *   - `completeOAuthLogin(idToken, requestMeta)` -- verify a Google ID
 *     token, JIT-create the user, ensure default-team membership, create
 *     a sessions_auth row, return the RAW cookie value (caller writes
 *     into Set-Cookie). All steps run in one DB transaction; any
 *     failure rolls back.
 *
 *   - `logout(cookieValue)` -- hash + delete the matching session row.
 *     Idempotent.
 *
 * Error model: throws a `LoginError` on any verification failure. The
 * caller (HTTP handler) maps every kind to a generic 401 response. We
 * deliberately do NOT distinguish failure modes to the client -- a
 * helpful error message ("invalid hd" vs "expired token") would be a
 * fingerprinting oracle.
 *
 * Account-takeover guard: if a user row already has `google_sub` set
 * to a value that doesn't match the token's `sub`, we throw. This
 * protects against a Workspace admin reusing an email address for a
 * different person -- without the guard, the new person would inherit
 * the old person's tenant / membership / data.
 */

import { eq } from "drizzle-orm";
import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import type { GoogleAuthConfig, AuthSessionConfig } from "../config/types.js";
import { verifyGoogleIdToken } from "./google-oidc.js";
import { UserManager, type User } from "./users.js";
import { TeamManager } from "./teams.js";
import { MembershipRepository } from "../repositories/memberships.js";
import { SessionsAuthRepository } from "../repositories/sessions-auth.js";
import { TeamRepository } from "../repositories/teams.js";
import { getAncestorChain, TeamChainError } from "../scoping/team-chain.js";
import { now } from "../util/time.js";
import { logDebug, logError } from "../observability/structured-log.js";

/** Default team newly-onboarded users land in (seeded by migration 016). */
const DEFAULT_TEAM_ID = "default-team";

export type LoginErrorKind =
  | "token-invalid"
  | "account-takeover"
  | "transaction-failed"
  | "config-missing"
  /**
   * Decision #5: the user's team chain has a cycle or exceeds the depth
   * cap. Fail closed -- do not let the user log in with a wrong-policy
   * chain. Route handler maps to a generic 401; daemon log records the
   * offending team_id for ops to fix in SQL.
   */
  | "chain-broken";

export class LoginError extends Error {
  constructor(
    public readonly kind: LoginErrorKind,
    message?: string,
  ) {
    super(message ?? kind);
    this.name = "LoginError";
  }
}

export interface LoginRequestMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface LoginResult {
  /** Raw cookie value -- caller writes into Set-Cookie. NEVER persisted. */
  cookieValue: string;
  /** The user that was logged in (existing or JIT-created). */
  user: User;
}

export interface LoginManagerDeps {
  googleConfig: GoogleAuthConfig;
  sessionConfig: AuthSessionConfig;
  db: DatabaseAdapter;
}

export class LoginManager {
  private _d: DrizzleClient | null = null;
  private _users: UserManager;
  private _teams: TeamManager;
  private _memberships: MembershipRepository;
  private _sessions: SessionsAuthRepository;
  private _teamRepo: TeamRepository;

  constructor(private deps: LoginManagerDeps) {
    this._users = new UserManager(deps.db);
    this._teams = new TeamManager(deps.db);
    this._memberships = new MembershipRepository(deps.db);
    this._sessions = new SessionsAuthRepository(deps.db);
    this._teamRepo = new TeamRepository(deps.db);
  }

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.deps.db);
    return this._d;
  }

  /**
   * Complete an OAuth login round-trip. Verifies the Google ID token,
   * upserts the user, ensures default-team membership, mints a session
   * cookie. Returns `{ cookieValue, user }`. Throws `LoginError` on
   * any verification or persistence failure.
   */
  async completeOAuthLogin(idToken: string, meta: LoginRequestMeta): Promise<LoginResult> {
    if (!this.deps.googleConfig.clientId) {
      throw new LoginError("config-missing", "Google clientId is not configured");
    }

    const identity = await verifyGoogleIdToken(idToken, {
      clientId: this.deps.googleConfig.clientId,
      allowedDomains: this.deps.googleConfig.allowedDomains,
    });
    if (!identity) {
      throw new LoginError("token-invalid", "Google ID token verification failed");
    }

    // Identity setup runs inside one transaction (user upsert +
    // account-takeover check + membership). `google_sub` is NOT
    // written here; we defer that to step 6 so a session-create
    // failure does not leave the user with a `google_sub` that a
    // re-consent retry from a different google identity would
    // mis-trigger the account-takeover guard against. SQLite does not
    // support nested transactions, so session create stays outside.
    const user = await this.deps.db.transaction<User>(async () => {
      // 1. Upsert the user by email.
      const u = await this._users.upsertByEmail({ email: identity.email, name: identity.name });

      // 2. Account-takeover guard. If the existing row has a google_sub
      //    that doesn't match the token's sub, refuse. Read-only -- no
      //    state is mutated by this branch.
      const existingSub = await this.readGoogleSub(u.id);
      if (existingSub != null && existingSub !== identity.sub) {
        logDebug("auth", `account-takeover guard: user ${u.id} has google_sub mismatch`);
        throw new LoginError("account-takeover", "Google sub mismatch for existing account");
      }

      // 3. Ensure the user has at least one live membership. If none,
      //    insert a membership in the default team. This makes
      //    AuthSessionManager.validate succeed for first-time users.
      //    Idempotent on retry: a re-run of this transaction sees the
      //    membership and skips.
      const memberships = await this._memberships.listByUser(u.id);
      if (memberships.length === 0) {
        await this._teams.addMember(DEFAULT_TEAM_ID, u.id, "member");
        logDebug("auth", `JIT-membership: user ${u.id} -> ${DEFAULT_TEAM_ID}`);
      }

      return u;
    });

    // 4. Compute the team chain ONCE at login (decision #4). The chain is
    //    cached on `sessions_auth.team_chain` for the session's lifetime;
    //    mid-session membership changes take effect on the user's next
    //    login. Walks the user's primary live membership's team upward
    //    through `parent_team_id`. Throws `LoginError(chain-broken)` on
    //    cycle / depth-cap so ops can find and fix the data bug; fail
    //    closed beats letting the user silently get the wrong policy.
    const teamChain = await this.computeTeamChain(user.id);

    // 5. Mint the session cookie. The repo self-heals expired rows for
    //    this user in the same step (its own transaction).
    const session = await this._sessions.create({
      userId: user.id,
      ttlSec: this.deps.sessionConfig.ttlSec,
      teamChain,
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    });

    // 6. Set google_sub + last_login_at AFTER the session is durable. If
    //    this fails the user is still logged in (their cookie is valid)
    //    and the next login will set google_sub then. The earlier order
    //    set google_sub before the session was durable, so a session
    //    create failure left the user with a populated google_sub --
    //    a retry from a re-consented google identity would trip the
    //    account-takeover guard and lock the user out permanently.
    try {
      await this.updateLoginFields(user.id, identity.sub);
    } catch (err: any) {
      // Session is durable; the user is logged in. Do NOT roll the
      // session back -- a stale-by-one-login google_sub is harmless
      // (next login will re-attempt). Log loudly so a sustained
      // outage is visible.
      logError("auth", `updateLoginFields failed for user ${user.id}: ${err?.message ?? err}`);
    }

    return { cookieValue: session.cookieValue, user };
  }

  /**
   * Walk the user's primary-membership team chain. Returns the chain or
   * an empty array if the user has no live membership (transient state
   * during JIT onboarding). Throws `LoginError("chain-broken")` if the
   * walker hits a cycle or the depth cap.
   */
  private async computeTeamChain(userId: string): Promise<string[]> {
    const memberships = await this._memberships.listByUser(userId);
    if (memberships.length === 0) return [];
    const primary = memberships[0];
    try {
      return await getAncestorChain(this._teamRepo, primary.team_id);
    } catch (err) {
      if (err instanceof TeamChainError) {
        logError("auth", `team chain broken at ${err.atTeamId} (${err.kind}) -- contact admin to fix parent_team_id`);
        throw new LoginError("chain-broken", `team chain ${err.kind} at ${err.atTeamId}`);
      }
      throw err;
    }
  }

  /**
   * Hash + delete the matching session row. Idempotent: a missing or
   * already-deleted session is a no-op.
   */
  async logout(cookieValue: string): Promise<void> {
    if (!cookieValue) return;
    await this._sessions.deleteByCookieValue(cookieValue);
  }

  /** Read `users.google_sub` for a user id. Returns null if unset or missing. */
  private async readGoogleSub(userId: string): Promise<string | null> {
    const d = this.d();
    const u = d.schema.users;
    const rows = await (d.db as any).select({ googleSub: u.googleSub }).from(u).where(eq(u.id, userId)).limit(1);
    const row = (rows as Array<{ googleSub: string | null }>)[0];
    return row?.googleSub ?? null;
  }

  /** Set google_sub (if not yet set) and bump last_login_at. */
  private async updateLoginFields(userId: string, googleSub: string): Promise<void> {
    const d = this.d();
    const u = d.schema.users;
    const ts = now();
    await (d.db as any).update(u).set({ googleSub, lastLoginAt: ts, updatedAt: ts }).where(eq(u.id, userId));
  }
}
