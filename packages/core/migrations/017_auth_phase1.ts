/**
 * Migration 017 -- auth Phase 1 schema additions.
 *
 * Adds the columns and tables needed for cookie-based Google OIDC auth,
 * the recursive team hierarchy mirrored from DX, the self-service
 * ownership column on api_keys, and the org-override surface walked by
 * the ScopingResolver:
 *
 *   - users.google_sub        Google's stable subject id, set on first login
 *   - users.last_login_at     bumped on each successful login
 *   - teams.parent_team_id    self-reference for variable-depth team trees
 *   - sessions_auth (table)   server-side session store for the cookie flow
 *                             (`team_chain` cached at login)
 *   - api_keys.user_id        self-service ownership (NULL = admin/legacy)
 *   - scoping_overrides       single override surface for the resolver,
 *                             keyed by (scope_kind, scope_id, key, tenant_id)
 *
 * Plus a one-time seed of `default` tenant and `default-team` so the
 * login-flow fallback path has valid FK targets. Real tenants/teams enter
 * via SQL playbook or DX sync (later phase) -- we deliberately do NOT seed
 * OCL / PPSL / PML / CLM / CST here because DX is the source of truth for
 * those.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteAuthPhase1 } from "./017_auth_phase1_sqlite.js";
import { applyPostgresAuthPhase1 } from "./017_auth_phase1_postgres.js";

export const VERSION = 17;
export const NAME = "auth_phase1";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteAuthPhase1(ctx.db);
  } else {
    await applyPostgresAuthPhase1(ctx.db);
  }
}
