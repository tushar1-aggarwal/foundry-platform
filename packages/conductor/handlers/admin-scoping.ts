/**
 * Admin RPC handlers for `scoping_overrides` management. Replaces the
 * SQL playbook from Phase 1 with a proper write surface that validates
 * the row (scope, value shape, value-in-catalog) BEFORE the row lands
 * in the table.
 *
 *   admin/scoping/set     { scope_kind, scope_id, key, value }
 *   admin/scoping/list    { scope_kind?, scope_id?, key?, includeDeleted? }
 *   admin/scoping/get     { id }
 *   admin/scoping/delete  { id }  OR  { scope_kind, scope_id, key }
 *
 * Every method:
 *   - Requires admin role (`requireAdmin(ctx)`).
 *   - Operates tenant-scoped: queries always filter on `ctx.tenantId`,
 *     and tenant-level rows must name `ctx.tenantId` as their scope_id
 *     (validateScopeId).
 *   - For `set`: dispatches to per-key value validators
 *     (validateOverride) so a typo'd runtime / model / compute / flow
 *     name is rejected at write time, not at the next user's
 *     `session/start`.
 *
 * Audit metadata (`set_by` / `deleted_by`) is captured from
 * `actorIdentity(ctx)` on every write — prefers the bound real-user id
 * over the api-key sentinel so the audit row points to the human.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { actorIdentity, requireAdmin } from "../../core/auth/context.js";
import type { ScopeKind } from "../../core/repositories/index.js";
import { DEFAULT_LIST_LIMIT } from "../../core/repositories/scoping-overrides.js";
import { validateScopeId, validateOverride } from "./admin-scoping-validators.js";

/**
 * Pure trim-and-flag helper for the `admin/scoping/list` probe pattern.
 * The handler asks the repo for `cap + 1` rows and passes the result
 * here: if the extra row was returned, `truncated` is true and the row
 * is trimmed off; otherwise the rows pass through unchanged. Exported
 * so a unit test can exercise the boundary cases without seeding the
 * full `DEFAULT_LIST_LIMIT` (1000) rows into the DB.
 */
export function applyListProbe<T>(probeRows: T[], cap: number): { rows: T[]; truncated: boolean } {
  if (probeRows.length > cap) {
    return { rows: probeRows.slice(0, cap), truncated: true };
  }
  return { rows: probeRows, truncated: false };
}

const VALID_SCOPE_KINDS: ScopeKind[] = ["user", "team", "tenant"];

function assertScopeKind(value: unknown): ScopeKind {
  if (typeof value !== "string" || !VALID_SCOPE_KINDS.includes(value as ScopeKind)) {
    throw new RpcError(
      `invalid scope_kind '${String(value)}': must be one of ${VALID_SCOPE_KINDS.join(", ")}`,
      ErrorCodes.INVALID_PARAMS,
    );
  }
  return value as ScopeKind;
}

