/**
 * Write-time validators for `admin/scoping/*` RPCs.
 *
 * `validateScopeId` enforces the cross-tenant defense: the caller's
 * `ctx.tenantId` must be consistent with `(scope_kind, scope_id)`:
 *   - scope_kind=tenant -> scope_id must equal ctx.tenantId
 *   - scope_kind=user   -> user row exists AND has a live membership in
 *                          some team belonging to ctx.tenantId.
 *                          (UserManager.get is global -- users have no
 *                          tenant_id column; tenant membership is derived
 *                          through memberships -> teams.)
 *   - scope_kind=team   -> team row exists AND team.tenant_id == ctx.tenantId.
 *                          (TeamManager.get is global; we re-check the
 *                          tenant column ourselves.)
 *
 * `validateOverride` enforces value-shape and catalog-existence per key:
 *   - flow.allowlist  -> string[] AND every element is a live flow in the
 *                        tenant-scoped flow store (scoped.flows.list())
 *   - runtime         -> string AND app.runtimes.get(value) is non-null
 *   - model           -> string AND app.models.get(value) is non-null
 *   - compute.default -> string AND scopedApp.computes.get(value) is non-null
 *
 * Unknown keys are rejected with a known-keys hint so typos surface
 * immediately at write time rather than at the next user's session/start.
 *
 * Every rejection is mirrored to the structured log under component
 * "scoping" (level=warn) so probing leaves a server-side trail even when
 * the RPC error is sanitized.
 */

import type { AppContext } from "../../core/app.js";
import type { TenantContext } from "../../core/auth/context.js";
import type { ScopeKind } from "../../core/repositories/index.js";
import { logError, logWarn } from "../../core/observability/structured-log.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";

const KNOWN_KEYS = ["flow.allowlist", "runtime", "model", "compute.default"] as const;
const MAX_KNOWN_OPTIONS_IN_ERROR = 20;

/**
 * Render the "a, b, c, ... (and N more)" tail used in catalog-rejection
 * error messages across the validator. Pure function -- exported so a
 * unit test can exercise the truncation branch with a small `max`
 * instead of having to seed >20 items into a real store.
 *
 * Note on disclosure: the validator is invoked only from
 * `admin/scoping/set`, which gates on `requireAdmin(ctx)` (handler
 * layer). The catalog hints are therefore admin-only by construction.
 * If a future PR exposes a member self-service write path that reuses
 * these validators, gate the hints on `ctx.isAdmin` before listing.
 */
export function formatKnownOptionsHint(known: string[], max: number): string {
  const sorted = [...known].sort();
  if (sorted.length <= max) return sorted.join(", ");
  return `${sorted.slice(0, max).join(", ")}, ... (and ${sorted.length - max} more)`;
}

function tenantScopedApp(app: AppContext, ctx: TenantContext): AppContext {
  return ctx.tenantId !== app.tenantId ? app.forTenant(ctx.tenantId) : app;
}

/**
 * Severity routing for `reject()`:
 *
 *   "warn"  -> ordinary input-validation rejections (typo'd runtime,
 *             unknown key, bad value shape). Operator UX issues.
 *   "error" -> cross-tenant boundary probes: tenant-scope id mismatch
 *             on `admin/scoping/set` (caller tried to write into another
 *             tenant) and team-scope cross-tenant access (caller tried
 *             to read/write a team whose row lives elsewhere). Matches
 *             the PR #534 precedent for security-probe logs and lifts
 *             them above the input-error noise on ops dashboards.
 */
type RejectSeverity = "warn" | "error";

function reject(
  ctx: TenantContext,
  reason: string,
  fields: Record<string, unknown>,
  code: number,
  message: string,
  severity: RejectSeverity = "warn",
): never {
  const log = severity === "error" ? logError : logWarn;
  log("scoping", `admin/scoping validation rejected: ${reason}`, {
    tenant_id: ctx.tenantId,
    actor: ctx.userId,
    ...fields,
  });
  throw new RpcError(message, code);
}

export async function validateScopeId(
  app: AppContext,
  ctx: TenantContext,
  scopeKind: ScopeKind,
  scopeId: string,
): Promise<void> {
  if (scopeKind === "tenant") {
    if (scopeId !== ctx.tenantId) {
      reject(
        ctx,
        "tenant-scope id mismatch",
        { scope_kind: scopeKind, scope_id: scopeId },
        ErrorCodes.FORBIDDEN,
        `scope_id at tenant scope must equal caller's tenant_id ('${ctx.tenantId}'); got '${scopeId}'`,
        "error",
      );
    }
    return;
  }

  if (scopeKind === "user") {
    // Single-JOIN check: returns true iff the user has a live membership in
    // a live team of `ctx.tenantId`. Covers all rejection cases (user
    // doesn't exist, soft-deleted user, no memberships, memberships only
    // in other tenants) with the same NOT_FOUND -- never leaking which
    // arm tripped.
    const belongs = await app.teams.userBelongsToTenant(scopeId, ctx.tenantId);
    if (!belongs) {
      reject(
        ctx,
        "user does not belong to tenant",
        { scope_kind: scopeKind, scope_id: scopeId },
        ErrorCodes.NOT_FOUND,
        `user '${scopeId}' not found in tenant '${ctx.tenantId}'`,
      );
    }
    return;
  }

  if (scopeKind === "team") {
    // TeamManager is not tenant-rebound in `tenant-scope.ts`, so
    // `app.teams.get` and `scoped.teams.get` resolve to the same global
    // manager. Skip the no-op `tenantScopedApp` call and check the
    // `tenant_id` column ourselves below.
    const team = await app.teams.get(scopeId);
    if (!team) {
      reject(
        ctx,
        "team not found",
        { scope_kind: scopeKind, scope_id: scopeId },
        ErrorCodes.NOT_FOUND,
        `team '${scopeId}' not found in tenant '${ctx.tenantId}'`,
      );
    }
    // TeamManager.get is global despite teams having a tenant_id column;
    // re-check that this team lives under the caller's tenant.
    if (team.tenant_id !== ctx.tenantId) {
      reject(
        ctx,
        "cross-tenant team access",
        { scope_kind: scopeKind, scope_id: scopeId, team_tenant_id: team.tenant_id },
        ErrorCodes.NOT_FOUND,
        `team '${scopeId}' not found in tenant '${ctx.tenantId}'`,
        "error",
      );
    }
    return;
  }

  reject(
    ctx,
    "unknown scope_kind",
    { scope_kind: scopeKind },
    ErrorCodes.INVALID_PARAMS,
    `unknown scope_kind '${scopeKind}'. Known: user, team, tenant`,
  );
}

