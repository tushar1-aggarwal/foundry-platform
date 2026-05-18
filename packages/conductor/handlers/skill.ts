/**
 * Skill Hub RPC handlers - tenant-scoped CRUD-with-history surface.
 *
 *   skillhub/list                List skills visible to caller
 *   skillhub/get                 Read one skill (canonical bundle)
 *   skillhub/sync_status         Per-skill hash equality (fast, no bodies)
 *   skillhub/get_with_ancestor   Current + optional ancestor bodies for 3-way merge
 *   skillhub/put                 Create / update with CAS + normalize + force gate;
 *                                accepts optional `merge_input` audit blob from
 *                                the CLI when this put is the result of an
 *                                accepted client-side 3-way merge (RFC §7).
 *   skillhub/delete              Soft delete with visibility-aware admin gate
 *   skillhub/search              Substring match against name/description/tags in scope
 *   skillhub/published_after     New / updated skills since a timestamp in scope
 *   admin/skillhub/list          Admin-only cross-team listing within ctx.tenantId
 *   admin/skillhub/version_history  Admin-only `skill_versions` history (audit drawer)
 *
 * Note: there is NO server-side `skillhub/merge_conflict` RPC. The
 * 3-way merge runs CLIENT-SIDE in the CLI via the linked claude-agent
 * SDK using the importer's own Anthropic credentials (RFC §7). The CLI
 * then submits the accepted merge through `skillhub/put` with
 * `merge_input` carrying the provenance metadata. Conductor stays out
 * of the LLM call path entirely.
 *
 * Namespace note: this surface is `skillhub/*`, not `skill/*`. The
 * existing `skill/*` RPCs (resource.ts) own system-shipped agent skill
 * definitions injected into session context via `app.skills`
 * (FileSkillStore) - a different concept that shares the word. The two
 * surfaces are kept distinct in this PR; consolidating them is tracked
 * as a follow-up.
 *
 * Auth/visibility rules follow RFC docs/skillhub-rfc.md sections 3, 4, 7.
 * Quick reference:
 *   user-scope    -> owner-only (tenant-agnostic, consultant pattern)
 *   team-scope    -> caller's tenant matches AND team_id in caller's chain
 *   tenant-scope  -> caller's tenant matches
 *   write gates (put-update, delete, force):
 *     user-scope    -> ownership
 *     team-scope    -> admin in skill.tenant_id
 *     tenant-scope  -> admin in skill.tenant_id
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { actorIdentity, type TenantContext } from "../../core/auth/context.js";
import type { SupportingFile } from "../../core/skills/hash.js";
import { normalize, type HarnessId } from "../../core/skills/normalizer.js";
import {
  SkillVersionConflictError,
  type SkillRow,
  type SkillVisibility,
  type PutInput,
} from "../../core/repositories/skills.js";

// ── Auth helpers ──────────────────────────────────────────────────────────

/**
 * Skill operations require an authenticated caller (logged-in user OR API
 * key carrying a userId). Anonymous (`ctx.userId === null`) is rejected.
 */
function requireAuthedUser(ctx: TenantContext): string {
  if (!ctx.userId) {
    throw new RpcError("skill operations require an authenticated user", ErrorCodes.FORBIDDEN);
  }
  return ctx.userId;
}

/**
 * Real-user gate for user-scope writes. User-scope skills MUST be owned by
 * a real `u-*` user (FK on `skills.owner_user_id` -> `users.id`). The
 * caller paths that fail this gate:
 *   - local-mode operator (`ctx.userId === "local"`, no real users.id) -
 *     resolve by `--visibility tenant` (or `team`) in local mode, where
 *     there's only one operator and tenant-wide IS the natural scope.
 *   - service api-keys (`admin/apikey/create` with no user binding) -
 *     resolve by minting a user-bound key, or by switching to a
 *     non-user scope.
 *   - anonymous (`ctx.userId === null` with auth required) - already
 *     refused upstream by `requireAuthedUser`; defense-in-depth here.
 */
