/**
 * AuthSessionManager -- cookie-based auth session validation.
 *
 * Mirrors `ApiKeyManager` in shape: a single `validate(cookieValue)` call
 * returns a wire `TenantContext` (or null) for the request middleware to
 * thread through. Login / cookie minting lives in a separate handler
 * (`auth/login.ts`); this manager is read-only at request time apart from
 * the sliding-expiry refresh described below.
 *
 * Resolution chain:
 *   cookieValue
 *     -> sessions_auth row (must be active: expires_at >= now)
 *     -> users row (must be live)
 *     -> live membership -> team -> tenant
 *     -> { tenantId, userId, role }
 *
 * Any missing link returns null.
 *
 * SIDE EFFECT (sliding expiry): after a successful resolve, if the row's
 * `last_seen_at` is older than `refreshThresholdSec`, `validate` issues a
 * `touchExpiry()` write to bump `last_seen_at` and `expires_at`. This keeps
 * idle sessions alive on activity without writing on every request. The
 * touch is best-effort: if it fails (race with delete, transient DB error,
 * etc.) we log via `logDebug` and STILL return the resolved context -- the
 * row was live when we read it, that's the source of truth, and failing
 * the request would log the user out for a refresh blip. The log line lets
 * ops detect a sustained sliding-expiry outage.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import type { TenantContext } from "../../types/index.js";
import { SessionsAuthRepository } from "../repositories/sessions-auth.js";
import { logDebug, logError } from "../observability/structured-log.js";

/** Subset of `auth.session` config that the manager actually needs. */
export interface AuthSessionManagerConfig {
  /** Sliding TTL in seconds; passed to `touchExpiry`. */
  ttlSec: number;
  /**
   * Skip the touch when the row's `last_seen_at` is younger than this many
   * seconds. Set high (e.g. 300s) to cut DB writes by orders of magnitude
   * under load; set 0 to touch on every request.
   */
  refreshThresholdSec: number;
}

export class AuthSessionManager {
  private _d: DrizzleClient | null = null;
  private _sessions: SessionsAuthRepository;

  constructor(
    private db: DatabaseAdapter,
    private cfg: AuthSessionManagerConfig,
  ) {
    this._sessions = new SessionsAuthRepository(db);
  }

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  /** Expose the underlying sessions repo for callers that need touchExpiry / delete. */
  get sessions(): SessionsAuthRepository {
    return this._sessions;
  }

  /**
   * Validate a session cookie value and return the wire TenantContext.
   * Returns null if the session is missing, expired, the user is gone, or
   * the user has no live membership.
   *
   * Slides the expiry window when the row's `last_seen_at` is older than
   * `refreshThresholdSec`. Touch failures are logged but never propagated
   * -- a refresh blip must not log the user out.
   */
  async validate(cookieValue: string): Promise<TenantContext | null> {
    if (!cookieValue) return null;

    const session = await this._sessions.getActive(cookieValue);
    if (!session) {
      // Never log cookieValue itself -- it IS the bearer credential, and
      // ARK_LOG_LEVEL=debug ships logs to OTLP / aggregators where they
      // become a replay vector. Mirror ApiKeyManager.validate, which also
      // never logs the raw token.
      logDebug("auth", "auth session not found or expired");
      return null;
    }

    const d = this.d();
    const u = d.schema.users;
    const m = d.schema.memberships;
    const t = d.schema.teams;

    // Look up the user (live only).
    const userRows = await (d.db as any)
      .select({ id: u.id })
      .from(u)
      .where(and(eq(u.id, session.user_id), isNull(u.deletedAt)))
      .limit(1);
    if (!(userRows as Array<{ id: string }>)[0]) {
      // No cookieValue interpolation -- it IS the bearer credential.
      logDebug("auth", `auth session resolves to deleted/missing user (user_id=${session.user_id})`);
      return null;
    }

    // Live membership -> team -> tenant. Returns at most one row in Phase 1
    // (single-team-per-user invariant); if multiple ever land we take the
    // first.
    const memberRows = await (d.db as any)
      .select({ role: m.role, tenantId: t.tenantId })
      .from(m)
      .innerJoin(t, eq(t.id, m.teamId))
      .where(and(eq(m.userId, session.user_id), isNull(m.deletedAt), isNull(t.deletedAt)))
      .limit(1);

    const member = (memberRows as Array<{ role: string; tenantId: string }>)[0];
    if (!member) {
      // No cookieValue interpolation -- it IS the bearer credential.
      logDebug("auth", `auth session resolves to user with no live membership (user_id=${session.user_id})`);
      return null;
    }

    // Sliding expiry refresh-on-stale. Best effort: failures are logged but
    // do NOT fail validation. The row was live when we read it; a touch
    // race is no different from the user logging out 1ms later in another
    // tab.
    const lastSeenMs = Date.parse(session.last_seen_at);
    if (Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs > this.cfg.refreshThresholdSec * 1000) {
      try {
        const touched = await this._sessions.touchExpiry(cookieValue, this.cfg.ttlSec);
        if (!touched) {
          // Row vanished between getActive and touchExpiry. Not an error
          // for this request, but worth a debug line so a sustained
          // outage shows up in the log stream.
          logDebug("auth", `sliding expiry: touchExpiry returned null (user_id=${session.user_id})`);
        }
      } catch (err: any) {
        // Never include `cookieValue` -- it IS the credential. Log at
        // ERROR: a sustained sliding-expiry outage means every active
        // user force-logs-out at TTL with no warning beforehand if this
        // failure path is invisible. We still don't fail validation --
        // a single touch race shouldn't kick the user.
        logError("auth", `sliding expiry: touchExpiry threw (user_id=${session.user_id}): ${err?.message ?? err}`);
      }
    }

    // The cached team chain is computed at login (decision #4). If it is
    // present (post-Phase-1b session), parse it; if absent (pre-Phase-1b
    // session row, or login failed to compute it), fall through with `[]`
    // so the resolver still works against tenant-level overrides.
    let teamChain: string[] = [];
    if (session.team_chain) {
      try {
        const parsed = JSON.parse(session.team_chain);
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
          teamChain = parsed;
        }
      } catch {
        // Stale / malformed cached chain. Keep `[]` rather than failing the
        // request -- the user can re-login to recompute.
        logDebug("auth", `auth session has malformed team_chain (user_id=${session.user_id})`);
      }
    }

    return {
      tenantId: member.tenantId,
      userId: session.user_id,
      role: normalizeRole(member.role),
      // Cookie auth = real human; identity gate and scoping gate are the
      // same user.
      scopingUserId: session.user_id,
      teamChain,
    };
  }
}

function normalizeRole(role: string): TenantContext["role"] {
  if (role === "admin" || role === "member" || role === "viewer") return role;
  // memberships.role can be "owner" (legacy); collapse to "admin" for the wire context
  // since handler-side role checks only know admin / member / viewer.
  if (role === "owner") return "admin";
  return "viewer";
}