export async function validateOverride(
  app: AppContext,
  ctx: TenantContext,
  key: string,
  value: unknown,
): Promise<void> {
  switch (key) {
    case "flow.allowlist": {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        reject(
          ctx,
          "flow.allowlist shape",
          { key, value_type: Array.isArray(value) ? "array-non-string" : typeof value },
          ErrorCodes.INVALID_PARAMS,
          "flow.allowlist must be a JSON array of strings",
        );
      }
      // Use the tenant-scoped flow store so hosted mode (where flows are
      // tenant-scoped via DbResourceStore) does not leak cross-tenant
      // flow names in the validator -- or accept them as valid.
      const scoped = tenantScopedApp(app, ctx);
      const flows = await scoped.flows.list();
      const flowNames = new Set(flows.map((f) => f.name));
      const unknown = (value as string[]).filter((n) => !flowNames.has(n));
      if (unknown.length > 0) {
        const knownSuffix = formatKnownOptionsHint([...flowNames], MAX_KNOWN_OPTIONS_IN_ERROR);
        reject(
          ctx,
          "flow.allowlist unknown flow(s)",
          { key, unknown_flows: unknown, known_count: flowNames.size },
          ErrorCodes.INVALID_PARAMS,
          `flow.allowlist contains unknown flow(s): ${unknown.join(", ")}. Known flows: ${knownSuffix}`,
        );
      }
      return;
    }

    case "runtime": {
      if (typeof value !== "string") {
        reject(
          ctx,
          "runtime shape",
          { key, value_type: typeof value },
          ErrorCodes.INVALID_PARAMS,
          "runtime override value must be a string",
        );
      }
      if (!app.runtimes.get(value as string)) {
        const knownSuffix = formatKnownOptionsHint(
          app.runtimes.list().map((r) => r.name),
          MAX_KNOWN_OPTIONS_IN_ERROR,
        );
        reject(
          ctx,
          "runtime unknown",
          { key, value },
          ErrorCodes.INVALID_PARAMS,
          `runtime '${value}' is not a registered runtime. Known runtimes: ${knownSuffix}`,
        );
      }
      return;
    }

    case "model": {
      if (typeof value !== "string") {
        reject(
          ctx,
          "model shape",
          { key, value_type: typeof value },
          ErrorCodes.INVALID_PARAMS,
          "model override value must be a string",
        );
      }
      if (!app.models.get(value as string)) {
        // Model catalog can be 50+ entries; include both ids and aliases
        // so a typo on either form gets a useful correction hint.
        const ids = app.models.list().map((m) => m.id);
        const aliases = app.models.list().flatMap((m) => m.aliases ?? []);
        const knownSuffix = formatKnownOptionsHint([...ids, ...aliases], MAX_KNOWN_OPTIONS_IN_ERROR);
        reject(
          ctx,
          "model unknown",
          { key, value },
          ErrorCodes.INVALID_PARAMS,
          `model '${value}' is not in the catalog (must be a registered id or alias). Known: ${knownSuffix}`,
        );
      }
      return;
    }

    case "compute.default": {
      if (typeof value !== "string") {
        reject(
          ctx,
          "compute.default shape",
          { key, value_type: typeof value },
          ErrorCodes.INVALID_PARAMS,
          "compute.default override value must be a string",
        );
      }
      const scoped = tenantScopedApp(app, ctx);
      const row = await scoped.computes.get(value as string);
      if (!row) {
        const all = await scoped.computes.list();
        const knownSuffix = formatKnownOptionsHint(
          all.map((c) => c.name),
          MAX_KNOWN_OPTIONS_IN_ERROR,
        );
        reject(
          ctx,
          "compute unknown for tenant",
          { key, value },
          ErrorCodes.INVALID_PARAMS,
          `compute '${value}' is not registered in tenant '${ctx.tenantId}'. Known computes in tenant: ${knownSuffix}`,
        );
      }
      return;
    }

    default:
      reject(
        ctx,
        "unknown key",
        { key },
        ErrorCodes.INVALID_PARAMS,
        `Unknown scoping key '${key}'. Known keys: ${KNOWN_KEYS.join(", ")}`,
      );
  }
}