export function registerAdminScopingHandlers(router: Router, app: AppContext): void {
  router.handle("admin/scoping/set", async (params, _notify, ctx) => {
    requireAdmin(ctx);
    const { scope_kind, scope_id, key, value } = extract<{
      scope_kind: string;
      scope_id: string;
      key: string;
      value: unknown;
    }>(params, ["scope_kind", "scope_id", "key", "value"]);

    const kind = assertScopeKind(scope_kind);
    await validateScopeId(app, ctx, kind, scope_id);
    await validateOverride(app, ctx, key, value);

    const row = await app.scopingOverrides.set(
      { scope_kind: kind, scope_id, key, tenant_id: ctx.tenantId },
      value,
      actorIdentity(ctx),
    );
    return { row };
  });

  router.handle("admin/scoping/list", async (params, _notify, ctx) => {
    requireAdmin(ctx);
    const { scope_kind, scope_id, key, includeDeleted } = extract<{
      scope_kind?: string;
      scope_id?: string;
      key?: string;
      includeDeleted?: boolean;
    }>(params, []);

    const filter: Parameters<typeof app.scopingOverrides.listForTenant>[1] = {};
    if (scope_kind !== undefined) filter.scope_kind = assertScopeKind(scope_kind);
    if (scope_id !== undefined) filter.scope_id = scope_id;
    if (key !== undefined) filter.key = key;
    if (includeDeleted !== undefined) filter.includeDeleted = includeDeleted;

    // Pagination is deferred. To report `truncated` precisely (not just
    // "rows.length === cap" which false-positives at the boundary), we
    // ask the repo for one extra row and let `applyListProbe` decide.
    const cap = DEFAULT_LIST_LIMIT;
    const probe = await app.scopingOverrides.listForTenant(ctx.tenantId, { ...filter, limit: cap + 1 });
    return applyListProbe(probe, cap);
  });

  router.handle("admin/scoping/get", async (params, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(params, ["id"]);
    const row = await app.scopingOverrides.getById(id, ctx.tenantId);
    if (!row) {
      throw new RpcError(`scoping override '${id}' not found in tenant '${ctx.tenantId}'`, ErrorCodes.NOT_FOUND);
    }
    return { row };
  });

  router.handle("admin/scoping/delete", async (params, _notify, ctx) => {
    requireAdmin(ctx);
    const { id, scope_kind, scope_id, key } = extract<{
      id?: string;
      scope_kind?: string;
      scope_id?: string;
      key?: string;
    }>(params, []);

    // Mode exclusivity: callers must pass EITHER `id` OR the full
    // composite `(scope_kind, scope_id, key)`, never both.
    // Accepting both would let a caller silently ignore the composite
    // when both disagree (id wins arbitrarily) -- safer to reject the
    // ambiguous request.
    const hasId = id !== undefined && id !== null && id !== "";
    const compositeFields = [scope_kind, scope_id, key];
    const compositeCount = compositeFields.filter((v) => v !== undefined && v !== null && v !== "").length;
    const hasComposite = compositeCount === 3;
    const hasPartialComposite = compositeCount > 0 && compositeCount < 3;

    if (hasId && hasComposite) {
      throw new RpcError(
        "admin/scoping/delete accepts EITHER `id` OR all of `scope_kind`/`scope_id`/`key`, not both",
        ErrorCodes.INVALID_PARAMS,
      );
    }
    if (hasId && hasPartialComposite) {
      throw new RpcError(
        "admin/scoping/delete: when passing `id`, do not pass any of `scope_kind`/`scope_id`/`key`",
        ErrorCodes.INVALID_PARAMS,
      );
    }
    if (hasPartialComposite) {
      throw new RpcError(
        "admin/scoping/delete: composite delete requires all of `scope_kind`/`scope_id`/`key`",
        ErrorCodes.INVALID_PARAMS,
      );
    }

    if (hasId) {
      const ok = await app.scopingOverrides.deleteById(id as string, ctx.tenantId, actorIdentity(ctx));
      return { ok };
    }
    if (hasComposite) {
      const kind = assertScopeKind(scope_kind);
      // Symmetric with `admin/scoping/set`: validate the composite scope
      // BEFORE issuing the DB write. Without this, a delete by composite
      // for a user/team in another tenant returns `ok: false` silently
      // (the WHERE tenant_id clause filters it), while set on the same
      // triple returns a clear NOT_FOUND. Validate up-front so the error
      // shape matches set's.
      await validateScopeId(app, ctx, kind, scope_id as string);
      const ok = await app.scopingOverrides.delete(
        { scope_kind: kind, scope_id: scope_id as string, key: key as string, tenant_id: ctx.tenantId },
        actorIdentity(ctx),
      );
      return { ok };
    }
    throw new RpcError(
      "admin/scoping/delete requires either `id` or all of `scope_kind` / `scope_id` / `key`",
      ErrorCodes.INVALID_PARAMS,
    );
  });
}
