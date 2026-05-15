# Skill Hub: Design RFC

**Status:** Draft for team review
**Author:** Rachna (with Claude)
**Date:** 2026-05-13

---

## 1. Background

### What is a "skill" in Ark today

A skill is a reusable prompt fragment — a YAML file in `skills/` (repo root, builtin), `~/.ark/skills/` (per-machine global), or `<repo>/.ark/skills/` (project-local). Schema is minimal: `{ name, description, prompt, tags }` — see `packages/core/agent/skill.ts`.

The 7 builtin skills (`code-review.yaml`, `security-scan.yaml`, etc.) are checked into the Ark repo. There is no central registry, no tenant scoping, no sharing across users.

### Two skill flavors, two formats, two lifecycles — don't confuse them

Skill Hub deliberately uses a **different on-disk format** from the builtin skills described above. This catches new users off guard, so it's worth stating up-front:

| | **Ark builtin skills** | **Skill Hub skills** (this RFC) |
|---|---|---|
| File | `skills/<name>.yaml` (flat YAML; entire prompt is a `\|`-block string) | `<repo>/.claude/skills/<name>/SKILL.md` (YAML frontmatter wrapped in `---` markers + markdown body) |
| Loaded by | `FileSkillStore` (`app.skills`) — injected into the **Ark agent's** session context at dispatch time | **Claude Code / Cursor / Codex** — the harness reads the file off disk directly at agent runtime |
| Scope | Builtin in the Ark repo; available to every tenant unconditionally; no auth, no audit | Tenant-scoped registry with `user` / `team` / `tenant` visibility; audited via `skill_versions`; versioned with 3-way merge |
| CLI | `ark skill` (singular) / RPCs under `skill/*` | `ark skills` (plural) / RPCs under `skillhub/*` |
| Tags | YAML key `tags: [...]` inside the file | `--tag` flag at upload time (`ark skills put <dir> --tag review`); server-side metadata |
| Prompt content | YAML `prompt: \|` block | Markdown body after the closing `---` |

Why two formats: Skill Hub's design center is that **the file Claude Code (or Cursor / Codex) reads from disk IS the canonical skill bundle**. Those harnesses have converged on the `SKILL.md` open standard (RFC §6). If Skill Hub used the builtin YAML format, every consumer would have to convert before the harness could read it. The builtin YAML predates Skill Hub and was authored before Claude Code's `SKILL.md` standard existed — it stays alongside Skill Hub as Ark-internal infrastructure for the dispatch path, never written to disk.

A skill file authored in the builtin format (`prompt: |` block, no `---` markers) won't validate through `ark skills put`. The `prompt:` content moves to the markdown body (everything after the closing `---`), and tags become a `--tag` flag at upload time. Consolidating the two flavors under a unified surface (one CLI verb, one storage backend, one format) is deferred to a follow-up PR.

### Requirements

The Skill Hub feature needs to deliver:

- **Central registry** with per-user, per-team, and per-tenant scoping. Skills get stored once, shared across teams and users by visibility rules. Builds on the auth model shipped in PR #568 (user / team / tenant + scoping overrides + Bearer-token auth).
- **Repo-aware sync.** A developer runs a single command in their project repo; the tool detects which AI tool the repo uses (Claude Code, Cursor, etc.) and pulls down all skills visible to them in the matching format.
- **Diff and reconcile.** When a local skill diverges from the central registry (both sides edited concurrently since the last sync), the tool detects the divergence and offers an LLM-assisted 3-way merge — using the common-ancestor version held server-side — instead of silently overwriting either side.
- **Discovery.** New or updated skills published in the user's scope surface as a notification on next sync (or via dashboard).
- **CRUD is table stakes.** The core value of Skill Hub is the smart layer above CRUD (sync, adapt, reconcile, discover) — not the database operations themselves. Plain `list/get/put/delete` are a means to the end, not the deliverable.

### Architectural anchors

1. **Skills live in the developer's repo at consumption time** — `.claude/skills/<name>/SKILL.md` for Claude Code, `.cursor/skills/<name>/SKILL.md` for Cursor, `.codex/skills/<name>/SKILL.md` for Codex, or `.agents/skills/<name>/SKILL.md` for the Agent Skills open standard. Same `SKILL.md` directory format across all of them; only the parent path differs.
2. **Central registry stores a canonical (harness-agnostic) form.** Adapters render that into harness-specific files on `ark skills install` / `ark skills sync`. The target harness can be (a) inferred via the detection cascade (§5), (b) overridden explicitly via `--harness <h>` on the command, or (c) pinned via `<repo>/.ark/config.yaml`.
3. **CLI is the primary surface.** Developers interact via `ark skills *` commands running in their repos.
4. **Auth model from PR #568 is the foundation.** User / team / tenant scoping + Bearer-token auth, mint-via-dashboard today.
5. **The Foundry (Python) CLI is planned to eventually subsume the Ark CLI** under a unified `foundry` command surface. That work stream is independent of Skill Hub; Skill Hub ships first under `ark skills *` and gets renamed `foundry skills *` when the broader CLI convergence lands.

---

## 2. High-level architecture

```
                                ┌──────────────────────────────────┐
                                │ Ark backend (daemon)              │
                                │ ───────────                       │
                                │ skills table (canonical format)   │
                                │   id, tenant_id, team_id?,        │
                                │   owner_user_id?, visibility,     │
                                │   name, description, body, ...    │
                                │ skillhub/* RPCs (visibility-aware)│
                                └─────────────┬────────────────────┘
                                              │
                              HTTPS + Bearer (today: paste from dashboard;
                              future: `ark login` device flow)
                                              │
   ┌──────────────────────────┐    ┌──────────▼──────────────────────┐
   │ ark CLI (extended)       │    │ Server-side RPC                  │
   │ ──────────────           │◀──▶│   skillhub/list                     │
   │ ark skills list          │    │   skillhub/get                      │
   │ ark skills get <id>      │    │   skillhub/sync_status              │
   │ ark skills put <path>    │    │   skillhub/get_with_ancestor        │
   │ ark skills sync          │    │   skillhub/put (optimistic lock,    │
   │ ark skills install \     │    │     accepts merge_input audit blob) │
   │   --harness <claude|...> │    │   skillhub/delete                   │
   │                          │    │   skillhub/search                   │
   │ + linked claude-agent SDK│    │   skillhub/published_after          │
   │   for client-side 3-way  │    │   admin/skillhub/list               │
   │   merge on `sync` (§7)   │    │                                     │
   └──────────┬───────────────┘    └──────────────────────────────────┘
              │ pluggable adapter registry (one per harness):
              │   render(canonical) → WrittenFile[]   (SKILL.md + supporting files)
              │   parse(skillDir)   → CanonicalSkill
              ▼
   ┌────────────────────────────────────────────┐
   │ Developer's repo (detected at sync)        │
   │   .claude/skills/<name>/SKILL.md           │
   │   .cursor/skills/<name>/SKILL.md           │
   │   .codex/skills/<name>/SKILL.md            │
   │   .agents/skills/<name>/SKILL.md           │
   │   (custom paths via <repo>/.ark/config.yaml)│
   └────────────────────────────────────────────┘
```

Three layers, top to bottom:

