/**
 * HierarchicalSecretResolver -- walks user -> team chain -> tenant under
 * `/ark/<tid>/...` against the configured SecretsCapability and returns
 * the effective env-var set for a dispatched session.
 *
 * Precedence (first hit per KEY wins):
 *
 *   1. /ark/<tid>/users/<uid>/<KEY>          -- user-scoped (most specific)
 *   2. /ark/<tid>/teams/<chain[0..k]>/<KEY>  -- team chain, most-specific
 *                                                segment first
 *   3. /ark/<tid>/tenant/<KEY>               -- tenant default
 *
 * `teamChain` is an array of segments naming the user's team membership
 * from most-specific to root. E.g. `["platform", "infra", "eng"]` means
 * the resolver first looks under `/ark/<tid>/teams/platform/`, then
 * `/ark/<tid>/teams/infra/`, then `/ark/<tid>/teams/eng/`.
 *
 * The resolver does NOT load `teamChain` itself -- the dispatch caller
 * looks it up from `sessions_auth.team_chain` and passes it in. This
 * keeps the resolver pure (Open question B, option 2 in PLAN.md).
 *
 * When `session.user_id` is null AND `teamChain` is empty, resolveAll
 * still walks the tenant prefix. That's the single-tenant CLI dispatch
 * path -- nothing breaks.
 */

import type { SecretsCapability } from "../../core/secrets/types.js";
import { tenantPrefix, teamPrefix, userPrefix, parsePath } from "./paths.js";

export interface ResolveSession {
  /** Tenant the session is dispatching under. Required. */
  tenant_id: string;
  /** Authenticated user id, or null for CLI / unauthenticated dispatch. */
  user_id?: string | null;
}

export class HierarchicalSecretResolver {
  constructor(private readonly secrets: SecretsCapability) {}

  /**
   * Resolve every secret visible to `session` under the precedence rules
   * above. Returns a `key -> value` map -- caller passes this map directly
   * to `placeAllSecrets`.
   *
   * Implementation walks the three prefix categories in parallel via
   * listAt(), then builds a `key -> fullPath` map in precedence order
   * (user first, team chain most-specific to least, tenant last). Only
   * sets a key when it isn't already present. A single batchGet() then
   * fetches every winning path; values are re-keyed by their leaf KEY.
   */
  async resolveAll(session: ResolveSession, teamChain: readonly string[]): Promise<Record<string, string>> {
    const tid = session.tenant_id;
    if (!tid) throw new Error("resolveAll: session.tenant_id is required");

    // Build the prefix list in precedence order so a Map insert later only
    // accepts the first-seen full path per key.
    const userPrefixStr = session.user_id ? userPrefix(tid, session.user_id) : null;
    const teamPrefixes = (teamChain ?? []).map((seg) => teamPrefix(tid, [seg]));
    const tenantPrefixStr = tenantPrefix(tid);

    // Parallel discovery.
    const listPromises: Array<Promise<{ name: string }[]>> = [];
    listPromises.push(userPrefixStr ? this.secrets.listAt(userPrefixStr) : Promise.resolve([]));
    for (const p of teamPrefixes) listPromises.push(this.secrets.listAt(p));
    listPromises.push(this.secrets.listAt(tenantPrefixStr));
    const lists = await Promise.all(listPromises);

    const userEntries = lists[0];
    const teamEntries = lists.slice(1, 1 + teamPrefixes.length);
    const tenantEntries = lists[lists.length - 1];

    // First-hit-per-KEY wins. Order: user, team chain (most-specific to
    // least), tenant.
    const winners = new Map<string, string>(); // key -> fullPath
    const addBatch = (entries: { name: string }[]): void => {
      for (const e of entries) {
        const parsed = parsePath(e.name);
        if (!parsed) continue;
        if (!winners.has(parsed.key)) winners.set(parsed.key, e.name);
      }
    };
    addBatch(userEntries);
    for (const batch of teamEntries) addBatch(batch);
    addBatch(tenantEntries);

    if (winners.size === 0) return {};

    const winningPaths = Array.from(winners.values());
    const values = await this.secrets.batchGet(winningPaths);

    const env: Record<string, string> = {};
    for (const [key, path] of winners.entries()) {
      const v = values[path];
      // Silently skip paths that the backend dropped between listAt and
      // batchGet (e.g. concurrent delete). The caller's assertPresent
      // check, if any, will catch a required missing key.
      if (typeof v === "string") env[key] = v;
    }
    return env;
  }

  /**
   * Throw with the missing-list when any required key isn't in env.
   * Error message names the keys only -- never the values.
   */
  assertPresent(requiredKeys: readonly string[], env: Record<string, string>): void {
    if (!Array.isArray(requiredKeys) || requiredKeys.length === 0) return;
    const missing: string[] = [];
    for (const k of requiredKeys) {
      if (!(k in env)) missing.push(k);
    }
    if (missing.length > 0) {
      throw new Error(`Missing required secrets: ${missing.sort().join(", ")}`);
    }
  }
}
