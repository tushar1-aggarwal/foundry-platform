/**
 * ScopingResolver -- override lookup for the user > team-chain > tenant
 * resolution chain.
 *
 * Walks `[user, ...ctx.teamChain, tenant]` against `scoping_overrides`
 * and returns the first non-null match. Winner-take-all (decision #3):
 * the most specific row wins, less specific rows are ignored. Returns
 * null if nothing matches; the caller is expected to fall back to the
 * YAML default.
 *
 * Caching: NONE at the resolver layer (decision #7). Every `resolve()`
 * call hits the DB once per scope hop. Profile-driven caching is a
 * Phase 2 concern.
 *
 * scopingUserId vs userId: the user-level lookup uses
 * `ctx.scopingUserId`, NOT `ctx.userId`. For cookie auth they are the
 * same (real human's `users.id`); for owned api-key auth, `userId` is
 * the `ak-...` sentinel that drives the `requireRealUser` identity gate
 * while `scopingUserId` is the real owner's `users.id` so the owner's
 * user-level overrides still apply to their key (decision #12).
 */

import type { TenantContext } from "../../types/index.js";
import type { ScopingOverrideRepository, ScopeKind } from "../repositories/scoping-overrides.js";

export class ScopingResolver {
  constructor(private overrides: ScopingOverrideRepository) {}

  /**
   * Look up the override value for `key` in `ctx`. Returns null if no
   * row matches at any level of the resolution chain.
   */
  async resolve<T>(ctx: TenantContext, key: string): Promise<T | null> {
    const scopeIds: Array<{ kind: ScopeKind; id: string }> = [];
    if (ctx.scopingUserId) {
      scopeIds.push({ kind: "user", id: ctx.scopingUserId });
    }
    for (const teamId of ctx.teamChain) {
      scopeIds.push({ kind: "team", id: teamId });
    }
    scopeIds.push({ kind: "tenant", id: ctx.tenantId });

    for (const scope of scopeIds) {
      const row = await this.overrides.get({
        scope_kind: scope.kind,
        scope_id: scope.id,
        key,
        tenant_id: ctx.tenantId,
      });
      if (row) return JSON.parse(row.value_json) as T;
    }
    return null;
  }
}