1. **Backend** — central registry. New `skills` table + RPCs gated by `requireSameTenant` (per the PR #568 pattern).
2. **CLI** — runs in any directory; talks to the backend over HTTPS+Bearer. New `ark skills` subcommands.
3. **Adapter layer** — pure functions that convert between the canonical record and harness-specific files. Lives in the CLI for now; no backend involvement.

---

## 3. Schema

```ts
// packages/core/drizzle/schema/{sqlite,postgres}.ts
export const skills = sqliteTable(
  "skills",
  {
    id: text("id").primaryKey(),                              // skl-<12 hex>

    // Scoping (mirrors memberships + scoping_overrides, with one exception:
    // tenant_id is NULLABLE for user-visibility skills — see "Consultant pattern" note below).
    tenantId: text("tenant_id")
      .references(() => tenants.id, { onDelete: "cascade" }),  // NULL for visibility='user' (skill is global to the user across tenants); NOT NULL otherwise
    teamId: text("team_id")
      .references(() => teams.id, { onDelete: "cascade" }),    // null for tenant-scope and user-scope
    ownerUserId: text("owner_user_id")
      .references(() => users.id, { onDelete: "cascade" }),    // null for team/tenant-scope; NOT NULL for user-scope
    visibility: text("visibility").notNull(),                  // "user" | "team" | "tenant" | "cross_tenant" (cross_tenant gated to future system-admin; named distinctly from "public" so the enum doesn't read as internet-public)

    // Canonical content (harness-agnostic; matches the Agent Skills open standard)
    name: text("name").notNull(),                              // e.g. "code-review"
    description: text("description").notNull(),               // single-line
    body: text("body").notNull(),                              // markdown body of SKILL.md
    category: text("category"),                                // optional, for dashboard grouping
    tags: text("tags").notNull().default("[]"),                // JSON array of strings

    // Supporting files (multi-file skills). Most real-world skills shipped by
    // harness vendors include subdirectories like `scripts/`, `references/`,
    // `assets/`. The canonical record stores all of them.
    supportingFilesJson: text("supporting_files_json").notNull().default("[]"),
      // Shape: [ { "path": "references/spec.md", "content": "..." },
      //          { "path": "scripts/run.py",     "content": "..." } ]
      // Paths are relative to the skill's directory; SKILL.md itself is NOT
      // stored here (it's the `body` field).

    // Harness-specific hints. Used by adapters to preserve fields one
    // harness understands that others don't, so round-tripping doesn't lose
    // data. Examples of real fields: Claude's `disable-model-invocation`,
    // `allowed-tools`, `paths`, `arguments`; Codex's agent-specific config.
    harnessHintsJson: text("harness_hints_json").notNull().default("{}"),
      // Shape: { "claude": { "disable-model-invocation": true, "paths": ["**/*.py"] },
      //          "cursor": { "paths": ["**/*.py"] } }

    // Provenance (used by sync + merge flows)
    currentHash: text("current_hash").notNull(),               // sha256 of the canonical bundle (see §7 "Hash semantics"); lookup invariant — every skills.current_hash has a matching skill_versions row with the same skill_id + version_hash (enforced by transaction order in skillhub/put, NOT an FK constraint since drizzle FKs are single-column)
    upstreamId: text("upstream_id"),                           // skl-* of the parent if cloned

    // Audit (mirrors memberships pattern)
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by"),
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    // Name is unique within its scope target. Three partial indices — one per
    // visibility — so a user's "code-review" doesn't collide with their team's.
    idxUniqUser: uniqueIndex("idx_skills_user_name_live")
      .on(t.ownerUserId, t.name)
      .where(sql`${t.deletedAt} IS NULL AND ${t.visibility} = 'user'`),
    idxUniqTeam: uniqueIndex("idx_skills_team_name_live")
      .on(t.teamId, t.name)
      .where(sql`${t.deletedAt} IS NULL AND ${t.visibility} = 'team'`),
    idxUniqTenant: uniqueIndex("idx_skills_tenant_name_live")
      .on(t.tenantId, t.name)
      .where(sql`${t.deletedAt} IS NULL AND ${t.visibility} = 'tenant' AND ${t.teamId} IS NULL AND ${t.ownerUserId} IS NULL`),

    idxTenant: index("idx_skills_tenant").on(t.tenantId),
    idxTenantCategory: index("idx_skills_tenant_category").on(t.tenantId, t.category),
    idxOwnerUser: index("idx_skills_owner_user").on(t.ownerUserId),

    // Invariant: visibility determines which scoping columns must be set.
    // - visibility='user'  → tenant_id IS NULL, owner_user_id IS NOT NULL
    // - visibility='team'  → tenant_id IS NOT NULL, team_id IS NOT NULL
    // - visibility='tenant' → tenant_id IS NOT NULL, team_id IS NULL, owner_user_id IS NULL
    // - visibility='cross_tenant' → tenant_id IS NOT NULL (origin tenant), system-admin-promoted only
    visibilityScopeCheck: check(
      "ck_skills_visibility_scope",
      sql`(${t.visibility} = 'user' AND ${t.tenantId} IS NULL AND ${t.ownerUserId} IS NOT NULL)
        OR (${t.visibility} = 'team' AND ${t.tenantId} IS NOT NULL AND ${t.teamId} IS NOT NULL)
        OR (${t.visibility} = 'tenant' AND ${t.tenantId} IS NOT NULL AND ${t.teamId} IS NULL AND ${t.ownerUserId} IS NULL)
        OR (${t.visibility} = 'cross_tenant' AND ${t.tenantId} IS NOT NULL)`,
    ),
  }),
);

// Versioned body history. Every `skillhub/put` that changes `body` writes
// a new row here BEFORE updating the live `skills` row. This is the
// authoritative server-side store of ancestor bodies required by the
// LLM-assisted 3-way merge in §7. (Clients additionally maintain a
// per-skill sidecar pointing at the version hash they last synced —
// that's an optimization for merge quality, not a substitute for this
// server-side history.)
export const skillVersions = sqliteTable(
  "skill_versions",
  {
    id: text("id").primaryKey(),                              // sv-<12 hex>
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    versionHash: text("version_hash").notNull(),              // sha256 of the canonical bundle at this version ({body, supporting_files}, per §7 "Hash semantics")
    body: text("body").notNull(),                             // full body snapshot
    supportingFilesJson: text("supporting_files_json").notNull().default("[]"),
                                                              // bundle snapshot of supporting files at this version; together with `body`,
                                                              // reconstructs the exact canonical bundle that produced `version_hash`.
                                                              // Required for the 3-way merge ancestor side of skillhub/get_with_ancestor.
    changedBy: text("changed_by").notNull(),                  // user id
    changedAt: text("changed_at").notNull(),
    // For merge-resulting versions, capture the inputs and the LLM that produced them.
    // null for direct edits.
    mergeInputJson: text("merge_input_json"),
      // Example: { "ancestor_hash": "...", "mine_hash": "...", "theirs_hash": "...",
      //            "llm_model": "claude-sonnet-4-6", "accepted_by": "u-bob",
      //            "per_file_strategies": { "SKILL.md": "llm",
      //                                     "scripts/run.py": "manual" } }
  },
  (t) => ({
    idxSkillTime: index("idx_skill_versions_skill_time").on(t.skillId, t.changedAt),
    idxSkillHash: uniqueIndex("idx_skill_versions_skill_hash").on(t.skillId, t.versionHash),
  }),
);
```

**Notes:**
- **Naming conventions across the RFC.** Drizzle TS field names are camelCase (`harnessHintsJson`, `currentHash`); the underlying DB columns are snake_case (`harness_hints_json`, `current_hash`); JSON keys on the wire match the DB columns. The doc uses whichever form is natural at the point of mention — all three refer to the same field.
- **Consultant pattern: user-visibility skills are tenant-agnostic.** A user can belong to multiple tenants (the `users` table is global; users get memberships into teams across tenants). For user-visibility skills, the row's `tenant_id` is **NULL**, meaning the skill follows the user across every tenant they work in. Without this, alice's personal `code-review` skill would be locked to whichever tenant she happened to be in when she authored it — and invisible from her other tenants. Team and tenant visibility rows always carry `tenant_id`. The `visibilityScopeCheck` constraint enforces this invariant at the DB level.
- `visibility` enum includes `cross_tenant` as a forward-compat slot but is unreachable today (gated to system-admin, which doesn't exist yet — see Q1 in §9). Named distinctly from "public" so the column doesn't read as "internet-public" — that ambiguity would be a foot-gun for anyone scanning the schema.
- `body` + `supporting_files_json` together represent the entire skill directory. `body` is `SKILL.md`; the array carries every other file in the directory tree (markdown, scripts, assets). Together they round-trip to/from a `<skill-name>/` directory on disk.
- `harness_hints_json` is a free-form JSON blob keyed by harness id. For each harness it preserves:
  - **harness-specific frontmatter** the author included (Claude's `disable-model-invocation`, `allowed-tools`, `paths`, `arguments`, etc.) so the adapter can faithfully restore them when rendering for that harness.
  - **`original_body`** — the author's raw, un-normalized body for that harness (see Q2 decision in §9 and §7 "Normalizer module"). On render to the same harness the author uploaded from, `original_body` is used instead of the canonical `body` so the author sees what they wrote.
  - **`original_supporting_files`** — same idea for the supporting-files array.

  Example shape: `{ "claude": { "disable-model-invocation": true, "allowed-tools": ["Bash(git *)"], "original_body": "...alice's raw $ARGUMENTS[0] version...", "original_supporting_files": [...] } }`.

  **Adapter ids in this map are stable forever** — renaming a harness updates only the human-readable label, never `harnessId`. Replacing a harness goes through a data migration, never an in-place rename.
- **Storage type:** `supporting_files_json` and `harness_hints_json` use `text` on both SQLite and Postgres, matching the existing codebase convention for JSON columns (`scoping_overrides.value_json` is the precedent). A future cleanup PR could switch Postgres to `jsonb` (better operators, indexable) — but that's a codebase-wide convention change, not a Skill Hub deviation.
- **Scaling caveat:** the canonical bundle is stored as a single JSON value per skill row. Typical skills are 5-10 KB; multi-file skills with substantial scripts/references could reach 50-100+ KB. Per-row writes rewrite the whole blob — fine at current scale, watchpoint at 100+ KB skills. `skill_versions` also stores the full bundle per row, multiplying storage by the version count (every edit retains a full snapshot for the 3-way merge ancestor lookup). Migration path if it becomes a problem: split into a side table `skill_files (skill_id, version_hash, path, content)` with per-file update locality — the same migration covers both `skills` and `skill_versions`. Not in v1.
- `current_hash` is the lookup key into `skill_versions` for the current version's body (see "Provenance" comment in the schema). Every `skillhub/put` writes a new `skill_versions` row first, then updates `skills.current_hash` — same transaction. This guarantees the ancestor body for any past version is always retrievable server-side. The relationship is enforced by transaction order, not an FK constraint (drizzle FKs are single-column).
- `skill_versions` is never soft-deleted — even after a skill is hard-deleted, its history rows cascade-delete via the FK.

**Configuration:** Skill Hub extends the existing `scoping_overrides` key space (PR #564) with three new keys, no schema change required. Today's resolver handles them via the same user > team > tenant precedence as the existing keys (`runtime`, `model`, `compute.default`, `flow.allowlist`):

| Key | Effect | Default |
|---|---|---|
| `skill.default_harness` | Default harness when the repo-detection cascade reaches the scoping layer (see §5) | unset → cascade continues to next layer |

`skill.merge_model` and `skill.merge_disabled` were originally proposed for governing a server-side LLM merge; with the merge moved client-side (§7), there's no platform-controlled LLM call to govern. A CLI-only `--no-merge` flag covers the "fall back to manual diff" preference; tenant-wide enforcement isn't reachable in v1 (the CLI runs on user machines and could be bypassed).

The naming convention `<feature>.<setting>` generalizes — future features that need scoped config can reuse the same key-space.

### Visibility model

Every skill has exactly one `visibility` level, determining who can see it via the registry API and who can write to it.

| Level | `tenant_id` | `team_id` | `owner_user_id` | Who can read | Who can write |
|---|---|---|---|---|---|
| `user` | **NULL** | NULL | required | only the owner | only the owner (no admin override) |
| `team` | required | required | NULL | members of that team and any parent team in the chain | admin in the team's tenant |
| `tenant` | required | NULL | NULL | everyone in the tenant | admin in that tenant |
| `cross_tenant` | required (origin tenant) | NULL | NULL | everyone, cross-tenant | system-admin only — **not reachable in v1** (see §9 Q1) |

The DB-level `visibilityScopeCheck` constraint enforces these column combinations — wrong shapes are rejected at write time, before they ever land.

**Two asymmetries worth knowing:**

1. **User-scope skills are tenant-agnostic (consultant pattern).** A user who is a member of multiple tenants creates user-scope skills with `tenant_id=NULL`, so the skill follows them across every tenant they work in. The `requireSameTenant` gate is SKIPPED on reads when the row's `owner_user_id` matches the caller — user-scope rows have no tenant to match against.

2. **Team-scope skills are visible up the team-chain.** A skill in `team-backend` is visible to anyone in `team-backend` AND any parent team (e.g. `org-engineering`). Matches the existing scoping_overrides resolver behavior for `runtime`, `model`, `compute.default`, `flow.allowlist`.

**Registry visibility controls central distribution, NOT filesystem access.**

If a user runs `ark skills put --visibility user` AND also commits the SKILL.md file to a git repo, anyone with repo access has the file on disk regardless of registry visibility. From a collaborator's perspective:

- `ark skills list` does NOT show the skill (registry view, filtered by visibility).
- But Claude Code (or whichever harness they use) reads `.claude/skills/` from the filesystem directly and finds it — so they can invoke `/<skill-name>` and the skill works.

Git is its own distribution channel. The registry is a complementary publishing / versioning / discovery layer. They are independent.

**Practical implication:** if a skill contains sensitive information, registry visibility alone does not protect it from being seen by repo collaborators. Don't commit sensitive skills to shared repos; use `--visibility user` AND `.gitignore` the skill directory.

The same asymmetry applies to future flow-integration work (out of scope per §10): a flow that reads skills from the local filesystem will see whatever's on disk regardless of registry visibility; a flow that fetches via the registry API at runtime will respect visibility. Which architecture flows use is for the flow-integration work to decide.

---

## 4. RPC surface

**Namespace:** RPCs live under `skillhub/*`. The pre-existing `skill/*` namespace (`packages/conductor/handlers/resource.ts`) is owned by the file-backed agent skill definitions in `app.skills` (FileSkillStore) — those are system-shipped, injected into session context at agent boot. The Skill Hub is a different concept (tenant-scoped CRUD + 3-way merge); namespacing it separately avoids breaking the existing surface. Consolidating the two skill concepts into one namespace is tracked as a follow-up.

The reconciliation flow is split across two RPCs (`skillhub/sync_status`, `skillhub/get_with_ancestor`) plus a client-side 3-way merge that runs in the CLI via the linked `claude-agent` SDK — so the conductor stays out of the LLM call path entirely, and the LLM cost lands on the importer's own Anthropic account. See §7 for the merge protocol.

| RPC | Purpose | Gates |
|---|---|---|
| `skillhub/list` | List skills visible to caller. User-visibility rows owned by caller are always included regardless of tenant context (consultant pattern, see §3). Team/tenant/cross_tenant rows scoped by the existing `requireSameTenant` rules. | `requireRealUser` (anonymous gets only builtins) |
| `skillhub/get` | Read full skill by id, returns canonical bundle (body + supporting_files + harness_hints) + `current_hash`. For user-visibility rows, `requireSameTenant` is skipped when `ctx.userId === skill.owner_user_id`. | visibility-aware: user → ownership; team/tenant/cross_tenant → `requireSameTenant` + visibility check |
| `skillhub/sync_status` | Takes `{ local_versions: [{ skill_id, local_hash }] }`. `local_hash` is **optional** per entry — omit it (or send null) when no sidecar exists for that skill, in which case the server returns status=`unknown` and the CLI proceeds to `skillhub/get_with_ancestor` to compare bodies. Returns per-skill server-side hash-equality verdict only: `up-to-date` / `server-changed` / `unknown`. The CLI combines this with its own local file hash to produce the user-facing classification (`local-ahead`, `fast-forward-pull`, `conflict`) — see §7. **No bodies, no LLM** — fast even at 100s of skills. | `requireRealUser` |
| `skillhub/get_with_ancestor` | For one skill where `sync_status` reported `conflict`, `server-changed`, or `unknown`. Takes `{ skill_id, ancestor_hash? }`. `ancestor_hash` is **optional**: when present (from sidecar) the server returns both current + ancestor bodies (3-way merge path); when absent (no sidecar) the server returns current-only (2-way merge path, see §7 "Sidecar missing"). Response shape: `{ server_body, server_supporting_files, server_hash, server_harness_hints, ancestor_body?, ancestor_supporting_files?, ancestor_hash? }`. **No LLM.** The CLI performs the merge itself using the bodies returned here (RFC §7). | `requireRealUser` + visibility-aware (same as `skillhub/get`) |
| `skillhub/put` | Create or update a skill. Request carries `{ skill_id?, harness, body, supporting_files, harness_hints, expected_current_hash?, visibility?, team_id?, force?, merge_input? }`. **Create vs update is determined by `skill_id`:** when absent or null, server creates a new skill (generates id, ignores `expected_current_hash`, requires `visibility`); when present, server treats as update (requires `expected_current_hash`, derives visibility from the existing row unless explicitly overridden). Server **normalizes** body + supporting_files via the shared normalizer (§7), preserves the raw original in `harness_hints.<harness>.original_body` and `.original_supporting_files` **only if normalization changed something** (else the original is identical to the canonical and not duplicated), stores the normalized canonical in `body` + `supporting_files`, merges `harness_hints` into the existing harness_hints_json (preserving other harnesses' entries). Hash is computed over the canonical bundle. On `expected_current_hash` mismatch (update mode) returns 409 — no merge attempt; user should have run sync first. Accepts `force: true` to bypass optimistic-lock. Rejects `visibility=cross_tenant` (§9 Q1 decision). **Force gate is visibility-aware:** user-scope requires the caller to own the row (no admin needed for your own personal skills); team/tenant requires admin in the owning tenant. Audit log captures every force action. **`merge_input`** is an optional opaque blob the CLI attaches when this put is the result of an accepted client-side 3-way merge (see §7 LLM contract); the server persists it onto the new `skill_versions.merge_input_json` for audit. | `requireRealUser` + visibility-aware; user-scope: `ctx.userId === skill.owner_user_id`; team-scope: `requireAdmin` in skill.tenant_id; tenant-scope: `requireAdmin` in skill.tenant_id; `force=true` enforced via the same per-visibility gates |
| `skillhub/delete` | Soft-delete a skill | visibility-aware (user-scope: ownership; team/tenant: admin) |
| `skillhub/search` | Search by name/description/tags within visible scope (same visibility rules as `skillhub/list`). Case-insensitive substring match. **Empty query string is treated as a no-op filter** (returns every visible skill) - clients that want strict "empty = no results" must enforce that client-side. | `requireRealUser` |
| `skillhub/published_after` | Discovery feed: new/updated skills in caller's visible scope since a timestamp. Visibility rules match `skillhub/list` exactly — user-scope rows owned by the caller (tenant-agnostic per the consultant pattern) + team/tenant rows in the caller's current tenant context. Results ordered newest-first by `updated_at`. **Empty `since` string is treated as a no-op filter** (returns every visible skill); clients pass an actual ISO-8601 timestamp. The comparison is inclusive (`updated_at >= since`) so a same-ms tie is included; client dedupes by `id`. | `requireRealUser` |
| `admin/skillhub/list` | Cross-team visibility for tenant admins | `requireAdmin` |

---

## 5. CLI surface

```
ark skills list [--scope user|team|tenant|all] [--tag <tag>] [--harness <h>]
ark skills get <id|name>                                     # prints canonical to stdout
ark skills put <path> [--visibility user|team|tenant]    # optional; resolution below
                       [--team <team-id>]                    # required if --visibility=team
                       [--harness <h>]                       # explicit; otherwise inferred from path
                       [--force]                             # visibility-aware: user-scope = ownership;
                                                             # team/tenant-scope = admin in owning tenant
ark skills delete <id|name>
ark skills sync [--harness <h>] [--dir <path>] [--dry-run] [--no-merge] [--yes]
ark skills install <id|name> [--harness <h>] [--dir <path>]
ark skills search <query>
```

### Mental model: local files vs hub registry

The CLI operates on two distinct piles of state. Confusing them is the most common new-user trap:

| What's where | Owner | Who sees it |
|---|---|---|
| `<repo>/.claude/skills/<name>/SKILL.md` (and the equivalent paths for cursor / codex) | Every developer who clones the repo gets their own copy on disk. | Only the local Claude Code / Cursor / Codex install reads these at runtime. The hub server does NOT see them. |
| `~/.ark/ark.db` `skills` table | Server-side tenant-scoped registry. Populated only by `ark skills put` (or `install` pulling from elsewhere). | `ark skills list` reads from here. |
| `<repo>/.ark/skills-state/<harness>-<name>.json` | Per-developer-per-machine sidecar binding a local skill dir to its server-side `skill_id` + `current_hash` at last sync. Gitignored. | The CLI itself, for `sync` / `put` (update detection). |

So `ark skills list` shows what's on the **server**, not what's on disk. SKILL.md files in your repo are just local files until you `ark skills put` them.

### Importing existing local skill bundles into the hub

When you first run `ark skills list` in a repo that already has `.claude/skills/...` directories from prior Claude Code use, expect an empty list. The CLI's empty-state surfaces this directly:

```
$ ark skills list
No skills uploaded yet.

Local skill bundles found in this directory (not yet uploaded to the hub):
  claude/code-review   .claude/skills/code-review
  claude/deploy-runbook   .claude/skills/deploy-runbook
  ...

Upload one:
  ark skills put .claude/skills/code-review
Upload all:
  for d in .claude/skills/*/; do ark skills put "$d"; done
```

The bulk-upload one-liner defaults every skill to `--visibility=user` (private to you). After upload, each bundle gets a sidecar at `<repo>/.ark/skills-state/claude-<name>.json` so subsequent `ark skills put` calls become UPDATEs (sharing the existing `skill_id`), not new creates.

To share something more broadly, set the visibility at create time:

```
ark skills put .claude/skills/x --visibility tenant
```

Visibility is fixed at create — `ark skills put` rejects an update that tries to change it (see "Visibility-change limitation" below). If you've already uploaded as user-scope and want to promote to team/tenant: `ark skills delete <id>`, then re-upload with `--visibility team --team <id>` or `--visibility tenant`.

### `--visibility` resolution on `put`

The `--visibility` flag is **optional**. The CLI resolves visibility in this order:

1. **Flag was specified at create time** → use it.
2. **Skill already exists on the server** (CLI detects via the sync-state sidecar's skill_id or a name lookup in caller's visible scope) → use its current visibility. No flag needed in the common edit-and-republish case.
3. **New skill, no flag given** → default to `user`. Safest possible default — the skill is private to the author. To share more broadly, the user adds `--visibility team --team <id>` or `--visibility tenant` explicitly.

The default-to-user model means casual `ark skills put` calls never accidentally over-share. Sharing requires an explicit user choice.

**Visibility-change limitation (v1):** Changing the visibility of an *existing* skill (e.g., promoting `user → team`) is **not supported via `skillhub/put`**. The scoping columns' shape differs per visibility (e.g., `user` requires `tenant_id IS NULL AND owner_user_id IS NOT NULL`; `team` requires the opposite) and a mid-row transformation would fail the CHECK constraint. The server rejects such requests with `UNSUPPORTED`. Workflow: delete the old skill and create a new one with the target visibility. A dedicated `skillhub/change_visibility` RPC that handles the shape transformation is a possible follow-up; not in v1.

### Repo detection cascade (`ark skills sync` with no explicit flag)

Sync needs to know which harness(es) to write skills for and which directories to write them to. A cascade of signals resolves this in order of decreasing specificity. The first layer that produces a non-empty result wins; subsequent layers are skipped.

| Layer | Signal | What we check |
|---|---|---|
| **1** | Existing skill dirs in repo | Walk every adapter's `readPaths()` (see §6). Any path containing `<name>/SKILL.md` → that harness is in active use. |
| **2** | `<repo>/.ark/config.yaml` | Explicit, repo-specific intent (team has codified the convention). |
| **3** | `scoping_overrides` resolver | Looks up `skill.default_harness` with user > team > tenant precedence (existing resolver from PR #564). |
| **4** | Interactive prompt | Last resort. If a TTY is attached: prompt the user. With `--no-interactive`: error. |

Multiple harnesses detected at Layer 1 = sync writes to each, one set of files per harness.

**Deferred from v1: user-home dirs (`~/.claude/skills/`) and repo heuristics (`.gitignore`, `.vscode/`).** These were considered as additional fallback layers but are brittle — `~/.claude/` exists after any Claude Code install regardless of active use; `.vscode/` doesn't mean Cursor. They'd produce frequent false positives without much value over the prompt. Adding them is additive and cheap if real users complain about prompt frequency post-launch.

**Layer 4 auto-persistence.** When the cascade falls to the interactive prompt and the user picks a harness (or specifies a custom path), the CLI **writes `<repo>/.ark/config.yaml`** capturing that choice. Subsequent syncs short-circuit at Layer 2 — the user is never prompted twice for the same repo. The same auto-persist also fires when the user passes `--dir <custom-path>` and confirms a "save as default?" prompt.

**Layer 3 caveat (soft enforcement only).** The scoping_overrides resolver applies user > team > tenant. A tenant admin setting `tenant`-scope `skill.default_harness=claude` is a *default*, not a mandate — any user can override at their `user`-scope. Hard enforcement of harness choice is out of scope; if needed, it would require a separate mechanism.

### `<repo>/.ark/config.yaml`

Optional. Created by the user manually, or auto-written by the CLI at Layer 4 of the cascade. When present, Layer 2 of the cascade reads it; absence means defer to Layers 3-4.

Lives in the repo's existing `<repo>/.ark/` directory (same place ark stores other project-local state). Gitignored by default — convention is per-developer, though teams that want to share the file can opt to commit it.

```yaml
# <repo>/.ark/config.yaml
skills:
  # Additive: extends adapter-declared standard read paths with these custom ones.
  # The CLI walks these in addition to (not instead of) each harness's readPaths().
  read_paths:
    - .foundry/skills              # custom corporate path
    - packages/*/.claude/skills    # monorepo per-package; glob supported

  # Per-harness override of where sync writes skills for this repo.
  # If a harness has no entry here, the adapter's defaultWritePath() is used.
  write_to:
    claude: .claude/skills
    cursor: .agents/skills         # explicit: prefer the open-standard path

  # Optional: restrict sync to only these harnesses, even if others are detected.
  enabled_harnesses: [claude, cursor]
```

Detection lives in the CLI, not the backend. The backend just stores canonical records and serves them.

---

## 6. Adapter layer

### Format convergence

Claude Code, Cursor, and Codex have all converged on a shared skill format defined by the **Agent Skills open standard** ([agentskills.io](https://agentskills.io)). Each skill is a **directory** containing a required `SKILL.md` file with YAML frontmatter and a markdown body, plus optional subdirectories (`scripts/`, `references/`, `assets/`). The frontmatter has two universally-required fields — `name` and `description` — plus tool-specific extensions that each harness understands and others ignore.

Reference documentation for each harness:
- **Claude Code:** [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)
- **Cursor:** [cursor.com/docs/skills](https://cursor.com/docs/skills)
- **Codex:** [developers.openai.com/codex/skills](https://developers.openai.com/codex/skills)
- **Reference examples (multi-file SKILL.md):** Anthropic's [skills repo](https://github.com/anthropics/skills) and OpenAI's [skills repo](https://github.com/openai/skills) — both ship the same PDF skill structure as worked examples of the multi-file pattern.

This means the **`SKILL.md` content is portable across harnesses unchanged**. The body markdown, the `$ARGUMENTS` placeholder convention, and the basic frontmatter are identical. Differences live in:

| What | Where it varies |
|---|---|
| **File system path** | `.claude/skills/<name>/SKILL.md` vs `.cursor/skills/<name>/SKILL.md` vs `.codex/skills/<name>/SKILL.md` vs `.agents/skills/<name>/SKILL.md` (universal) — different paths, same internal structure |
| **Frontmatter extensions** | Each harness ignores keys it doesn't understand; the canonical record stores them in `harness_hints_json` to preserve round-trips |
| **Read locations** | Each harness scans multiple paths (project, user-home, enterprise, plugin, additional dirs). Each adapter declares the full set via `readPaths()` |

Multi-file skills are the norm, not the exception — the reference PDF skill in both Anthropic's and OpenAI's official examples ships with `references/`, `scripts/`, etc. Canonical schema's `supporting_files_json` captures these.

### Adapter interface (pluggable registry)

The adapter layer is designed to be **extensible to any future agent harness**, not hardcoded to a fixed set. A new harness (Goose, pi.dev, future tools) is added by implementing the interface and dropping the file into the adapter directory:

```ts
// packages/skill-adapters/types.ts

/**
 * The full canonical record as stored on the server. The adapter NEVER
 * sees this directly; server-side fields (id, scoping, audit) are added
 * by the CLI / backend after parsing.
 */
export interface CanonicalSkill {
  id: string;
  tenantId: string | null;                      // null for user-visibility
  teamId: string | null;
  ownerUserId: string | null;
  visibility: "user" | "team" | "tenant" | "cross_tenant";
  name: string;
  description: string;
  body: string;                                  // SKILL.md content (markdown)
  supportingFiles: SupportingFile[];
  category: string | null;
  tags: string[];
  harnessHints: Record<string, Record<string, unknown>>;
  currentHash: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // ... and the audit fields elided
}

/**
 * What an adapter CAN know just by parsing a local skill directory.
 * Server-side fields (id, scoping, audit) are NOT here — the CLI fills
 * them in before calling `skillhub/put`.
 */
export interface LocalSkill {
  name: string;
  description: string;
  body: string;
  supportingFiles: SupportingFile[];
  category: string | null;
  tags: string[];
  harnessHints: Record<string, Record<string, unknown>>;
}

export interface SupportingFile {
  path: string;                                  // relative to skill dir
  content: string;
}

export interface WrittenFile {
  relativePath: string;                          // relative to the skill's directory
  content: string;
}

export interface HarnessAdapter {
  /** Stable identifier — used in DB hints, CLI flags, config keys. Immutable. */
  harnessId: string;                             // "claude" | "cursor" | "codex" | "goose" | ...

  /**
   * All paths this harness reads skills from, in a given repo root.
   * Should match the harness's own docs exactly (project + user + enterprise scopes).
   * The CLI uses this set for both Layer 1 detection and the read side of `sync`.
   */
  readPaths(repoRoot: string): string[];

  /**
   * The path this harness writes its own skills to BY DEFAULT.
   * Used when sync materializes a new skill for this harness; always
   * overridable via `<repo>/.ark/config.yaml:skills.write_to.<harness>`
   * or the `--dir` flag.
   */
  defaultWritePath(repoRoot: string): string;

  /**
   * Parse a directory containing SKILL.md → harness-agnostic LocalSkill.
   * Returns only what's parseable from disk; the CLI enriches with
   * scoping/visibility/id before sending to the server.
   */
  parse(skillDir: string): LocalSkill;

  /**
   * Render canonical → list of files for the target harness (SKILL.md +
   * supporting files). The adapter consults `skill.harnessHints[harnessId]`:
   * - If `original_body` is present for this harness, use it (the author's
   *   raw, un-normalized version, preserved at upload time per §7).
   * - Otherwise render from the canonical `skill.body` (the normalized form).
   * Same logic for `original_supporting_files` vs canonical `supporting_files`.
   * Harness-specific frontmatter fields come from the rest of `harnessHints[harnessId]`.
   */
  render(skill: CanonicalSkill): WrittenFile[];
}

// packages/skill-adapters/index.ts
import { claudeAdapter } from "./claude.js";
import { cursorAdapter } from "./cursor.js";
import { codexAdapter } from "./codex.js";

export const registry: HarnessAdapter[] = [
  claudeAdapter,
  cursorAdapter,
  codexAdapter,
  // Adding a new harness = one more import. No core changes.
];
```

### Adapter responsibilities

| Concern | Lives in adapter? |
|---|---|
| Knowing the harness's read paths | ✓ |
| Knowing the harness's preferred write path | ✓ |
| Preserving harness-specific frontmatter fields via `harness_hints_json` | ✓ |
| Parsing SKILL.md frontmatter + body | ✓ |
| Rendering canonical → SKILL.md + supporting files | ✓ |
| Conflict detection / merge | ✗ — server-side (§7) |
| Cascade ordering / overall sync flow | ✗ — CLI core (§5) |
| Skill storage / visibility / auth | ✗ — backend (§3, §4) |

Adapter is the *only* layer that knows harness-specific details. Everything else stays generic.

### Why we don't make `readPaths` / `defaultWritePath` user-configurable

The adapter is the spec — it codifies what the harness vendor documents. If Claude Code changes its conventions, the adapter file gets updated (and code-reviewed). User-level overrides happen through three existing mechanisms (`<repo>/.ark/config.yaml`, `scoping_overrides`, `--dir`); adding a fourth would multiply "which override wins" questions without solving anything new.

### v1 adapters

Claude, Cursor, and Codex implementations ship in the first PR. Adding additional harnesses (Goose, pi.dev, etc.) is a separate, additive PR per harness — no schema, RPC, or core CLI changes required.

Unit-testable end-to-end with fixtures (see §13 worked example).

---

## 7. The merge protocol (LLM-assisted 3-way merge)

The diff/reconcile requirement is non-trivial because two clients can edit the same skill simultaneously. A plain "last write wins" model would silently destroy edits. The proposed design uses an **LLM-assisted 3-way merge** with the server holding the authoritative version history.

### Server-side history is the source of truth

The schema introduced in §3 includes a `skill_versions` table. Every `skillhub/put` that changes the body writes a snapshot row BEFORE updating the live `skills` row. This guarantees:

- The body for any past `version_hash` is retrievable server-side from `skill_versions` (used internally during merge, exposed publicly only via `skillhub/get_with_ancestor`).
- The "ancestor body" required for a 3-way merge is always a server-side lookup; clients never have to safeguard the ancestor themselves.

### Normalizer module (critical for Q2 decision)

The Q2 decision (§9) is "strip and normalize on upload." Both halves of that — frontmatter stripping AND body normalization — go through a shared module at `packages/core/skills/normalizer.ts`. The CLI and the server both import from this module, so they produce identical canonical output for the same input. That's what makes hash equality between client and server possible.

**For v1, the normalizer is deterministic and regex-based.** LLM-driven normalization is a future enhancement. Reason: the CLI must reproduce the server's canonical output to compute matching hashes (for `sync_status` to work without spurious conflicts). LLM output is non-deterministic — CLI can't reproduce it reliably. Deterministic regex is portable and shareable.

**What the v1 normalizer does** (expandable pattern table):

| Pattern in source | Source harness | Normalized to |
|---|---|---|
| `$ARGUMENTS[N]` | Claude (indexed arguments) | `<the (N+1)-th argument>` |
| `$N` (shorthand for `$ARGUMENTS[N]`) | Claude | `<the (N+1)-th argument>` |
| `${CLAUDE_SESSION_ID}` | Claude | `<the session id>` |
| `${CLAUDE_SKILL_DIR}` | Claude | `<the skill directory>` |
| `${CLAUDE_EFFORT}` | Claude | `<the effort level>` |
| Other harness-specific runtime substitutions | varies | tool-neutral placeholder |

**The normalizer is idempotent.** `normalize(normalize(x)) === normalize(x)`. This guarantees that re-normalizing an already-canonical body produces the same output (important for hash stability across re-uploads).

**Frontmatter stripping** is mostly done at the adapter level (`adapter.parse(skillDir)` returns `LocalSkill` with harness-specific frontmatter already extracted into `harnessHints`). The normalizer's contribution is the body-level transformations above.

**Upload flow with normalization:**

```
CLI:
  rawLocal = adapter.parse(skillDir)        // LocalSkill: raw body + harness-specific frontmatter
  canonical = normalize(rawLocal, harness)  // canonical body + supporting_files (idempotent)
  hash = sha256(canonicalBundle(canonical))
  → send to skillhub/put:
      {
        skill_id: sidecar.skill_id ?? null,   // null/absent = create mode (server assigns id)
        harness: "claude",                     // (for harness-specific frontmatter routing)
        body: rawLocal.body,
        supporting_files: rawLocal.supportingFiles,
        harness_hints: rawLocal.harnessHints,  // { "claude": { "disable-model-invocation": ..., ... } }
                                               // parsed by the adapter; carries harness-specific
                                               // frontmatter the server stores in harness_hints_json
        expected_current_hash: sidecar.current_hash ?? null,  // null/absent in create mode
        // visibility/team_id are sent ONLY when the user explicitly passed --visibility:
        //   - In update mode without --visibility, omit both → server keeps the existing row's visibility.
        //   - In create mode without --visibility, the CLI defaults to "user" before sending (per §5).
        visibility: explicitVisibilityFlag ?? (isCreate ? "user" : undefined),
        team_id: explicitTeamFlag ?? undefined,
        force: false,
      }

Server (skillhub/put handler):
  if (skill_id is null):  // create mode
    generate new skill_id
    require visibility (reject if not in {user, team, tenant})
    reject visibility=cross_tenant (§9 Q1)
  else:  // update mode
    load existing skill row
    if (skills.current_hash !== expected_current_hash AND not force):
      return 409 "Run sync to reconcile"
    derive visibility from existing row (unless caller explicitly overrides)

  canonical = normalize({ body, supporting_files }, harness)
  current_hash = sha256(canonicalBundle(canonical))

  store: skills.body = canonical.body, skills.supporting_files = canonical.supportingFiles
  merge harness_hints into existing harness_hints_json:
    // Per-harness REPLACEMENT (not field-level merge). The incoming harness's entry
    // fully replaces the previous one for that harness, so last-writer-wins per harness
    // — same semantics as `body` itself. Other harnesses' entries are preserved untouched.
    // Example: if alice put with claude.disable-model-invocation=true and bob later
    // puts without that field, alice's setting is gone for the claude entry. Bob can
    // still reintroduce it on his next put if needed.
    skills.harness_hints[harness] = { ...request.harness_hints[harness] }
    preserve raw ONLY if normalization changed something:
      if (request.body !== canonical.body):
        skills.harness_hints[harness].original_body = request.body
      if (request.supporting_files !== canonical.supportingFiles):
        skills.harness_hints[harness].original_supporting_files = request.supporting_files

  insert skill_versions row (snapshot of canonical bundle)
  update skills.current_hash
  return { skill_id, new current_hash }
```

**Normalizer scope reminder:** The normalizer runs over both the body and each `supporting_files[].content`. For non-markdown files (e.g. `scripts/run.py`, `assets/data.json`), the Claude-specific token patterns almost never match — the normalizer is a no-op for those files in practice. The merge-strategy table in this section handles non-markdown files separately (default: manual three-way, not LLM-merged).

The "only if changed" check avoids redundant storage when the author uploaded already-canonical content — `original_body` is absent in that case, and `adapter.render()` falls through to using `body` directly. The author's raw is preserved only when there's a meaningful difference, so re-rendering for the author's harness still gives them back exactly what they wrote.

### Hash semantics (critical)

Both client and server hash the **canonical bundle** (the normalized form, per the section above), never the raw harness-flavored input. The bundle shape:

```ts
type CanonicalBundle = {
  body: string;                              // SKILL.md content, AFTER normalizer pass
  supporting_files: SupportingFile[];        // sorted by path; each .content also AFTER normalizer
};
```

The hash is `sha256` over a canonical JSON serialization with **deeply-sorted keys** and **no whitespace**. Reference implementation:

```ts
// packages/core/skills/hash.ts — THE source of truth, imported by both
// the conductor (server-side hashes during skillhub/put) and the CLI
// (client-side hashes before skillhub/sync_status). See §11 step 5.

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.keys(value as object)
      .sort()
      .reduce((acc, k) => { acc[k] = sortKeysDeep((value as any)[k]); return acc; }, {} as any);
  }
  return value;
}

export function hashCanonicalBundle(bundle: CanonicalBundle): string {
  const sorted = sortKeysDeep(bundle);
  const json = JSON.stringify(sorted);          // no `space` arg → no whitespace
  return sha256Hex(json);                       // server and CLI use the same sha256 impl
}
```

Both sides MUST import from `packages/core/skills/hash.ts` rather than reimplement — any drift in canonicalization breaks the hash equality the protocol depends on.

Implications:
- The CLI **must** call `adapter.parse(skillDir)` to get the canonical `LocalSkill`, then hash from that. Hashing the on-disk `SKILL.md` directly would include harness-specific frontmatter and produce a hash the server can never match.
- Harness-specific frontmatter (in `harness_hints_json`) is **not** part of the hash. Two harnesses rendering the same canonical skill produce different on-disk files but the same hash.
- Supporting files **are** part of the hash. Editing `references/spec.md` changes the hash even though `SKILL.md` is unchanged.
- Hashes are deterministic across machines and harnesses. Any sha256 implementation works; the only requirement is the canonical JSON serialization (sorted keys, no extraneous whitespace, UTF-8).

### Client-side sync-state sidecar (optimization, not requirement)

To run a proper 3-way merge, the client needs two pieces of state per (harness, skill): the server-assigned `skill_id` and the canonical `current_hash` at last sync. The CLI tracks both in a small per-skill JSON sidecar:

- **Location:** `<repo>/.ark/skills-state/<harness>-<skill_name>.json` — one file per (harness, skill) pair.
- **Payload:** `{ "skill_id": "skl-abc123def456", "current_hash": "<sha256 of canonical bundle at last sync>" }`.
- **Gitignored** by default — the repo's root `.gitignore` ships with `.ark/skills-state/` excluded. The state is per-user-per-machine; sharing across users via git would cause false-conflict reports on the next sync (each user's local body wouldn't match the committed sidecar's `current_hash`).
- **Written** after every successful sync that pulled or merged a skill (and after every successful `skillhub/put` that returned a new `current_hash`).
- **Read** at the start of every sync: `skill_id` populates `local_versions[*].skill_id` and the request to `skillhub/get_with_ancestor`; `current_hash` populates `local_versions[*].local_hash` (the server compares this to its own `skills.current_hash` for hash-equality verdict).

**When the sidecar is missing** (fresh clone, machine wipe, never-synced repo), the CLI omits `local_hash` in `sync_status` request entries (or sends `null`). The server returns `status=unknown` for those entries — see the §4 `skillhub/sync_status` description. The CLI then proceeds to `skillhub/get_with_ancestor` WITHOUT an `ancestor_hash` (also optional); the server returns the current body + supporting files (no ancestor). The CLI diffs the local file against the current body: if identical, write a fresh sidecar and treat as `up-to-date`; if different, classify as `conflict` and run a **2-way merge in the CLI** (mine + theirs only, no common ancestor — lower-quality but no data loss). The next successful sync writes a sidecar.

This whole degradation path is unattractive but bounded: it fires once per fresh-clone/wipe, then the sidecar is back in place and subsequent syncs are normal 3-way.

### Two server RPCs + client-side merge

Server-side touches the merge flow in only two RPCs; the actual LLM merge runs **client-side in the CLI** via the linked `claude-agent` SDK using the importer's own Anthropic credentials. This keeps the conductor out of the LLM call path (no programmatic LLM precedent for handlers), pushes the LLM cost onto the importer's account naturally, eliminates a network hop, and avoids new tenant-scoped policy plumbing for an LLM budget the platform never sees.

**`skillhub/sync_status`** — fast, no LLM. Takes `{ local_versions: [{ skill_id, local_hash? }] }`. `local_hash` is optional per entry (omit when no sidecar exists for that skill). The server only knows hash equality (it can't see the user's working tree), so its return enum is intentionally minimal:

| Server's `current_hash` vs request's `local_hash` | Status returned by server |
|---|---|
| equal | `up-to-date` |
| differ | `server-changed` |
| no `local_hash` supplied (sidecar missing) | `unknown` |

Returns `[{ skill_id, status, server_hash }]`. The CLI then **combines the server's verdict with its own local file hash** to produce the user-facing classification:

| Server status | Local file hash matches sidecar? | CLI classification | What the CLI does next |
|---|---|---|---|
| `up-to-date` | yes | `up-to-date` | no-op |
| `up-to-date` | no | `local-ahead` | user runs `skillhub/put` to publish |
| `server-changed` | yes | `fast-forward-pull` | call `get_with_ancestor`, write server's body locally, update sidecar |
| `server-changed` | no | `conflict` | call `get_with_ancestor`, then run the 3-way merge **in the CLI** and prompt the user to accept |
| `unknown` | (no sidecar to compare against) | `unknown` | call `get_with_ancestor` unconditionally; if local file matches the ancestor → `fast-forward-pull`, else → `conflict` (CLI runs a 2-way merge using mine + theirs only) |

Keeping the server-side and CLI-side enums separate avoids the implementer asking "who computes `conflict`?" — only the CLI does, and only after combining the server's response with the local file hash.

**`skillhub/get_with_ancestor`** — fast, no LLM. Takes `{ skill_id, ancestor_hash? }`. Per-skill: returns `{ server_body, server_supporting_files, server_hash, server_harness_hints, ancestor_body?, ancestor_supporting_files?, ancestor_hash? }`. When `ancestor_hash` is provided (sidecar present), the server includes the ancestor fields for a 3-way merge; when omitted (no sidecar), only the current is returned and the CLI falls back to a 2-way merge (mine + theirs). The CLI uses this to show diffs and to run the merge itself.

**Client-side merge** — invoked entirely in the CLI, no server RPC. After `get_with_ancestor` returns, the CLI walks the file set (mine ∪ server) with the per-file strategy table below (markdown → LLM, code/config → manual). For files marked `llm` and where both sides changed vs the ancestor, the CLI calls the linked `claude-agent` SDK with a 3-way prompt; for files marked `manual`, the CLI surfaces the raw three-way for the user to resolve in their editor. The CLI assembles the proposed merge in the shape:

```jsonc
{
  "body":             "...",
  "supporting_files": [{ "path": ..., "content": ... }],
  "llm_model":        "claude-sonnet-4-6",
  "per_file_results": [
    { "path": "SKILL.md",              "strategy": "llm",    "merged": true },
    { "path": "references/spec.md",    "strategy": "llm",    "merged": true },
    { "path": "scripts/run.py",        "strategy": "manual", "merged": false,
      "raw": { "ancestor": "...", "mine": "...", "theirs": "..." } }
  ]
}
```

When the user accepts, the CLI calls `skillhub/put` with the merged body / supporting_files **and** an opaque `merge_input` blob carrying `{ ancestor_hash, mine_hash, theirs_hash, llm_model, per_file_strategies, accepted_by }` so the server persists the merge provenance onto the new `skill_versions.merge_input_json` for audit.

Per-file merge strategy is **file-type-aware** — see "Merge strategy by file type" below.

### Sequence diagram (CLI-orchestrated; client-side merge)

```
Client (CLI)                                       Server
────────────                                       ──────
skillhub/sync_status(harness,           ───────────►  for each {skill_id, local_hash}:
  local_versions: [{skill_id,                        compare local_hash to skills.current_hash
    local_hash from sidecar}])                       return per-skill status (no bodies)
                                ◄───────────────   200 OK [{skill_id, status, server_hash}]

[CLI computes local file hashes, classifies into:
   fast-forward-pull, local-ahead, conflict]

[For each fast-forward-pull / conflict skill:]
skillhub/get_with_ancestor(skill_id)    ───────────►  load (body+supporting_files) for both
                                                     current_hash and the ancestor_hash from skill_versions
                                ◄───────────────   200 OK {
                                                     server_body, server_supporting_files, server_hash,
                                                     ancestor_body, ancestor_supporting_files, ancestor_hash
                                                   }

[For fast-forward-pull: CLI writes server content + updates sidecar.
 For conflicts: CLI prompts "run LLM merge now?"; on user opt-in:
   - resolves Anthropic creds (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN
     / ark secrets / local Claude install). No creds → fail with a clear
     message; user re-runs after auth.
   - for each file in (mine ∪ server):
       if unchanged in mine vs ancestor → use server's version
       elif unchanged in server vs ancestor → use mine's version
       elif both changed AND file is markdown-like:
         claude-agent SDK call: 3-way merge prompt, ancestor + mine + theirs
       elif both changed AND file is non-markdown:
         mark requires_manual; surface raw three-way for the user's editor
   - normalize() pass over the SDK output (idempotent; safety net against
     the SDK re-introducing harness-specific syntax)
   - assemble proposed_merge {body, supporting_files, llm_model,
     per_file_results}; show to user; user accepts / rejects / edits]

skillhub/put(skill_id, harness,         ───────────►  compare expected_current_hash to skills.current_hash
  body=accepted.body,                                if differs: 409 — "Run sync_status again to reconcile"
  supporting_files=accepted.sf,                      if matches: normalize(body, supporting_files, harness),
  harness_hints=accepted.hints,                        store canonical in skills.body, merge harness_hints
  expected_current_hash=server_hash,                   into harness_hints_json (replacing this harness's
  merge_input={                                        entry), preserve raw in
    ancestor_hash, mine_hash,                          harness_hints[harness].original_body (if different);
    theirs_hash, llm_model,                            write skill_versions row (carrying merge_input on
    per_file_strategies, accepted_by                   merge_input_json), update current_hash
  })
                                ◄───────────────   200 OK {new_current_hash}
                                                   (skill_versions.merge_input_json persists the
                                                    audit blob the CLI supplied)
```

The "third-party edits between sync and put" race is rare; when it happens, `put` returns 409 and the CLI just re-runs `sync_status` (which will produce a new conflict; the user re-runs the merge flow). No special handling required.

### Merge strategy by file type (safety)

LLM merging of non-markdown supporting files (Python scripts, shell scripts, JSON config, etc.) is a different risk class than markdown — an LLM can produce well-formed but semantically wrong code that a reviewer accepting via diff won't catch. The default policy the **CLI** applies during the client-side merge is conservative:

| File extension | Default strategy | Rationale |
|---|---|---|
| `.md`, `.txt`, `.rst` | `llm` — fire the 3-way LLM merge via the linked `claude-agent` SDK | Markdown is the medium most amenable to natural-language merge |
| `.py`, `.js`, `.ts`, `.sh`, `.json`, `.yaml`, `.yml`, anything else | `manual` — surface raw three-way for the user's editor, mark `requires_manual: true` in `per_file_results` | LLM-produced code is hard to verify visually; safer to let the user resolve in their editor |

Users who want LLM merge on a non-markdown file can override per file path via `harness_hints_json` at write-time (Skill Hub stores it, and the CLI consults it on the next merge):

```json
{
  "claude": {
    "merge_strategy": { "scripts/safe-script.py": "llm" }
  }
}
```

The CLI consults this map before deciding. Default if no override: extension-based as above.

### LLM contract (CLI-side)

- **Where it runs:** in the CLI, in-process. The CLI binary links the `@anthropic-ai/claude-agent-sdk` (already a dependency for the agent runtime). No server hop, no router proxy, no compute spin-up.
- **Credential discovery:** the CLI checks, in order, `ANTHROPIC_API_KEY` env, `CLAUDE_CODE_OAUTH_TOKEN` env, and the user's `ark secrets` store (default secret name `SKILLHUB_ANTHROPIC_TOKEN`). Claude Code Max subscribers whose token lives in the macOS keychain (not in env) can `export CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w \| jq -r '.claudeAiOauth.accessToken')` for the shell session. **No creds → fail the sync with a clear, actionable message** (which env vars to set / how to auth). Direct keychain reads (macOS) and equivalents (Linux Secret Service, Windows Credential Manager) are not in v1 — the cross-platform story is genuinely gnarly and the env-var workaround is one line. No server-side fallback in v1; this is the conscious trade for keeping the conductor out of the LLM path.
- **Model:** default Claude Sonnet 4.6. The cost lands on the importer's own Anthropic account, so there's no platform budget to govern with a `skill.merge_model` scoping override — that key is dropped from §3's config table.
- **Inputs (per file):** ancestor content, mine content, theirs content. All UTF-8 text.
- **Output (per file):** a single merged file content. The CLI validates non-empty and (for `.md`) parses as markdown; on failure, retries once via the SDK, then marks the file `requires_manual` with the raw three-way for the user's editor.
- **Post-normalization:** the CLI runs the shared `packages/core/skills/normalizer` over the SDK output before assembling `proposed_merge.body`. Inputs were already canonical, but the model might re-introduce harness-specific syntax in its merge; the normalizer pass keeps the assembled merge canonical and avoids a subsequent hash mismatch when the CLI computes `local_hash` and calls `skillhub/put`. (Idempotency makes this a no-op when the output is already canonical.)
- **Auditability:** the CLI assembles `merge_input = { ancestor_hash, mine_hash, theirs_hash, llm_model, per_file_strategies, accepted_by }` and ships it as a top-level parameter on `skillhub/put`. The server persists it onto `skill_versions.merge_input_json`. Full provenance for "who/what produced this version" + which files used LLM vs manual.
- **Determinism caveat:** LLM outputs are not deterministic. Two runs over the same inputs may produce different proposals. Acceptable for interactive accept/reject; **not** acceptable for automated retry loops. The CLI must surface the proposed merge to the user before applying.
- **Non-interactive callers (CI / scripts):** the sync command's two confirmation prompts (run LLM merge? accept the proposed merge?) require a TTY. CI / scripted callers must pass `--yes` to auto-accept both; without it, sync exits on the first conflict with an `interactive prompt not available` error. The audit blob still records `accepted_by: "cli"`; downstream consumers cannot distinguish an auto-accept from a human-confirmed accept from the persisted provenance alone.

### Cost / latency posture

- `skillhub/sync_status` has no LLM cost — always fast (single DB scan).
- `skillhub/get_with_ancestor` has no LLM cost — two indexed lookups.
- The 3-way merge runs in the CLI via the linked `claude-agent` SDK, **billed to the importer's own Anthropic account** (their `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`). The platform sees no LLM cost and needs no per-tenant model / budget governance.
- Latency per conflict: ~1-2s p95 on a Sonnet-class model (no router hop, no compute spin-up), ~5-20 KB input. Faster than a server-side proxy would be.
- For a 50-skill repo with 3 conflicts, the user pays: 1 fast `sync_status` call + N `get_with_ancestor` calls (for the changed skills) + up to 3 local LLM merges. Their cost is bounded by their own attention and their own Anthropic plan.
- For users without Anthropic credentials: the CLI fails fast on the first conflict with a clear "run `ark secrets set SKILLHUB_ANTHROPIC_TOKEN ...` or set `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`" hint. No silent fallback in v1 — the user explicitly chooses whether to add creds or resolve manually (`--no-merge` + manual edit + `skillhub/put --force`).

### Failure modes

| Failure | Where it surfaces | Behavior |
|---|---|---|
| No Anthropic credentials discoverable (env vars / `ark secrets`) | CLI, before any LLM call | Sync exits with a clear, actionable error naming the env vars to set and the `ark secrets set` command. No server fallback in v1. |
| `claude-agent` SDK call times out | CLI | Retry once; if still failing, mark the affected file `requires_manual: true` with raw three-way; other files in the same skill still get their successful merges |
| `claude-agent` SDK returns empty / malformed output | CLI | Same as timeout: retry once, then `requires_manual: true` for that file |
| `ancestor_hash` not found in `skill_versions` (e.g. skill was hard-deleted) | Server-side on `skillhub/get_with_ancestor` | 404 with "ancestor version not found"; CLI falls through to `skillhub/list` for current state |
| User rejects proposed merge | CLI | User edits locally to resolve, then re-runs the merge flow OR uses `skillhub/put --force` (gated per visibility — see §4) |
| User wants to bypass merge entirely | `skillhub/put` with `force: true` (gates: user-scope = ownership; team/tenant-scope = `requireAdmin`) | Skips optimistic-lock check; overwrites server version. `skill_versions.changed_by` captures the force action; `merge_input_json` is null since no merge was performed |
| Modify/delete conflict — file existed in ancestor + one side kept it (with or without further edits) + the other side deleted it | CLI merge engine | Auto-resolves to the surviving side (the merge does NOT block on this). Emits `per_file_result.asymmetric = "kept-vs-delete"` when theirs deleted + mine kept, or `"deleted-vs-kept"` when mine deleted + theirs kept. The CLI surfaces this as a warning at the moment of sync so the user can verify they're not silently restoring an intentional deletion (security file removed, deprecated script, etc.). Legitimate one-sided adds (file absent from ancestor) do NOT emit the signal - that's a clean add, not a conflict. |
| Partial merge — some files merged successfully, others left as `requires_manual` | CLI merge engine | The CLI **refuses to push** the partial result on accept-merge. Pushing would silently DELETE the unresolved files from the server-side bundle (the engine's proposed_merge omits unmerged files), and other teammates would lose those files on their next sync. v1 policy: user resolves locally in their editor and re-runs `ark skills sync`. (Less safe alternatives like "include mine's version for unresolved files" lose the requires-manual signal entirely — the conflict just resurfaces on the next sync; rejected for v1.) |
| Local edits to `harness_hints[harness]` lost on merge-accept | CLI merge engine | The body merger does NOT merge `harness_hints` frontmatter. On accept, the CLI writes the server's `harness_hints` over the local version, so any local-only frontmatter edits (e.g. user added a new `paths:` value to their Claude entry) are lost. Other harnesses' entries survive untouched. Merging frontmatter cleanly is a separate scope from body merge — accepted as a v1 limitation. Mitigation: re-add the local frontmatter edit and run `ark skills put`. |

---

## 8. Testing strategy (localhost-only, no remote daemon needed)

All testing happens on one laptop, one daemon, using multiple Bearer tokens to simulate multiple users. Scenarios:

| Test | Setup | Assertion |
|---|---|---|
| Tenant-admin can create a tenant-scope skill | Admin Bearer in tenant A | `skillhub/put visibility=tenant` succeeds; appears in `skillhub/list` for any user in tenant A |
| Team-scope sharing | Two users (alice, bob) in same team-eng | alice `put visibility=team`; bob's `sync_status` + `get_with_ancestor` returns alice's skill |
| User-scope privacy | alice in team-eng creates `visibility=user` | bob in same team does NOT see it via `skillhub/list` |
| **Consultant pattern — user-scope** | alice has memberships in tenant A AND tenant B; alice creates `visibility=user` skill `code-review` while authenticated in tenant A | alice's `skillhub/list` while authenticated in tenant B INCLUDES `code-review` (user-scope rows are tenant-agnostic); other users in either tenant do NOT see it |
| **Consultant pattern — team/tenant rows DO NOT cross tenant boundaries** | alice has memberships in tenant A AND tenant B; alice creates `visibility=team` in tenant A's `team-eng` and `visibility=tenant` in tenant A | alice's `skillhub/list` while authenticated in **tenant B** does NOT include either of these (team and tenant rows respect strict isolation per Q1); when she re-authenticates as tenant A, both appear |
| Cross-tenant tenant-scope isolation | alice in tenant A creates `visibility=tenant`; bob in tenant B | bob `skillhub/list` does NOT return alice's tenant-A skill (`cross_tenant` unreachable today) |
| `sync_status` — happy path | bob's sidecar shows H0 for skill X; server's current_hash is H0 | Status returns `up-to-date`; no further RPC calls needed |
| `sync_status` — sidecar missing (fresh clone) | bob clones a repo with a `.claude/skills/code-review/` dir but no `<repo>/.ark/skills-state/` sidecar; server has the matching skill | Server returns `status=unknown`; CLI proceeds to `get_with_ancestor` unconditionally; if local file matches ancestor body → reclassifies as `fast-forward-pull`, else → `conflict` |
| `sync_status` — server-ahead | bob's sidecar H0; server H1; local file matches H0 (no local edits) | Status returns `fast-forward-pull` (CLI computed); CLI calls `get_with_ancestor` to fetch the new content and writes locally |
| `sync_status` — local-ahead | bob's sidecar H0; server H0; local file hashes to H_local != H0 | Status returns `local-ahead` (CLI computed); CLI calls `skillhub/put` |
| `sync_status` — conflict | bob's sidecar H0; server H1; local file hashes to H_local != H0 | Status returns server's H1 (server-ahead); CLI detects local-ahead too → classifies as `conflict`; CLI calls `get_with_ancestor` and then runs the local 3-way merge |
| `get_with_ancestor` returns ancestor + current | Conflict scenario above | Response includes `ancestor_body`, `ancestor_supporting_files`, `server_body`, `server_supporting_files`, both hashes |
| CLI merge — disjoint markdown edits | alice + bob edit different sections of SKILL.md | CLI produces `proposed_merge.body` containing both edits; `per_file_results[0].strategy = "llm"`, `merged = true` |
| CLI merge — overlapping markdown edits | alice + bob edit the same paragraph of SKILL.md | CLI produces `proposed_merge` with LLM-reconciled body; user accepts / rejects |
| CLI merge — non-markdown file (script) | alice + bob edit `scripts/run.py` | `per_file_results` entry for `scripts/run.py` has `strategy = "manual"`, `merged = false`, raw three-way included; CLI shows raw for manual resolution in user's editor |
| CLI merge — non-markdown with explicit `llm` override | `harness_hints.merge_strategy: { "scripts/safe.py": "llm" }` | Override takes effect; `strategy = "llm"`, file goes through the CLI's `claude-agent` SDK call |
| CLI merge — no Anthropic credentials | `ANTHROPIC_API_KEY` unset, no `ark secrets` entry, no local `claude` install | `ark skills sync` fails fast with a clear, actionable error before any LLM call; `--no-merge` flag flips this into "treat every conflict as `requires_manual`" instead |
| CLI merge — SDK timeout or malformed output for one file | inject a fault for one file | CLI retries once via the SDK; on second failure marks that file `requires_manual: true` with raw three-way; other files in the same skill still get their successful merges |
| CLI merge — mixed file types in one skill | alice + bob both edit `SKILL.md` AND `scripts/run.py` | `per_file_results` shows `.md` with `strategy=llm, merged=true`; `.py` with `strategy=manual, merged=false`; CLI shows merged markdown + raw for script |
| `merge_input` audit-blob round-trip on `skillhub/put` | CLI sends `merge_input = {ancestor_hash, mine_hash, theirs_hash, llm_model, per_file_strategies, accepted_by}` with the put | New `skill_versions` row has `merge_input_json` populated with the supplied blob; `skill_versions.changed_by` reflects ctx.userId (server-trusted, independent of any `accepted_by` in the blob) |
| Hash semantics — harness-frontmatter doesn't change hash | Two harness adapters render same canonical skill; hash both renders' SKILL.md after parsing | Both yield identical `local_hash` (frontmatter differences live in `harness_hints`, not the hash) |
| Hash semantics — supporting file edit changes hash | Edit `references/spec.md`; SKILL.md unchanged | `local_hash` changes (supporting files are part of the bundle) |
| Normalizer determinism | `normalize(body, "claude")` called twice with the same input | Both calls return byte-identical output |
| Normalizer idempotency | `normalize(normalize(body, "claude"), "claude")` | Equals `normalize(body, "claude")` (already-canonical input is unchanged) |
| Normalizer pattern coverage — `$ARGUMENTS[N]` | Body contains `Use $ARGUMENTS[0] and $ARGUMENTS[1]` | Output contains `Use <the 1st argument> and <the 2nd argument>` |
| Server + CLI produce identical hash | CLI computes hash via `core/skills/hash.ts` + `core/skills/normalizer.ts`; server re-normalizes and re-hashes the same input on `skillhub/put` | Both yield identical hash; `sync_status` reports `up-to-date` immediately after `put` |
| Alice authors Claude-flavored, Bob reads as Cursor | Alice uploads `SKILL.md` containing `$ARGUMENTS[0]` with `--harness claude`; Bob in same team syncs with `--harness cursor` | Alice's re-sync (Claude) renders her ORIGINAL `$ARGUMENTS[0]` body (from `harness_hints.claude.original_body`); Bob's Cursor render shows the NORMALIZED `<the 1st argument>` body |
| Alice re-edits after upload | Alice uploads Claude-flavored body, then edits her local `.claude/skills/foo/SKILL.md`, then re-puts | Server normalizes the edit, updates `body` (canonical) AND `harness_hints.claude.original_body` (raw); `skill_versions` row added |
| Force overwrite — user-scope (no admin) | alice (non-admin) calls `skillhub/put force=true` on her own `visibility=user` skill with stale `expected_current_hash` | Accepted; ownership check passes |
| Force overwrite — team-scope (admin required) | Team admin calls `skillhub/put force=true` on `visibility=team` skill | Accepted; admin gate passes |
| Force overwrite — team-scope without admin | Non-admin member calls `skillhub/put force=true` on a team skill | 403 forbidden |
| Force overwrite — non-owner on user-scope | bob calls `skillhub/put force=true` on alice's `visibility=user` skill | 403 forbidden (ownership gate) |
| Sync `--dry-run` | Repo has 2 local skills, server has 1 update + 1 fast-forward | CLI prints the planned per-skill actions; no files written; no state sidecar updates |
| Adapter round-trip | One canonical skill in DB | Render → claude file → re-parse → `LocalSkill` matches the canonical record's parseable fields (no id/scoping/audit fields, but content + tags + harness_hints byte-identical) |
| Repo detection — Claude only | `cd` to tmpdir with `.claude/skills/` | `ark skills sync` infers claude harness, writes to `.claude/skills/<name>/SKILL.md` |
| Repo detection — Cursor only | `cd` to tmpdir with `.cursor/skills/` | Writes to `.cursor/skills/<name>/SKILL.md` |
| Repo detection — multi-harness | `cd` to tmpdir with both `.claude/skills/` and `.cursor/skills/` | Writes to both — one set of files per harness |
| Repo detection — custom path via config | `<repo>/.ark/config.yaml` with `read_paths: [.foundry/skills]` | Sync walks `.foundry/skills/` in addition to standard paths |
| Repo detection — scoping override | Tenant has `skill.default_harness=claude`; repo has no skill dirs | Cascade resolves to claude; writes to `.claude/skills/` |
| Repo detection — none + interactive | Empty tmpdir, TTY attached | Prompts user; on choice, persists to `<repo>/.ark/config.yaml` |
| Repo detection — none + non-interactive | Empty tmpdir, `--no-interactive` | Errors with clear message |
| Multi-file skill round-trip | Canonical with `body` + `supporting_files: [{path,content}]` | Renders directory with `SKILL.md` + supporting files; re-parse yields byte-identical canonical bundle |
| Adapter registry extensibility | Third-party adapter file dropped into `packages/skill-adapters/` | Auto-detected by registry; `ark skills sync` writes to its `defaultWritePath()` |

No remote daemon, no production deploy, no SSL. Everything runs against `localhost:19400`.

---

## 9. Decisions

### Q1: Cross-tenant skill visibility → **DECIDED: strict isolation**

Skills are NOT visible across tenants in v1. The `requireSameTenant` gate from PR #568 applies to all team-scope and tenant-scope skill rows.

The `visibility` enum keeps `cross_tenant` as a forward-compat slot, but `skillhub/put` rejects writes with `visibility=cross_tenant` ("creating cross_tenant skills is not supported"). When the system-admin role lands later, the promotion path opens with **one small schema migration** to add a fourth partial unique index for `visibility='cross_tenant'` rows (`idx_skills_cross_tenant_name_live`); migration 022 doesn't include this index because no `cross_tenant` rows exist in v1. See the inline note in `022_skills_sqlite.ts` / `022_skills_postgres.ts` for the exact follow-up. (We avoided the literal word "public" so the column doesn't read as "internet-public" — that would be a foot-gun for anyone scanning the schema or skill rows.)

Considered alternatives — opt-in cross-tenant publishing, cross-tenant by default — both rejected for v1 in favor of conservative privacy semantics consistent with the rest of the auth model.

### Q2: Universal-format authoring vs harness-native authoring → **DECIDED: strip and normalize on upload**

When a user uploads a harness-flavored SKILL.md (e.g. with Claude's `disable-model-invocation` frontmatter and `$ARGUMENTS[0]` body syntax), the server:

1. **Strips harness-specific frontmatter** into `harness_hints.<harness>` (preserving the original fields losslessly).
2. **Normalizes the body** to remove harness-specific syntax (e.g. `$ARGUMENTS[0]` → `<the first argument>`, Claude-specific variable references stripped or substituted). Body normalization uses a **deterministic regex-based normalizer module** in v1; LLM-driven normalization is a future enhancement.
3. **Preserves the author's raw body** in `harness_hints.<harness>.original_body` so the author's next sync to their own harness returns their exact original content.
4. **Stores the canonical (normalized) body** in `skills.body` so other harnesses get a clean tool-neutral version.

This is "the smart engine" framing from the original requirements call. Implementation impact + design in §7 "Normalizer module."

Considered alternatives:
- (a) Store-as-is — rejected because Claude-flavored body syntax (`$ARGUMENTS[0]`) leaks into other harnesses' renders.
- (c) Reject non-canonical input — rejected as too strict for v1 (most existing skills are tool-flavored, would fail upload).

**Telemetry to validate the decision (~5 LoC, lands with the Cursor + Codex adapters):** In every **non-Claude** adapter's `render()`, when the input `CanonicalSkill.harnessHints.claude` is non-empty, emit a single counter event (e.g. `skillhub.cross_harness_render` with tags `{ source_harness: "claude", target_harness: "cursor" | "codex" }`). This gives us a measured signal on how often a Claude-authored skill's canonical form is actually consumed by a non-Claude harness — the consequence that justifies normalizing in the first place. If the counter stays near zero after a few months, option (a) "store as-is" becomes a defensible simplification we could revisit. Counter only — no payload, no PII; budgets and labels follow the existing `packages/core/observability` conventions.

---

## 10. Out of scope (explicitly)

- **`ark login` / OIDC device flow.** Existing limitation. Not blocking Skill Hub.
- **Foundry / Ark CLI merge or rename.** Separate work stream.
- **Repo analysis / checks** from foundry_og (the existing dashed-line Foundry CLI capabilities).
- **Flow/agent integration** — skills will eventually be invocable inside session flows, but that work is independent of Skill Hub and lands separately.
- **Migration of the 7 builtin YAML skills into DB.** Builtins stay file-backed. Forever-supported as "system" skills always visible.
- **In-tenant customization of a builtin** is supported by *shadowing*, not by editing the builtin file: a tenant admin (or any user under the existing put gates) creates a DB skill with the **same `name`** at `visibility=tenant` (or `team`, or `user`). The skill resolver — both the CLI's local merge of `skillhub/list` results and any future server-side resolution — preferences the DB row over the same-named builtin within that scope, so the tenant's users see the customized version. **When multiple shadows exist at different visibility levels for the same caller, the resolver applies the existing scoping precedence: `user` > `team` > `tenant` > builtin** (mirrors `scoping_overrides` exactly). The builtin row is never mutated; deleting whichever DB shadow currently wins reveals the next layer down. This shadow model is declared here so the semantics are clear; implementation lives in the CLI's list-merge + the future server-side resolver and is not in v1 scope beyond the on-paper declaration.
- **User-facing "fork" operation.** The `skill_versions` table gives us version history, but exposing a `fork-into-private-scope` CLI is a follow-up. Today, if you want to derive from someone else's skill, `ark skills get` then `put` under a new name.

---

## 11. Implementation order

Build order for a single PR. Substantial change — ~26 steps across backend, adapters, CLI, and an optional dashboard surface. Grouped by layer; within a group, items are parallelizable.

### Backend (schema + repos + handlers)

1. **Schema migration** (~120 lines drizzle, both sqlite + postgres). Adds `skills` (with nullable `tenant_id` and `visibilityScopeCheck` constraint) + `skill_versions` tables. Both variants use `text` for `supporting_files_json` and `harness_hints_json` (codebase convention; see §3). Migration number TBD.
2. **Extend `scoping_overrides` resolver validation** to accept the one new key (`skill.default_harness`). No schema change — expand the validation allowlist in the resolver. (`skill.merge_model` and `skill.merge_disabled` were dropped after the merge moved client-side in §7.)
3. **`SkillRepo`** in `packages/core/repositories/skills.ts` mirroring `MembershipRepository`. CRUD with visibility-aware queries:
   - `listVisibleTo(userId, ctxTenantId)`: union of (user-scope owned by userId, any tenant) + (team-scope rows in caller's team-chain) + (tenant-scope rows for ctxTenantId).
   - Version-write inside a single transaction (insert `skill_versions` row, then update `skills.current_hash`).
4. **`SkillVersionRepo`** in the same file for ancestor-body lookups by `(skill_id, version_hash)`.
5. **Canonical-bundle hasher** in `packages/core/skills/hash.ts` — deterministic sha256 over `{ body, supporting_files }` with sorted keys, no whitespace variation. Single source of truth for both server-side current_hash writes and CLI local_hash computation (imported by the CLI too).
6. **Normalizer module** in `packages/core/skills/normalizer.ts` — deterministic regex-based body + supporting-file normalization (see §7). Idempotent. Same pattern table runs on both server (during `skillhub/put`) and CLI (before computing local_hash and during the post-merge canonicalization pass per §7). Imported by both. Tests for determinism, idempotency, and the v1 pattern coverage. ~150 LoC.
7. **`skillhub/list`, `skillhub/get` handlers** in `packages/conductor/handlers/skill.ts`. Visibility-aware: user-scope rows bypass `requireSameTenant` when caller is the owner; team/tenant-scope rows use the existing gate.
8. **`skillhub/sync_status` handler** — fast path. Takes `{ local_versions: [{ skill_id, local_hash? }] }` (`local_hash` optional per entry — missing/null returns `unknown`). Returns per-skill `{ status, server_hash }` with no bodies. No LLM. Visibility-aware filter applied per skill before reporting.
9. **`skillhub/get_with_ancestor` handler** — fast path. Takes `{ skill_id, ancestor_hash? }`. Loads `skills` row + (if `ancestor_hash` provided) the `skill_versions` row whose `version_hash` matches it. Returns `{ server_body, server_supporting_files, server_hash, server_harness_hints, ancestor_body?, ancestor_supporting_files?, ancestor_hash? }` — ancestor fields included only when `ancestor_hash` was supplied AND found. 404 if `ancestor_hash` was supplied but the matching version row doesn't exist (e.g., hard-deleted skill).
10. **`skillhub/put` handler** — optimistic-lock check on `expected_current_hash`, 409 on mismatch. On match: invokes the normalizer (step 6) on body + supporting_files → canonical bundle; stores canonical in `skills.body` + `skills.supporting_files`; preserves the raw original in `harness_hints.<harness>.original_body` / `.original_supporting_files` (only when it differs from canonical — see §7); writes `skill_versions` row; updates `skills.current_hash`. Rejects `visibility=cross_tenant` (§9 Q1 decision). Handles `force: true` with visibility-aware gates (user-scope: ownership; team/tenant-scope: requireAdmin). Accepts an optional opaque `merge_input` blob from the CLI when this put is the result of an accepted client-side 3-way merge (§7 LLM contract) and persists it to `skill_versions.merge_input_json`.
11. **`skillhub/delete`, `skillhub/search`, `skillhub/published_after`, `admin/skillhub/list` handlers** — straightforward, follow the §4 gates.
12. **Handler tests** in `packages/conductor/handlers/__tests__/skill.test.ts` covering the full §8 matrix: scoping isolation, **consultant-pattern user-scope cross-tenant visibility**, the four sync-status cases, `merge_input` audit-blob round-trip on `skillhub/put`, force overwrite gated per visibility, put-409 retry, hash invariance under harness frontmatter differences, normalizer determinism + idempotency + Claude pattern coverage + alice/bob alice-re-edit round-trips. **Ordering note:** these handler tests appear before steps 13-16 (adapter framework) but **do not depend on `packages/skill-adapters/`**. They construct request payloads by hand (RPC-shaped objects) rather than going through `adapter.parse()` / `adapter.render()` — the adapter framework is a CLI dependency, not a handler-test dependency. So the linear numbering doesn't imply a build-order constraint: step 12 can land before, after, or in parallel with steps 13-16.

### Adapter framework

13. **Adapter types and registry** in `packages/skill-adapters/types.ts` (`CanonicalSkill`, `LocalSkill`, `SupportingFile`, `WrittenFile`, `HarnessAdapter`) and `packages/skill-adapters/index.ts` (registry array). Pure types + empty registry until adapters land.
14. **Claude adapter** in `packages/skill-adapters/claude.ts` — implements `readPaths()` (project + user-home), `defaultWritePath()`, `parse()` (returns `LocalSkill`), `render()`. Tests use the §13 worked example as fixtures.
15. **Cursor adapter** in `packages/skill-adapters/cursor.ts` + tests.
16. **Codex adapter** in `packages/skill-adapters/codex.ts` + tests.

### CLI

17. **`<repo>/.ark/config.yaml` parser + writer** in `packages/cli/skills/config.ts`. Loads optional file, validates shape (`read_paths`, `write_to`, `enabled_harnesses`). Writer used by Layer 4 auto-persist + `--dir` save-as-default prompt.
18. **Detection cascade** in `packages/cli/skills/detect.ts` — implements Layers 1, 2, 3, 4 from §5 (note: user-home + heuristics layers explicitly deferred from v1 per §5). Layer 4 (interactive prompt) auto-persists via the config writer.
19. **Sync-state sidecar I/O** in `packages/cli/skills/state.ts` — read/write `<repo>/.ark/skills-state/<harness>-<skill>.json` per §7. JSON payload: `{ skill_id, current_hash }`. Gitignore the directory if not already.
20. **`ark skills list/get/put/delete`** in `packages/cli/commands/skill.ts`. Bearer auth via existing CLI infra. `put` reads local dir via adapter `parse()` → `LocalSkill`, normalizes via the shared normalizer, computes hash via the shared hasher, calls server's `skillhub/put` with `expected_current_hash` from the sidecar. `--force` flag supported.
21. **`ark skills sync`** — orchestrates the two server RPCs **plus the client-side merge**:
    - call `skillhub/sync_status` → for each non-up-to-date skill, fetch `skillhub/get_with_ancestor`
    - **for `fast-forward-pull`:** write server content + update sidecar
    - **for `conflict`:** prompt user to run the local LLM merge. On opt-in:
      - resolve Anthropic credentials in this order: `ANTHROPIC_API_KEY` env, `CLAUDE_CODE_OAUTH_TOKEN` env, `ark secrets` entry (`skill-merge-anthropic-token`), local `claude` CLI's stored auth. **No creds → fail the sync with a clear, actionable message** (env vars + `ark secrets set` command).
      - per file (per the §7 file-type strategy table; `harness_hints.merge_strategy` overrides if present): markdown → invoke the linked `@anthropic-ai/claude-agent-sdk` with a 3-way prompt (ancestor + mine + theirs); non-markdown → `requires_manual` with raw three-way for the user's editor.
      - run the shared `packages/core/skills/normalizer` over the SDK output (safety net per §7).
      - assemble `proposed_merge`; show to user; user accepts / rejects / edits.
      - on accept: call `skillhub/put` with the merged body + supporting_files + `merge_input = { ancestor_hash, mine_hash, theirs_hash, llm_model, per_file_strategies, accepted_by }` so the audit row carries provenance.
    - `--dry-run` mode short-circuits before any LLM call.
    - `--no-merge` flag: skip the LLM call even with creds present; treat every conflict as `requires_manual`.
22. **`ark skills install <id>`** — single-skill pull (same plumbing as sync, but one skill).
23. **`ark skills search`**.
24. **CLI discovery banner** — on sync, surfaces `skillhub/published_after` results as "N new skills available since last sync."
25. **CLI integration tests** covering Bearer auth, the 4-layer detection cascade, multi-harness writes, client-side merge flows end-to-end (creds-present + creds-missing + `--no-merge`), force overwrite per visibility, `--dry-run`.

### Dashboard (optional in v1; can fast-follow)

26. **Admin Skills tab** mirroring the existing Tenants/Teams/Users/Scoping tabs from PR #567. List, edit, audit drawer (reads `skill_versions` history with `merge_input_json` provenance including per-file strategies).

Acceptance demo: run `ark skills sync` in a Claude Code repo, see the user's team's skills materialize as `.claude/skills/<name>/SKILL.md` files (including supporting files). Edit one locally, run `ark skills put`. Have a teammate edit the same skill from the dashboard. Re-run `ark skills sync`: see the conflict reported, opt into the local LLM merge, watch the proposed merge appear (with markdown-merged sections and any non-markdown supporting files surfaced for manual resolution). Accept, push back to server — the audit row on `skill_versions` carries the merge provenance from the CLI's `merge_input` blob.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Claude Code or Cursor changes their skill format mid-flight | Adapter layer is pure-function and per-harness; one PR to update without touching backend/schema |
| Bearer-token UX is painful enough that no one adopts | Internal pilot first; pain is real but bounded. Watch for adoption; if blocked, prioritize `ark login` (OIDC device flow) |
| Cross-tenant question (Q1) gets answered "yes, cross-tenant by default" after the schema lands with strict isolation | Schema is forward-compatible — `visibility=cross_tenant` already a slot; only a policy change in the resolver |
| LLM merge produces a bad reconciliation that the user accepts without reading | Mitigated by always surfacing the proposed merge for human accept/reject — never silently applied. Audit trail in `skill_versions.merge_input_json` lets us trace which LLM produced any merged version |
| Importer has no Anthropic credentials when they hit a conflict | The CLI auto-discovers creds in order: `ANTHROPIC_API_KEY` env, `CLAUDE_CODE_OAUTH_TOKEN` env, `ark secrets` entry (`SKILLHUB_ANTHROPIC_TOKEN`). If nothing is found, sync fails fast with a clear, actionable message (the env var to set, the `ark secrets set` command, or `ark skills sync --no-merge` to fall through to manual resolution). No silent fallback. Cost lands on the importer's account (their tokens) so the platform has no LLM budget to govern, and conductor stays out of the LLM call path entirely. |
| Per-file LLM merge cost scales with multi-file skills | Cost lands on the importer's own Anthropic account (CLI uses their credentials directly), so this is a per-user concern not a platform concern. Merges fire only on conflict AND only when the user opts in; a 5-file conflict costs 5× a single-file merge against their Anthropic plan. If this becomes painful for very large skills, the CLI's `claude-agent` SDK call can later batch all files into one prompt |
| LLM-produced non-markdown code is well-formed but semantically wrong | Default CLI policy returns `requires_manual: true` for non-markdown extensions (`.py`, `.js`, `.sh`, `.json`, etc.) instead of LLM-merging them; user resolves in their editor. Users who want LLM merge on a specific non-markdown file opt in explicitly via `harness_hints.merge_strategy` |
| Multi-file skill blob grows >100KB and per-row writes become slow | Documented as a known scaling caveat in §3; migration path is a side table `skill_files(skill_id, version_hash, path, content)` with per-file update locality. Not in v1 |
| The 7 builtin YAML skills feel "second-class" once DB skills exist | Acceptable trade-off. Builtins are visible to everyone, no auth needed; DB skills are visible only to the right scope. Different model, both legitimate |
| `skill_versions` table grows unbounded | All versions are tied to a live `skills` row via FK with `ON DELETE CASCADE`; hard-deleting a skill clears its history. A tombstone GC for old soft-deleted skills can compact this if storage becomes a concern |

---

## 13. Appendix: Worked example

The same `code-review` skill in canonical form and rendered to three harnesses. Since the Agent Skills open standard has converged the formats, the **`SKILL.md` content is byte-identical** across all three; the only difference is the file path.

### Canonical (as stored in the `skills` table)

`tenant_id` below is `"default"` — the literal string seeded by migration `003_tenants_teams_*` (see the auth doc Part 1). Tenants are NOT named with arbitrary strings; this is the seeded default tenant id. Real tenants use ids like `"t-acme"` from the Part 4 §"Create a new tenant" recipe.

```json
{
  "id": "skl-abc123def456",
  "tenant_id": "default",
  "team_id": null,
  "owner_user_id": null,
  "visibility": "tenant",
  "name": "code-review",
  "description": "Reviews code changes for bugs, style, and best practices. Use when user says 'review my code', 'do a code review', or '/code-review'.",
  "category": "review",
  "tags": ["review", "quality", "verification"],
  "body": "# code-review\n\nReview the code changes in the current branch (`git diff main...HEAD`).\n\n## input\n\n`$ARGUMENTS` = `[base-branch]` (default: `main`)\n\n## checks\n\nWalk every changed file and look for:\n\n1. **Bugs** -- logic errors, off-by-one, null deref, race conditions\n2. **Security** -- injection vectors, missing auth checks, secrets in code\n3. **Performance** -- N+1 queries, unbounded loops, memory leaks\n4. **Style** -- naming, length, comments, dead code\n\n## output\n\nRate each issue P0-P3 (P0 = blocker, P3 = nit). Suggest a specific fix with code.\n\nFinal verdict: PASS | WARN | FAIL.\n",
  "supporting_files": [
    {
      "path": "references/severity-rubric.md",
      "content": "# Severity rubric\n\n- **P0 (blocker):** ... \n- **P1 (high):** ...\n- **P2 (medium):** ...\n- **P3 (nit):** ...\n"
    }
  ],
  "harness_hints": {
    "claude": {
      "disable-model-invocation": false,
      "allowed-tools": ["Bash(git *)"]
    },
    "cursor": {},
    "codex": {}
  },
  "current_hash": "sha256:e8c2b4f1...",
  "upstream_id": null,
  "created_by": "u-alice",
  "created_at": "2026-05-13T10:00:00Z",
  "updated_at": "2026-05-13T10:00:00Z"
}
```

### Rendered to Claude Code (`.claude/skills/code-review/`)

Directory layout:
```
.claude/skills/code-review/
├── SKILL.md
└── references/
    └── severity-rubric.md
```

`SKILL.md`:
```markdown
---
name: code-review
description: Reviews code changes for bugs, style, and best practices. Use when user says 'review my code', 'do a code review', or '/code-review'.
disable-model-invocation: false
allowed-tools:
  - Bash(git *)
---

# code-review

Review the code changes in the current branch (`git diff main...HEAD`).

## input

`$ARGUMENTS` = `[base-branch]` (default: `main`)

## checks

Walk every changed file and look for:

1. **Bugs** -- logic errors, off-by-one, null deref, race conditions
2. **Security** -- injection vectors, missing auth checks, secrets in code
3. **Performance** -- N+1 queries, unbounded loops, memory leaks
4. **Style** -- naming, length, comments, dead code

## output

Rate each issue P0-P3 (P0 = blocker, P3 = nit). Suggest a specific fix with code.

Final verdict: PASS | WARN | FAIL.
```

The Claude-specific frontmatter fields (`disable-model-invocation`, `allowed-tools`) come from `harness_hints.claude` in the canonical record.

### Rendered to Cursor (`.cursor/skills/code-review/`)

Identical directory layout. `SKILL.md` content **is the same as Claude's**, minus the Claude-specific frontmatter fields (Cursor wouldn't understand them, and `harness_hints.cursor` is empty in this example):

```markdown
---
name: code-review
description: Reviews code changes for bugs, style, and best practices. Use when user says 'review my code', 'do a code review', or '/code-review'.
---

# code-review

Review the code changes in the current branch (`git diff main...HEAD`).

... (body unchanged) ...
```

Same supporting files at `.cursor/skills/code-review/references/severity-rubric.md`.

### Rendered to Codex (`.codex/skills/code-review/` or `.agents/skills/code-review/`)

Identical layout and content to the Cursor render — same SKILL.md (without Claude-specific frontmatter), same `references/severity-rubric.md`. The only difference is the parent directory path, which the adapter's `defaultWritePath()` provides (and which the user can override via `<repo>/.ark/config.yaml:skills.write_to.codex`).

### Variant: user-scope (consultant pattern)

The example above is a tenant-scope skill. For comparison, here's what alice's *personal* `code-review` skill looks like — note `tenant_id` is **null** so the skill follows her across every tenant she works in:

```json
{
  "id": "skl-personal-abc",
  "tenant_id": null,                                          // ← consultant pattern: NULL for user-scope
  "team_id": null,
  "owner_user_id": "u-alice",
  "visibility": "user",
  "name": "code-review",
  "description": "alice's personal review preferences",
  "category": "review",
  "tags": ["personal"],
  "body": "...",
  "supporting_files": [],
  "harness_hints": { "claude": { "disable-model-invocation": false } },
  "current_hash": "sha256:f3a1...",
  "upstream_id": null,
  "created_by": "u-alice",
  "created_at": "2026-05-13T10:00:00Z",
  "updated_at": "2026-05-13T10:00:00Z"
}
```

`skillhub/list` returns this row for alice regardless of which tenant's session she's authenticated in. The `requireSameTenant` gate is bypassed because `ctx.userId === skill.owner_user_id`. No other user can see this skill — not even an admin in any tenant.

### What this demonstrates

- One canonical record renders to N harnesses with **byte-identical SKILL.md body**.
- Per-harness frontmatter extensions live in `harness_hints` and are emitted only when rendering to that harness.
- Supporting files round-trip through `supporting_files` array — the directory shape is preserved end-to-end.
- User-scope skills are tenant-agnostic (`tenant_id: null`), supporting the consultant pattern where one user works across multiple tenants.
- Adding a new harness (e.g. Goose) ships as a new adapter file with its own `readPaths()`, `defaultWritePath()`, `parse()`, and `render()`. No schema or core CLI changes.
