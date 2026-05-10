/**
 * `apikey/*` -- self-service API key management for logged-in users.
 *
 * Distinct from `admin/apikey/*` which is admin-gated and operates on
 * any key in a tenant. This surface lets non-admin users mint, list,
 * and revoke their OWN keys.
 *
 * Identity gate (`requireRealUser`): every method first verifies that
 * the caller's `ctx.userId` resolves to a live `users` row. This blocks
 *
 *   - anonymous callers (`ctx.userId === null`)
 *   - local-mode synthetic admin (`ctx.userId === "local"`)
 *   - API-key authenticated callers, where the materializer sets
 *     `ctx.userId = api_keys.id` (e.g. `"ak-c0565083"`) -- the lookup
 *     misses because that id has no row in `users`
 *
 * The api-key path is the load-bearing block here: without it, an
 * api-key caller could mint additional self-service keys "owned by"
 * the caller's api-key id, creating an identity loop where admin keys
 * could clone themselves indefinitely with no real-user revocation
 * surface. The handler test pins all three FORBIDDEN paths.
 *
 * Per-user cap: 10 live keys at any time. The 11th create throws
 * INVALID_PARAMS. Generous for human users; CI / automation should
 * use admin-minted keys.
 *
 * Role ceiling: a user may only mint keys at-or-below their own role.
 * A `member` user cannot mint `admin` keys (privilege escalation).
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import type { TenantContext } from "../../core/auth/context.js";

const MAX_KEYS_PER_USER = 10;

const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  // `worker` is internal; users cannot mint worker keys via self-service.
};

async function requireRealUser(ctx: TenantContext, app: AppContext): Promise<void> {
  if (!ctx.userId) {
    throw new RpcError("self-service API key management requires a logged-in user session", ErrorCodes.FORBIDDEN);
  }
  if (ctx.userId === "local") {
    throw new RpcError("self-service API key management requires a logged-in user session", ErrorCodes.FORBIDDEN);
  }
  const user = await app.users.get(ctx.userId);
  if (!user || user.deleted_at) {
    throw new RpcError("self-service API key management requires a logged-in user session", ErrorCodes.FORBIDDEN);
  }
}

export function registerApiKeyHandlers(router: Router, app: AppContext): void {
  router.handle("apikey/list", async (_p, _notify, ctx) => {
    await requireRealUser(ctx, app);
    const keys = await app.apiKeys.listForUser(ctx.userId!, ctx.tenantId);
    return { keys };
  });

  router.handle("apikey/create", async (p, _notify, ctx) => {
    await requireRealUser(ctx, app);
    const { name, role, expires } = extract<{ name: string; role?: string; expires?: string }>(p, ["name"]);
    if (!name.trim()) {
      throw new RpcError("name is required", ErrorCodes.INVALID_PARAMS);
    }
    const requestedRole = role ?? ctx.role;
    if (!ROLE_RANK[requestedRole]) {
      throw new RpcError(`invalid role '${requestedRole}'`, ErrorCodes.INVALID_PARAMS);
    }
    // Role ceiling: cannot mint above own role.
    if ((ROLE_RANK[requestedRole] ?? 0) > (ROLE_RANK[ctx.role] ?? 0)) {
      throw new RpcError(`cannot mint role '${requestedRole}' from role '${ctx.role}'`, ErrorCodes.INVALID_PARAMS);
    }
    // Per-user cap: count live keys before creating.
    const live = await app.apiKeys.countLiveForUser(ctx.userId!, ctx.tenantId);
    if (live >= MAX_KEYS_PER_USER) {
      throw new RpcError(
        `maximum of ${MAX_KEYS_PER_USER} live API keys per user reached -- revoke one before minting another`,
        ErrorCodes.INVALID_PARAMS,
      );
    }
    const result = await app.apiKeys.create(
      ctx.tenantId,
      name.trim(),
      requestedRole as "admin" | "member" | "viewer",
      expires,
      ctx.userId,
    );
    return { id: result.id, key: result.key };
  });

  router.handle("apikey/revoke", async (p, _notify, ctx) => {
    await requireRealUser(ctx, app);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const ok = await app.apiKeys.revokeAsUser(ctx.userId!, ctx.tenantId, id);
    if (!ok) {
      // Conflate "missing" and "wrong owner" so a non-owner caller
      // can't probe key-id existence.
      throw new RpcError("API key not found or not owned by caller", ErrorCodes.FORBIDDEN);
    }
    return { ok: true };
  });
}
