/**
 * Wire types for the `skillhub/*` RPC surface. Shared between client
 * (CLI, future dashboard) and server (conductor handlers).
 *
 * Field names mirror the server's snake_case row shape exactly: the
 * conductor returns `SkillRow` directly on the wire, and we match
 * that. The protocol layer can't depend on `packages/core` (would
 * invert the layering), so this file is the type contract instead.
 * Drift between this and `packages/core/repositories/skills.ts:SkillRow`
 * would be caught the first time a real server response failed to
 * deserialize - but the shapes are kept identical by intent.
 */

export type SkillhubVisibility = "user" | "team" | "tenant" | "cross_tenant";

export interface SkillhubSupportingFile {
  path: string;
  content: string;
}

export interface SkillhubSkill {
  id: string;
  tenant_id: string | null;
  team_id: string | null;
  owner_user_id: string | null;
  visibility: SkillhubVisibility;
  name: string;
  description: string;
  body: string;
  category: string | null;
  tags: string[];
  supporting_files: SkillhubSupportingFile[];
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

// ── RPC result shapes ─────────────────────────────────────────────────────

export interface SkillhubListResult {
  skills: SkillhubSkill[];
}

export interface SkillhubGetResult {
  skill: SkillhubSkill;
}

export interface SkillhubPutResult {
  skill: SkillhubSkill;
  /** True when the put produced a NEW skill_versions row (body changed or a revert). */
  version_written: boolean;
}

export interface SkillhubDeleteResult {
  ok: boolean;
}

// ── RPC request payloads ──────────────────────────────────────────────────

// ── skillhub/sync_status ──────────────────────────────────────────────────

export type SkillhubServerSyncStatus = "up-to-date" | "server-changed" | "unknown" | "not-found";

export interface SkillhubSyncStatusLocalVersion {
  skill_id: string;
  /** Omit / null when no sidecar exists for this skill (fresh clone). */
  local_hash?: string | null;
}

export interface SkillhubSyncStatusEntry {
  skill_id: string;
  status: SkillhubServerSyncStatus;
  /** null for `not-found` (server doesn't know the skill anymore). */
  server_hash: string | null;
}

export interface SkillhubSyncStatusResult {
  results: SkillhubSyncStatusEntry[];
}

// ── skillhub/get_with_ancestor ────────────────────────────────────────────

export interface SkillhubGetWithAncestorParams {
  skill_id: string;
  /** Omit when no sidecar exists; server returns current-only (2-way merge path). */
  ancestor_hash?: string;
}

export interface SkillhubGetWithAncestorResult {
  /**
   * Skill metadata as currently stored on the server. The CLI needs
   * these to call `adapter.render()` for fast-forward-pull or merge-
   * accept writes (the renderer puts `description` into the SKILL.md
   * frontmatter; an empty value produces a SKILL.md that subsequent
   * `adapter.parse()` calls reject).
   */
  server_name: string;
  server_description: string;
  server_category: string | null;
  server_tags: string[];
  server_body: string;
  server_supporting_files: SkillhubSupportingFile[];
  server_hash: string;
  server_harness_hints: Record<string, Record<string, unknown>>;
  /** Present only when `ancestor_hash` was supplied and the version row was found. */
  ancestor_body?: string;
  ancestor_supporting_files?: SkillhubSupportingFile[];
  ancestor_hash?: string;
}

// ── skillhub/put ──────────────────────────────────────────────────────────

export interface SkillhubPutParams {
  /** Omit / null for create; present for update. */
  skill_id?: string;
  harness: string;
  body: string;
  supporting_files?: SkillhubSupportingFile[];
  harness_hints?: Record<string, Record<string, unknown>>;
  /** Required for non-force updates; ignored in create. */
  expected_current_hash?: string;
  /** Required in create mode; rejected as a change in update mode (v1). */
  visibility?: SkillhubVisibility;
  team_id?: string;
  name?: string;
  description?: string;
  tags?: string[];
  category?: string | null;
  /** Update-mode bypass for the CAS. Per-visibility gates still apply. */
  force?: boolean;
  /**
   * Optional opaque audit blob attached when this put is the result of
   * an accepted client-side 3-way merge (RFC §7). Persisted onto
   * `skill_versions.merge_input_json` for provenance.
   */
  merge_input?: Record<string, unknown>;
}
