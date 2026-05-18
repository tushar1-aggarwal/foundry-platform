/**
 * SkillRepository + SkillVersionRepository -- drizzle-backed adapters for
 * Skill Hub (docs/skillhub-rfc.md §3, §11 steps 3-4).
 *
 * `skills` is the live registry. `skill_versions` is the append-only
 * history table that backs the 3-way merge ancestor lookup. Every
 * `put` that changes the body writes a new version row BEFORE updating
 * `skills.current_hash`, in the same transaction. That ordering is the
 * lookup invariant that lets `skill/get_with_ancestor` always find the
 * row pointed at by any past `current_hash`.
 *
 * Visibility is one of `user` | `team` | `tenant` | `cross_tenant`.
 * The visibility/scoping-column shape is enforced by a DB-level CHECK
 * constraint (`ck_skills_visibility_scope`, migration 022) so callers
 * can't construct an inconsistent shape (e.g. `user`-scope with a
 * `team_id`). User-scope rows carry `tenant_id=NULL` so a user in
 * multiple tenants sees their personal skills regardless of session
 * context (the consultant pattern). `cross_tenant` is reserved for a
 * future system-admin promotion flow; rejected by skillhub/put in v1
 * (avoided the literal word "public" since that reads as
 * "internet-public" and was deemed a foot-gun).
 *
 * Public-shape types use snake_case column names (matching the public
 * surface contract used by handlers); internal drizzle-select types
 * use camelCase. `toPublic()` bridges them.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { randomBytes } from "crypto";
import { now } from "../util/time.js";
import { extractChanges } from "./tenants.js";
import { logError } from "../observability/structured-log.js";
import { hashCanonicalBundle, type CanonicalBundle, type SupportingFile } from "../skills/hash.js";

/**
 * Thrown by `SkillRepository.put()` in update mode when the compare-and-set
 * on `expected_current_hash` matches zero rows — either because the skill
 * was concurrently modified (someone else's put landed between the
 * handler's read and our write) or because it was soft-deleted in the
 * same window. Handler should map this to an HTTP 409 with a "run sync
 * to reconcile" hint, per the RFC §4 RPC table.
 */
export class SkillVersionConflictError extends Error {
  readonly skillId: string;
  readonly expectedCurrentHash: string;
  constructor(skillId: string, expectedCurrentHash: string) {
    super(`skill ${skillId}: expected current_hash ${expectedCurrentHash} no longer matches`);
    this.name = "SkillVersionConflictError";
    this.skillId = skillId;
    this.expectedCurrentHash = expectedCurrentHash;
  }
}

export type SkillVisibility = "user" | "team" | "tenant" | "cross_tenant";

// ── Public types ──────────────────────────────────────────────────────────