function requireRealUserForUserScope(ctx: TenantContext): string {
  if (!ctx.scopingUserId) {
    if (ctx.userId === "local") {
      throw new RpcError(
        "user-scope skills require a real-user identity, but the daemon is running in local mode " +
          "(no auth, no user table population). Use `--visibility tenant` or `--visibility team --team <id>` " +
          "instead — in local mode there is only one operator, so tenant- or team-scope is the natural fit. " +
          "User-scope becomes available once the daemon runs with auth required and a real user is bound to your api-key / session.",
        ErrorCodes.FORBIDDEN,
      );
    }
    throw new RpcError(
      "user-scope skills require a real-user identity. This api-key is not bound to a user " +
        "(service / admin-minted key). Use a user-bound api-key, or switch to `--visibility tenant` / " +
        "`--visibility team --team <id>` for service automation.",
      ErrorCodes.FORBIDDEN,
    );
  }
  return ctx.scopingUserId;
}

// ── Visibility / mutation gates ───────────────────────────────────────────

/**
 * Read visibility per RFC §3. Returns false for invisible or unknown
 * visibility values. Callers conflate `!visible` with `not found` so we
 * don't leak skill existence outside the caller's scope.
 */
function isVisibleTo(ctx: TenantContext, skill: SkillRow): boolean {
  if (skill.visibility === "user") {
    // Owner identity is the real `u-*` user id (see actorIdentity above);
    // service api-keys (scopingUserId === null) cannot match a user-scope
    // owner row, so they don't see anyone's user-scope skills.
    return ctx.scopingUserId !== null && skill.owner_user_id === ctx.scopingUserId;
  }
  if (skill.visibility === "team") {
    return ctx.tenantId === skill.tenant_id && skill.team_id !== null && ctx.teamChain.includes(skill.team_id);
  }
  if (skill.visibility === "tenant") {
    return ctx.tenantId === skill.tenant_id;
  }
  if (skill.visibility === "cross_tenant") {
    // RFC §3: cross_tenant is "everyone, cross-tenant", but v1 rejects
    // creation at skillhub/put so no rows exist with this visibility.
    // When enabled (gated to a future system-admin surface per RFC §9
    // Q1), revisit: semantics is "return true", NOT "same-tenant only".
    return false;
  }
  return false;
}

/**
 * Mutation gate per RFC §4 (used by put-update, delete, force).
 *   user-scope    -> ownership
 *   team-scope    -> admin in skill.tenant_id
 *   tenant-scope  -> admin in skill.tenant_id
 *   cross_tenant  -> unreachable in v1 (gated to a future system-admin
 *                    surface per RFC §9 Q1; matches isVisibleTo)
 */
function canMutate(ctx: TenantContext, skill: SkillRow): boolean {
  if (skill.visibility === "user") {
    // Match real-user ownership; service api-keys (no bound user) cannot
    // mutate user-scope skills.
    return ctx.scopingUserId !== null && skill.owner_user_id === ctx.scopingUserId;
  }
  if (skill.visibility === "cross_tenant") {
    return false;
  }
  return ctx.tenantId === skill.tenant_id && ctx.isAdmin;
}

// ── Harness-hints merge per RFC §7 ────────────────────────────────────────

/**
 * Build the merged `harness_hints` map for a put:
 *   - Other harnesses' entries preserved untouched.
 *   - THIS harness's entry replaced entirely with the request's entry
 *     (last-writer-wins per harness, same semantics as `body`).
 *   - When normalization changed body / supporting_files, stash the raw
 *     originals under this harness's entry so adapter.render() for the
 *     author's harness can reproduce exactly what they wrote.
 */
function supportingFilesEqual(a: SupportingFile[], b: SupportingFile[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].path !== b[i].path || a[i].content !== b[i].content) return false;
  }
  return true;
}

