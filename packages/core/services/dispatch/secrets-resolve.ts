/**
 * Stage secret resolution -- dispatch seam onto the hierarchical resolver.
 *
 * Before Phase 2, secrets were declared as YAML allowlists at the
 * runtime + stage level and merged at dispatch time. Phase 2 inverts
 * that: the SecretsCapability backend is the source of truth, and the
 * resolver walks `/ark/<tid>/{users/<uid>|teams/<chain>|tenant}/<KEY>`
 * with first-hit-per-key precedence (user > team most-specific > tenant).
 *
 * Stage YAML `secrets:` is now an ASSERT-PRESENT list: when the operator
 * declares a stage requires `[ANTHROPIC_API_KEY, FOO]`, dispatch fails
 * if the resolver couldn't produce them. The runtime-level YAML
 * allowlist is dropped entirely.
 *
 * Post-resolver/placement integration: `resolve()` still returns `.env`
 * for backwards compatibility and so the assert-present check has
 * something to test against, but the dispatch path (`buildLaunchEnv`)
 * no longer merges that env into the launch env -- buildLaunchEnv runs
 * the hierarchical resolver independently and feeds its env to
 * `placeAllSecrets`, which is now the single env-var source. Only
 * `.error` from `resolve()` is consumed downstream.
 *
 * `teamChain` is loaded by the injected `teamChainLoader` callback (Open
 * question B option 2 in PLAN.md). In tests that don't wire one in, the
 * loader is treated as returning `[]`, so the resolver falls back to
 * tenant-only -- which is the correct behaviour for the single-tenant
 * CLI dispatch path.
 */

import { logWarn } from "../../observability/structured-log.js";
import type { DispatchDeps } from "./types.js";
import type { Session } from "../../../types/index.js";
import type { StageDefinition } from "../flow.js";
import { HierarchicalSecretResolver } from "../../../secrets/resolver/index.js";

export class StageSecretResolver {
  private readonly resolver: HierarchicalSecretResolver;
  constructor(private readonly deps: Pick<DispatchDeps, "secrets" | "config" | "teamChainLoader">) {
    this.resolver = new HierarchicalSecretResolver(deps.secrets);
  }

  async resolve(
    session: Session,
    stageDef: StageDefinition | null,
    _runtimeKind: string,
    log: (msg: string) => void,
  ): Promise<{ env: Record<string, string>; error?: string }> {
    const tenantId = session.tenant_id ?? this.deps.config.authSection?.defaultTenant ?? "default";

    // Load team chain (cached on sessions_auth at login; loader is the
    // dispatch seam). Failure to load is non-fatal -- we degrade to
    // tenant-only resolution and warn.
    let teamChain: string[] = [];
    try {
      const loader = this.deps.teamChainLoader;
      if (loader) teamChain = (await loader(session)) ?? [];
    } catch (err: unknown) {
      logWarn("session", `secrets-resolve: teamChainLoader failed: ${(err as Error)?.message ?? String(err)}`);
    }

    let env: Record<string, string>;
    try {
      env = await this.resolver.resolveAll({ tenant_id: tenantId, user_id: session.user_id ?? null }, teamChain);
    } catch (err: unknown) {
      return { env: {}, error: `Secret resolution failed: ${(err as Error)?.message ?? String(err)}` };
    }

    // Stage YAML `secrets:` is now assert-only: every name listed there
    // MUST resolve, otherwise dispatch fails.
    const required = Array.isArray(stageDef?.secrets) ? stageDef.secrets : [];
    if (required.length > 0) {
      try {
        this.resolver.assertPresent(required, env);
      } catch (err: unknown) {
        return { env: {}, error: `Secret resolution failed: ${(err as Error)?.message ?? String(err)}` };
      }
    }

    if (Object.keys(env).length > 0) {
      log(`Resolved ${Object.keys(env).length} secret env var(s) for tenant ${tenantId}`);
    }
    return { env };
  }
}