export interface SkillRow {
  id: string;
  tenant_id: string | null;
  team_id: string | null;
  owner_user_id: string | null;
  visibility: SkillVisibility;
  name: string;
  description: string;
  body: string;
  category: string | null;
  tags: string[];
  supporting_files: SupportingFile[];
  harness_hints: Record<string, Record<string, unknown>>;
  current_hash: string;
  upstream_id: string | null;
  created_by: string;
  updated_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillVersionRow {
  id: string;
  skill_id: string;
  version_hash: string;
  body: string;
  /**
   * Bundle snapshot of supporting files at this version. version_hash is
   * sha256 of the full canonical bundle ({body, supporting_files}), so the
   * row must persist both halves to be self-consistent. Used by
   * `skill/get_with_ancestor` to return ancestor bodies AND supporting files
   * for the 3-way merge.
   */
  supporting_files: SupportingFile[];
  changed_by: string;
  changed_at: string;
  /**
   * Set when this version was produced by an LLM-assisted merge.
   * See §7 of the RFC for the shape; null for direct edits.
   */
  merge_input_json: Record<string, unknown> | null;
}

/**
 * Inputs to `SkillRepository.put()`. `skill_id` absent = create mode.
 * Visibility / scope columns must agree with the DB CHECK constraint;
 * the repo doesn't re-validate that invariant (the DB rejects bad
 * shapes), but callers should obey it.
 */
export interface PutInput {
  skill_id?: string | null;
  /**
   * In UPDATE mode (skill_id present), this is the value of `current_hash`
   * the caller last observed. The repo's UPDATE uses compare-and-set on
   * this — if the DB's `current_hash` no longer matches, the update fails
   * with `SkillVersionConflictError` (zero rows affected). REQUIRED for
   * update mode; pass null/undefined for create mode.
   */
  expected_current_hash?: string | null;
  tenant_id: string | null;
  team_id: string | null;
  owner_user_id: string | null;
  visibility: SkillVisibility;
  name: string;
  description: string;
  /** Canonical (post-normalizer) body. The repo does NOT normalize. */
  body: string;
  /** Canonical (post-normalizer) supporting files. */
  supporting_files: SupportingFile[];
  category: string | null;
  tags: string[];
  /** Full harness_hints map, including any `original_body` preserved by the handler. */
  harness_hints: Record<string, Record<string, unknown>>;
  actor: string;
  /**
   * Optional merge-provenance blob written onto the new skill_versions row
   * when this put is the application of an accepted LLM merge.
   */
  merge_input?: Record<string, unknown>;
}

export interface PutResult {
  skill: SkillRow;
  /**
   * `true` when a new `skill_versions` row was inserted (i.e. the
   * canonical bundle — body OR supporting_files — actually changed).
   * `false` when the bundle's hash matches the existing current_hash
   * and only metadata fields (name/description/tags/etc.) were updated.
   */
  versionWritten: boolean;
}

// ── Internal drizzle-select shape ─────────────────────────────────────────

type DrizzleSelectSkill = {
  id: string;
  tenantId: string | null;
  teamId: string | null;
  ownerUserId: string | null;
  visibility: string;
  name: string;
  description: string;
  body: string;
  category: string | null;
  tags: string;
  supportingFilesJson: string;
  harnessHintsJson: string;
  currentHash: string;
  upstreamId: string | null;
  createdBy: string;
  updatedBy: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type DrizzleSelectSkillVersion = {
  id: string;
  skillId: string;
  versionHash: string;
  body: string;
  supportingFilesJson: string;
  changedBy: string;
  changedAt: string;
  mergeInputJson: string | null;
};

/**
 * Parse a JSON-encoded TEXT column, falling back if the blob is null,
 * empty, or malformed. Logs malformed-JSON cases so a corrupt column
 * leaves a trail instead of silently coercing to the fallback.
 */
function parseJson<T>(blob: string | null, fallback: T, columnName: string, rowId?: string): T {
  if (blob == null || blob === "") return fallback;
  try {
    return JSON.parse(blob) as T;
  } catch (err) {
    logError(
      "skills",
      `failed to parse ${columnName}${rowId ? ` for row ${rowId}` : ""}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fallback;
  }
}

function skillToPublic(row: DrizzleSelectSkill): SkillRow {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    team_id: row.teamId,
    owner_user_id: row.ownerUserId,
    visibility: row.visibility as SkillVisibility,
    name: row.name,
    description: row.description,
    body: row.body,
    category: row.category,
    tags: parseJson<string[]>(row.tags, [], "tags", row.id),
    supporting_files: parseJson<SupportingFile[]>(row.supportingFilesJson, [], "supporting_files_json", row.id),
    harness_hints: parseJson<Record<string, Record<string, unknown>>>(
      row.harnessHintsJson,
      {},
      "harness_hints_json",
      row.id,
    ),
    current_hash: row.currentHash,
    upstream_id: row.upstreamId,
    created_by: row.createdBy,
    updated_by: row.updatedBy,
    deleted_at: row.deletedAt,
    deleted_by: row.deletedBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function versionToPublic(row: DrizzleSelectSkillVersion): SkillVersionRow {
  return {
    id: row.id,
    skill_id: row.skillId,
    version_hash: row.versionHash,
    body: row.body,
    supporting_files: parseJson<SupportingFile[]>(row.supportingFilesJson, [], "supporting_files_json", row.id),
    changed_by: row.changedBy,
    changed_at: row.changedAt,
    merge_input_json: parseJson<Record<string, unknown> | null>(row.mergeInputJson, null, "merge_input_json", row.id),
  };
}

// ── SkillRepository ───────────────────────────────────────────────────────

export class SkillRepository {
  private _d: DrizzleClient | null = null;

  constructor(private db: DatabaseAdapter) {}

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  /**
   * Fetch one live skill by id. Returns null if missing or soft-deleted.
   *
   * NOTE: this is the raw by-id lookup — it does NOT enforce
   * visibility-based access control. Callers serving user-facing
   * requests should use `listVisibleTo` (which filters by visibility +
   * tenant + team-chain) and/or apply a visibility check at the handler
   * layer. `getById` is used internally — e.g. by `put()` to refetch
   * after a write — where bypassing visibility is correct.
   */
  async getById(id: string): Promise<SkillRow | null> {
    const d = this.d();
    const s = d.schema.skills;
    const rows = await (d.db as any)
      .select()
      .from(s)
      .where(and(eq(s.id, id), isNull(s.deletedAt)))
      .limit(1);
    const row = (rows as DrizzleSelectSkill[])[0];
    return row ? skillToPublic(row) : null;
  }

  /**
   * Visibility-aware listing. Returns the union of:
   *   - user-scope rows owned by `userId` (tenant-agnostic — consultant pattern)
   *   - team-scope rows in any team in `teamChain` (the caller's team-chain, derived from auth)
   *   - tenant-scope rows for `tenantId`
   * Public-scope rows are NOT returned in v1 (unreachable per Q1).
   *
   * `teamChain` is the list of team ids the caller belongs to (and their
   * ancestor chain via teams.parent_team_id). Empty array = no team
   * memberships; the caller still sees their own user-scope skills and
   * any tenant-scope rows in `tenantId`.
   *
   * `userId` is the caller's real `u-*` user id (typically
   * `ctx.scopingUserId`). Pass `null` for service api-key callers with no
   * bound user; the user-scope branch is then omitted entirely (a service
   * key has no human owner and so no user-scope skills to surface).
   */
  async listVisibleTo(userId: string | null, tenantId: string, teamChain: string[]): Promise<SkillRow[]> {
    const d = this.d();
    const s = d.schema.skills;
    // Build the visibility-union predicate. Each branch carries its own
    // soft-delete filter so the optimizer can short-circuit.
    const tenantBranch = and(eq(s.visibility, "tenant"), eq(s.tenantId, tenantId), isNull(s.deletedAt));
    const branches = [tenantBranch];
    if (userId) {
      branches.push(and(eq(s.visibility, "user"), eq(s.ownerUserId, userId), isNull(s.deletedAt)));
    }
    if (teamChain.length > 0) {
      // Defense-in-depth: the team-scope branch ALSO filters by
      // tenantId. Even if a buggy caller passes a teamChain containing
      // teams from another tenant (e.g. a stale chain from a different
      // session), the repo refuses to leak skills across tenants. The
      // teams.tenant_id column itself binds each team to one tenant;
      // this filter just makes that binding explicit at query time.
      // Matches the strict-isolation decision in RFC §9 Q1.
      branches.push(
        and(eq(s.visibility, "team"), inArray(s.teamId, teamChain), eq(s.tenantId, tenantId), isNull(s.deletedAt)),
      );
    }
    const rows = await (d.db as any)
      .select()
      .from(s)
      .where(or(...branches))
      .orderBy(asc(s.name));
    return (rows as DrizzleSelectSkill[]).map(skillToPublic);
  }

  /**
   * Admin-tier listing: every team-scope and tenant-scope row in
   * `tenantId`, regardless of team-chain. Excludes user-scope rows
   * (their `tenant_id` is NULL by the consultant pattern — they are not
   * "in" any tenant; an admin wanting a user's personal skills would
   * have a different surface).
   *
   * Used by `admin/skillhub/list`. Caller must have already checked
   * the admin gate; this repo method enforces only the tenant filter.
   */
  async listAllInTenant(tenantId: string): Promise<SkillRow[]> {
    const d = this.d();
    const s = d.schema.skills;
    const rows = await (d.db as any)
      .select()
      .from(s)
      .where(and(eq(s.tenantId, tenantId), isNull(s.deletedAt)))
      .orderBy(asc(s.name));
    return (rows as DrizzleSelectSkill[]).map(skillToPublic);
  }

  /**
   * Create or update a skill, atomically with a `skill_versions` row.
   *
   * Create mode: `skill_id` absent/null. Server generates `skl-<hex>`.
   * Update mode: `skill_id` present. Caller must have already checked
   * `expected_current_hash` at the handler layer (this repo doesn't
   * enforce optimistic locking — that lives in the handler so callers
   * can choose whether to bypass via `force`).
   *
   * Version row insert + skills row write happen in one transaction.
   * On body-unchanged updates (only metadata fields differ), no
   * skill_versions row is written and `versionWritten` is false.
   */
  async put(input: PutInput): Promise<PutResult> {
    const ts = now();
    const canonical: CanonicalBundle = {
      body: input.body,
      supporting_files: input.supporting_files,
    };
    const newHash = hashCanonicalBundle(canonical);

    return this.db.transaction(async () => {
      const d = this.d();
      const s = d.schema.skills;
      const v = d.schema.skillVersions;

      const isCreate = !input.skill_id;
      const skillId = isCreate ? `skl-${randomBytes(6).toString("hex")}` : (input.skill_id as string);

      // Common drizzle "values" for the skill row.
      const skillValues = {
        id: skillId,
        tenantId: input.tenant_id,
        teamId: input.team_id,
        ownerUserId: input.owner_user_id,
        visibility: input.visibility,
        name: input.name,
        description: input.description,
        body: input.body,
        category: input.category,
        tags: JSON.stringify(input.tags),
        supportingFilesJson: JSON.stringify(input.supporting_files),
        harnessHintsJson: JSON.stringify(input.harness_hints),
        currentHash: newHash,
        createdBy: input.actor,
        createdAt: ts,
        updatedAt: ts,
      };

      let versionWritten = false;

      if (isCreate) {
        // Brand new skill: skills row first, then the matching version row.
        // (skill_versions.skill_id FKs to skills.id, so the skills row has
        // to exist before we can insert the version.) The lookup invariant
        // — every live skills.current_hash has a matching skill_versions
        // row — still holds: both writes happen in the same transaction,
        // and no concurrent reader can observe the intermediate state.
        await (d.db as any).insert(s).values(skillValues);
        await (d.db as any).insert(v).values({
          id: `sv-${randomBytes(6).toString("hex")}`,
          skillId,
          versionHash: newHash,
          body: input.body,
          supportingFilesJson: JSON.stringify(input.supporting_files),
          changedBy: input.actor,
          changedAt: ts,
          mergeInputJson: input.merge_input ? JSON.stringify(input.merge_input) : null,
        });
        versionWritten = true;
      } else {
        // Update existing skill. We use compare-and-set on
        // `current_hash` so two concurrent writers can't both succeed
        // and silently drop one's body. The handler is expected to do
        // its own optimistic-lock check for a faster failure path with
        // a clearer error message; the repo's CAS is the final safety
        // net against the read-modify-write race on Postgres.
        const expectedHash = input.expected_current_hash;
        if (!expectedHash) {
          throw new Error(`expected_current_hash is required when skill_id is provided (update mode): ${skillId}`);
        }
        const bundleChanged = expectedHash !== newHash;

        // Compare-and-set on the skills row. Doing the UPDATE BEFORE
        // the skill_versions insert means a "skill missing" or
        // "concurrently overwritten" case fails the CAS cleanly (zero
        // rows affected → throw conflict) without first trying to
        // insert a skill_versions row whose FK to skills.id would
        // throw an opaque constraint error. The lookup invariant
        // (every committed skills.current_hash has a matching
        // skill_versions row) still holds because both writes commit
        // atomically within this transaction — no external observer
        // can see the intermediate state where UPDATE has landed but
        // INSERT hasn't yet.
        const updateResult = await (d.db as any)
          .update(s)
          .set({
            tenantId: input.tenant_id,
            teamId: input.team_id,
            ownerUserId: input.owner_user_id,
            visibility: input.visibility,
            name: input.name,
            description: input.description,
            body: input.body,
            category: input.category,
            tags: JSON.stringify(input.tags),
            supportingFilesJson: JSON.stringify(input.supporting_files),
            harnessHintsJson: JSON.stringify(input.harness_hints),
            currentHash: newHash,
            updatedBy: input.actor,
            updatedAt: ts,
          })
          .where(and(eq(s.id, skillId), eq(s.currentHash, expectedHash), isNull(s.deletedAt)));
        if (extractChanges(updateResult) === 0) {
          // Either the skill doesn't exist, was soft-deleted, or
          // somebody else's put landed first. From the caller's
          // perspective these are all conflict-class outcomes.
          throw new SkillVersionConflictError(skillId, expectedHash);
        }
        if (bundleChanged) {
          // ON CONFLICT DO NOTHING handles the revert-to-prior-body case:
          // user edits B1 → B2 → back to B1. newHash matches the H1 row
          // already in skill_versions from the original B1 put. The CAS
          // UPDATE above succeeds (current was H2); the INSERT here would
          // otherwise hit the (skill_id, version_hash) UNIQUE index and
          // throw an opaque constraint violation, rolling back the whole
          // transaction. Instead we let the row stay as-is — the lookup
          // invariant ("every live current_hash resolves to a
          // skill_versions row") only requires the row to be PRESENT,
          // not freshly inserted. The original H1 row's merge_input_json
          // / changed_by / changed_at stay correct for when the body was
          // FIRST authored, which is the honest answer for a revert.
          //
          // rowsAffected tells us whether we actually wrote a new row or
          // pointed at an existing one. That feeds `versionWritten` so
          // callers (and tests) can distinguish a real new version from
          // a revert.
          const insertResult = await (d.db as any)
            .insert(v)
            .values({
              id: `sv-${randomBytes(6).toString("hex")}`,
              skillId,
              versionHash: newHash,
              body: input.body,
              supportingFilesJson: JSON.stringify(input.supporting_files),
              changedBy: input.actor,
              changedAt: ts,
              mergeInputJson: input.merge_input ? JSON.stringify(input.merge_input) : null,
            })
            .onConflictDoNothing();
          versionWritten = extractChanges(insertResult) > 0;
        }
      }

      const fresh = await this.getById(skillId);
      if (!fresh) throw new Error(`skill missing after put: ${skillId}`);
      return { skill: fresh, versionWritten };
    });
  }

  /**
   * Soft-delete a skill.
   *
   * Returns `true` if a live row was transitioned to deleted, `false`
   * if the row is already soft-deleted or missing. The operation is
   * idempotent (calling on an already-deleted row is safe and does not
   * throw); the boolean return reflects rows-affected semantics so
   * callers can tell whether the call did real work or was a no-op.
   */
  async softDelete(id: string, deletedBy: string): Promise<boolean> {
    const d = this.d();
    const s = d.schema.skills;
    const ts = now();
    const res = await (d.db as any)
      .update(s)
      .set({ deletedAt: ts, deletedBy, updatedAt: ts })
      .where(and(eq(s.id, id), isNull(s.deletedAt)));
    return extractChanges(res) > 0;
  }
}

// ── SkillVersionRepository ────────────────────────────────────────────────

export class SkillVersionRepository {
  private _d: DrizzleClient | null = null;

  constructor(private db: DatabaseAdapter) {}

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  /**
   * Lookup the body associated with a past `(skill_id, version_hash)`.
   * Used by `skill/get_with_ancestor` to return the 3-way merge ancestor.
   * Returns null if the version isn't found (e.g. skill was hard-deleted).
   */
  async getByHash(skillId: string, versionHash: string): Promise<SkillVersionRow | null> {
    const d = this.d();
    const v = d.schema.skillVersions;
    const rows = await (d.db as any)
      .select()
      .from(v)
      .where(and(eq(v.skillId, skillId), eq(v.versionHash, versionHash)))
      .limit(1);
    const row = (rows as DrizzleSelectSkillVersion[])[0];
    return row ? versionToPublic(row) : null;
  }

  /**
   * Per-skill history, newest first. Used by the dashboard audit drawer
   * to show "who/when/what produced each version" with merge provenance.
   */
  async listBySkill(skillId: string): Promise<SkillVersionRow[]> {
    const d = this.d();
    const v = d.schema.skillVersions;
    const rows = await (d.db as any).select().from(v).where(eq(v.skillId, skillId)).orderBy(desc(v.changedAt));
    return (rows as DrizzleSelectSkillVersion[]).map(versionToPublic);
  }
}