function mergeHarnessHints(
  existing: Record<string, Record<string, unknown>>,
  harness: string,
  request: Record<string, Record<string, unknown>>,
  rawBody: string,
  rawSupportingFiles: SupportingFile[],
  canonical: { body: string; supporting_files: SupportingFile[] },
): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = { ...existing };
  merged[harness] = { ...(request[harness] ?? {}) };
  // Per-field preservation (RFC §7): if body changed, preserve raw body;
  // if supporting_files changed, preserve raw supporting_files. Structural
  // compare (not JSON.stringify) so a future normalize() reorder won't
  // silently mask a real change.
  if (rawBody !== canonical.body) {
    merged[harness].original_body = rawBody;
  }
  if (!supportingFilesEqual(rawSupportingFiles, canonical.supporting_files)) {
    merged[harness].original_supporting_files = rawSupportingFiles;
  }
  return merged;
}

// ── Handlers ──────────────────────────────────────────────────────────────

export function registerSkillHandlers(router: Router, app: AppContext): void {
  router.handle("skillhub/list", async (_p, _notify, ctx) => {
    requireAuthedUser(ctx);
    const skills = await app.skillHub.listVisibleTo(ctx.scopingUserId, ctx.tenantId, ctx.teamChain);
    return { skills };
  });

  router.handle("skillhub/get", async (p, _notify, ctx) => {
    requireAuthedUser(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const skill = await app.skillHub.getById(id);
    if (!skill || !isVisibleTo(ctx, skill)) {
      throw new RpcError(`skill '${id}' not found`, ErrorCodes.NOT_FOUND);
    }
    return { skill };
  });

  router.handle("skillhub/sync_status", async (p, _notify, ctx) => {
    requireAuthedUser(ctx);
    const { local_versions } = extract<{
      local_versions: { skill_id: string; local_hash?: string | null }[];
    }>(p, ["local_versions"]);

    const results: {
      skill_id: string;
      status: "up-to-date" | "server-changed" | "unknown" | "not-found";
      server_hash: string | null;
    }[] = [];

    for (const lv of local_versions) {
      const skill = await app.skillHub.getById(lv.skill_id);
      if (!skill || !isVisibleTo(ctx, skill)) {
        // Caller's sidecar references a skill they can no longer see
        // (deleted, lost access, never had access). `not-found` lets the
        // CLI prune its sidecar instead of retrying forever.
        results.push({ skill_id: lv.skill_id, status: "not-found", server_hash: null });
        continue;
      }
      if (!lv.local_hash) {
        results.push({ skill_id: lv.skill_id, status: "unknown", server_hash: skill.current_hash });
      } else if (lv.local_hash === skill.current_hash) {
        results.push({ skill_id: lv.skill_id, status: "up-to-date", server_hash: skill.current_hash });
      } else {
        results.push({ skill_id: lv.skill_id, status: "server-changed", server_hash: skill.current_hash });
      }
    }
    return { results };
  });

  router.handle("skillhub/get_with_ancestor", async (p, _notify, ctx) => {
    requireAuthedUser(ctx);
    const { skill_id, ancestor_hash } = extract<{ skill_id: string; ancestor_hash?: string }>(p, ["skill_id"]);
    const skill = await app.skillHub.getById(skill_id);
    if (!skill || !isVisibleTo(ctx, skill)) {
      throw new RpcError(`skill '${skill_id}' not found`, ErrorCodes.NOT_FOUND);
    }
    const response: Record<string, unknown> = {
      // Skill metadata needed by the CLI's adapter.render() on
      // fast-forward-pull / merge-accept writes. Empty description
      // would otherwise produce a SKILL.md the next adapter.parse()
      // rejects.
      server_name: skill.name,
      server_description: skill.description,
      server_category: skill.category,
      server_tags: skill.tags,
      server_body: skill.body,
      server_supporting_files: skill.supporting_files,
      server_hash: skill.current_hash,
      server_harness_hints: skill.harness_hints,
    };
    if (ancestor_hash) {
      const version = await app.skillVersions.getByHash(skill_id, ancestor_hash);
      if (!version) {
        // RFC §7 failure mode: caller's sidecar points at a history row
        // we don't have (cascade-deleted from prior hard delete, truncated
        // history, etc.). Caller should re-sync via skill/list.
        throw new RpcError(
          `ancestor version '${ancestor_hash}' not found for skill '${skill_id}'`,
          ErrorCodes.NOT_FOUND,
        );
      }
      response.ancestor_body = version.body;
      response.ancestor_supporting_files = version.supporting_files;
      response.ancestor_hash = version.version_hash;
    }
    return response;
  });

  router.handle("skillhub/put", async (p, _notify, ctx) => {
    requireAuthedUser(ctx);
    // Non-null because requireAuthedUser guarantees userId !== null.
    const actor = actorIdentity(ctx)!;
    const params = extract<{
      skill_id?: string;
      harness: string;
      body: string;
      supporting_files?: SupportingFile[];
      harness_hints?: Record<string, Record<string, unknown>>;
      expected_current_hash?: string;
      visibility?: SkillVisibility;
      team_id?: string;
      name?: string;
      description?: string;
      tags?: string[];
      category?: string | null;
      force?: boolean;
      /**
       * Optional merge-provenance blob. When the CLI produced this put
       * by accepting a client-side 3-way merge (RFC §7), it attaches
       * `{ ancestor_hash, mine_hash, theirs_hash, llm_model,
       *    per_file_strategies, accepted_by }` here. The server treats
       * the value as opaque audit metadata and persists it onto the
       * new skill_versions row's merge_input_json column. Audit
       * integrity ("who applied this merge") doesn't depend on the
       * blob - that comes from skill_versions.changed_by, which is
       * set server-side from ctx.userId.
       */
      merge_input?: Record<string, unknown>;
    }>(p, ["harness", "body"]);

    const supportingFiles = params.supporting_files ?? [];
    const harnessHintsReq = params.harness_hints ?? {};
    const isCreate = !params.skill_id;

    if (isCreate) {
      const visibility = params.visibility;
      if (!visibility) {
        throw new RpcError("visibility is required in create mode", ErrorCodes.INVALID_PARAMS);
      }
      // RFC §9 Q1: cross_tenant is unreachable in v1 (gated to a future
      // system-admin surface). Reject explicitly so a malicious or buggy
      // client can't slip a cross_tenant row through the CHECK constraint.
      if (visibility === "cross_tenant") {
        throw new RpcError("creating cross_tenant skills is not supported", ErrorCodes.INVALID_PARAMS);
      }
      if (!params.name?.trim()) {
        throw new RpcError("name is required in create mode", ErrorCodes.INVALID_PARAMS);
      }
      if (params.description === undefined) {
        throw new RpcError("description is required in create mode", ErrorCodes.INVALID_PARAMS);
      }

      // Per-visibility create gates (RFC §4):
      //   team-scope   -> requireAdmin in ctx.tenantId, team_id required
      //   tenant-scope -> requireAdmin in ctx.tenantId
      // No team-chain check at create time - matches the mutation gate
      // (canMutate), where any admin in the owning tenant can act as
      // janitor regardless of whether they're a member of the team.
      let teamIdForCreate: string | null = null;
      if (visibility === "team") {
        if (!params.team_id) {
          throw new RpcError("team_id is required for visibility='team'", ErrorCodes.INVALID_PARAMS);
        }
        if (!ctx.isAdmin) {
          throw new RpcError("creating team-scope skills requires admin", ErrorCodes.FORBIDDEN);
        }
        teamIdForCreate = params.team_id;
      }
      if (visibility === "tenant" && !ctx.isAdmin) {
        throw new RpcError("creating tenant-scope skills requires admin", ErrorCodes.FORBIDDEN);
      }
      // user-scope create needs a real user to own the row (FK +
      // consultant-pattern resolution); service api-keys are refused.
      const ownerForUserScope = visibility === "user" ? requireRealUserForUserScope(ctx) : null;

      const canonical = normalize(
        { body: params.body, supporting_files: supportingFiles },
        params.harness as HarnessId,
      );
      const mergedHarnessHints = mergeHarnessHints(
        {},
        params.harness,
        harnessHintsReq,
        params.body,
        supportingFiles,
        canonical,
      );

      const putInput: PutInput = {
        tenant_id: visibility === "user" ? null : ctx.tenantId,
        team_id: teamIdForCreate,
        owner_user_id: ownerForUserScope,
        visibility,
        name: params.name.trim(),
        description: params.description,
        body: canonical.body,
        supporting_files: canonical.supporting_files,
        category: params.category ?? null,
        tags: params.tags ?? [],
        harness_hints: mergedHarnessHints,
        actor,
        merge_input: params.merge_input,
      };

      const result = await app.skillHub.put(putInput);
      return { skill: result.skill, version_written: result.versionWritten };
    }

    // Update mode.
    const existing = await app.skillHub.getById(params.skill_id!);
    if (!existing || !isVisibleTo(ctx, existing)) {
      throw new RpcError(`skill '${params.skill_id}' not found`, ErrorCodes.NOT_FOUND);
    }
    if (!canMutate(ctx, existing)) {
      throw new RpcError(`not permitted to modify skill '${existing.id}'`, ErrorCodes.FORBIDDEN);
    }

    // Visibility change via update is not supported in v1. Promoting
    // user -> team transforms the scoping columns' shape
    // (tenant_id NULL -> set, owner_user_id set -> NULL, etc.), which
    // would mid-row fail the CHECK constraint. Workflow for v1: delete
    // the old skill and create a new one with the new visibility. See
    // RFC §5 "Visibility-change limitation".
    if (params.visibility && params.visibility !== existing.visibility) {
      throw new RpcError(
        `visibility changes via skillhub/put are not supported in v1; delete and recreate to change visibility`,
        ErrorCodes.UNSUPPORTED,
      );
    }

    const force = params.force === true;
    if (!force && !params.expected_current_hash) {
      throw new RpcError("expected_current_hash is required for non-force updates", ErrorCodes.INVALID_PARAMS);
    }

    const canonical = normalize({ body: params.body, supporting_files: supportingFiles }, params.harness as HarnessId);
    const mergedHarnessHints = mergeHarnessHints(
      existing.harness_hints,
      params.harness,
      harnessHintsReq,
      params.body,
      supportingFiles,
      canonical,
    );

    const putInput: PutInput = {
      skill_id: existing.id,
      // For force=true, set expected_current_hash to the server's actual
      // current_hash so the repo-level CAS still passes. Caller has
      // explicitly opted into overwriting whatever's on the server.
      expected_current_hash: force ? existing.current_hash : params.expected_current_hash,
      tenant_id: existing.tenant_id,
      team_id: existing.team_id,
      owner_user_id: existing.owner_user_id,
      visibility: existing.visibility,
      // `||` (not `??`) for name/description: server is the security
      // boundary, so empty-string overwrites must fall back to existing
      // rather than nuke the row's metadata. `category` separately uses
      // `!== undefined` because null IS a meaningful "clear it" signal.
      name: params.name?.trim() || existing.name,
      description: params.description?.trim() || existing.description,
      body: canonical.body,
      supporting_files: canonical.supporting_files,
      category: params.category !== undefined ? params.category : existing.category,
      tags: params.tags ?? existing.tags,
      harness_hints: mergedHarnessHints,
      actor,
      merge_input: params.merge_input,
    };

    try {
      const result = await app.skillHub.put(putInput);
      return { skill: result.skill, version_written: result.versionWritten };
    } catch (e: unknown) {
      if (e instanceof SkillVersionConflictError) {
        throw new RpcError(
          `skill '${existing.id}' was modified concurrently; run sync to reconcile`,
          ErrorCodes.CONFLICT,
        );
      }
      throw e;
    }
  });

  router.handle("skillhub/delete", async (p, _notify, ctx) => {
    requireAuthedUser(ctx);
    // Non-null because requireAuthedUser guarantees userId !== null.
    const actor = actorIdentity(ctx)!;
    const { id } = extract<{ id: string }>(p, ["id"]);
    const existing = await app.skillHub.getById(id);
    if (!existing || !isVisibleTo(ctx, existing)) {
      throw new RpcError(`skill '${id}' not found`, ErrorCodes.NOT_FOUND);
    }
    if (!canMutate(ctx, existing)) {
      throw new RpcError(`not permitted to delete skill '${existing.id}'`, ErrorCodes.FORBIDDEN);
    }
    const ok = await app.skillHub.softDelete(id, actor);
    return { ok };
  });

  router.handle("skillhub/search", async (p, _notify, ctx) => {
    requireAuthedUser(ctx);
    const { query } = extract<{ query: string }>(p, ["query"]);
    // For v1 we substring-match in JS on top of the visibility-filtered
    // result. Typical tenant skill counts are <100; a tighter SQL LIKE
    // is a future optimization when populations grow.
    const all = await app.skillHub.listVisibleTo(ctx.scopingUserId, ctx.tenantId, ctx.teamChain);
    const needle = query.toLowerCase();
    const skills = all.filter(
      (s) =>
        s.name.toLowerCase().includes(needle) ||
        s.description.toLowerCase().includes(needle) ||
        s.tags.some((t) => t.toLowerCase().includes(needle)),
    );
    return { skills };
  });

  router.handle("skillhub/published_after", async (p, _notify, ctx) => {
    requireAuthedUser(ctx);
    const { since } = extract<{ since: string }>(p, ["since"]);
    // ISO-8601 string compare works because updated_at is stored as ISO
    // (lexicographic order == temporal order for that format).
    // Sort newest-first - this is a "discovery feed" surface, callers
    // (CLI sync banner, dashboard "what's new" widget) want the freshest
    // skills surfaced first, not name-order from listVisibleTo.
    const all = await app.skillHub.listVisibleTo(ctx.scopingUserId, ctx.tenantId, ctx.teamChain);
    const skills = all.filter((s) => s.updated_at >= since).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return { skills };
  });

  router.handle("admin/skillhub/list", async (_p, _notify, ctx) => {
    requireAuthedUser(ctx);
    if (!ctx.isAdmin) {
      throw new RpcError("admin/skillhub/list requires admin role", ErrorCodes.FORBIDDEN);
    }
    // Admin sees every team-scope and tenant-scope row in their tenant,
    // regardless of team-chain membership. User-scope rows are excluded
    // (their tenant_id is NULL by the consultant pattern).
    const skills = await app.skillHub.listAllInTenant(ctx.tenantId);
    return { skills };
  });

  router.handle("admin/skillhub/version_history", async (p, _notify, ctx) => {
    requireAuthedUser(ctx);
    if (!ctx.isAdmin) {
      throw new RpcError("admin/skillhub/version_history requires admin role", ErrorCodes.FORBIDDEN);
    }
    const { skill_id } = extract<{ skill_id: string }>(p, ["skill_id"]);
    // Enforce tenant isolation: refuse to return history for a skill
    // outside the admin's tenant. Mirrors admin/skillhub/list's scope -
    // user-scope skills (tenant_id NULL) are also refused since they
    // follow the user across tenants per the consultant pattern.
    const skill = await app.skillHub.getById(skill_id);
    if (!skill || skill.tenant_id !== ctx.tenantId) {
      throw new RpcError(`skill '${skill_id}' not found in tenant '${ctx.tenantId}'`, ErrorCodes.NOT_FOUND);
    }
    const versions = await app.skillVersions.listBySkill(skill_id);
    return { versions };
  });
}
