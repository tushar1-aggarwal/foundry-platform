# Phase 2: Hierarchical Secrets Resolver (Router Architecture)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** supersedes the per-tenant DEK + cipher + `secret_bindings`-table sections of `docs/superpowers/specs/2026-05-13-hierarchical-secrets-design.md`. See "Architecture decision" below.

**Goal:** Ship a hierarchical secrets resolver that walks `user -> teamChain -> tenant` against the configured `SecretsCapability` backend using a path convention, places the per-session effective set into `placeAllSecrets`, and replaces the legacy YAML `secrets: [NAMES]` allowlist in `runtimes/*.yaml` as the source-of-truth for what reaches an agent.

**Tech Stack:** TypeScript (ES modules, `.js` extensions), Bun + `bun:test`, existing `SecretsCapability` providers (`packages/core/secrets/file-provider.ts`, `aws-provider.ts`), `@aws-sdk/client-ssm` (already a root dep) for `GetParametersByPath`. No new external deps.

**Source specs:**
- `docs/superpowers/specs/2026-05-13-hierarchical-secrets-design.md` (parent -- scope/policy/audit intent preserved; encryption + DEK + bindings sections superseded by this plan)
- `docs/superpowers/specs/2026-05-14-ssm-kek-backend.md` (Phase 1 -- preserved; not on the critical path of Phase 2)

---

## Architecture decision (supersedes parent D2 final state + the entire per-tenant DEK section)

Architecture A from the parent spec (per-tenant DEK wrapping ciphertext stored in a new `secret_bindings` table, encrypted at rest in Ark's DB) is replaced by Architecture B: **the configured backend is the source of truth**; Ark stores no secret values, no ciphertext, no DEK. The resolver is pure code: walks the backend by path convention, first-hit-per-key wins.

**Why:**
1. SSM (and Vault, when added) already provide encryption-at-rest, access control, and audit. Re-implementing those in Ark duplicates well-trodden infrastructure and creates drift risk.
2. The four existing identity tables (`tenants`, `teams.parent_team_id`, `memberships`, `sessions_auth.teamChain`) already encode the scope structure. The resolver consumes them; nothing new in the schema.
3. Set/unset becomes a single op (one `PutParameter`). With Architecture A it was a two-phase `INSERT secret_bindings ... + KMS encrypt + write ciphertext`, with desync windows.
4. The implementation surface shrinks from ~10 tasks to ~6 with smaller per-task scope.

**What this means for Phase 1 (already shipped):**
- `packages/secrets/kek/*` stays. It's the SSM-mechanics proving ground and the boot-time KEK eager-load still runs.
- The KEK is **not** on the read path of Phase 2. It would re-enter critical-path only if a future `file` backend wants Ark-side at-rest encryption for laptop dev. Until then it is intentionally vestigial.
- `ARK_KEK_TEST_STUB=1` remains the local-dev escape hatch for AppContext boot.

**Path convention (the binding):**

```
/ark/<tenant_id>/tenant/<KEY>
/ark/<tenant_id>/teams/<team_path>/<KEY>      # team_path = slash-joined ancestor chain, root -> leaf
/ark/<tenant_id>/users/<user_id>/<KEY>
```

Validation:
- `tenant_id`, `user_id`, each team segment: slug regex `[a-z0-9][a-z0-9-]{0,62}`; reject `..` and `.`-prefix at write time.
- `KEY`: matches the existing secret name regex `[A-Z][A-Z0-9_]*`.
- SSM parameter name max = 2048 chars; deepest legal path (5-level team, max-length slugs, max-length key) is comfortably under.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/secrets/resolver/paths.ts` | Encode + parse + validate `/ark/<tid>/...` paths. Pure functions. |
| `packages/secrets/resolver/resolver.ts` | `HierarchicalSecretResolver` class: enumerate per-scope keys, merge with first-hit-wins precedence, batch-fetch winners. |
| `packages/secrets/resolver/__tests__/paths.test.ts` | Path round-trips, slug rejection, key regex enforcement. |
| `packages/secrets/resolver/__tests__/resolver.test.ts` | Mocked-provider tests for precedence, missing scopes, empty inputs. |
| `packages/secrets/resolver/__tests__/resolver.localstack.test.ts` | LocalStack-backed integration; `describe.skip` when docker unavailable. |
| `packages/core/secrets/types.ts` (modify) | Extend `SecretsCapability` interface with `listAt(prefix)` + `batchGet(paths)`. |
| `packages/core/secrets/aws-provider.ts` (modify) | Implement `listAt` via paginated `GetParametersByPath`, `batchGet` via batched `GetParameters` (10/req). |
| `packages/core/secrets/file-provider.ts` (modify) | Implement `listAt`/`batchGet` over the JSON store using the path convention as a flat key prefix. |
| `packages/core/services/dispatch/secrets-resolve.ts` (modify) | Replace the runtime-YAML allowlist walk with a `HierarchicalSecretResolver.resolveAll(session)` call. |
| `runtimes/claude-agent.yaml` (modify) | Remove the `secrets:` field. Stage-level `secrets:` retained as an optional "must-be-present" assertion (fail dispatch if any listed key didn't resolve). |
| `packages/cli/commands/secrets/set.ts` (modify) | Add `--scope <tenant|team|user>` + `--scope-id <id>`. Bare invocation defaults `--scope tenant`. |
| `packages/cli/commands/secrets/list.ts` (modify) | `--scope <tenant|team|user>` + `--scope-id <id>` filter. No-args = "everything visible". |
| `packages/cli/commands/secrets/delete.ts`, `get.ts`, `describe.ts` (modify) | Same scope flags. |
| `docs/secrets-usage.md` (create) | Short operator doc: the convention, the CLI, the resolution algorithm with a worked example. |

No new DB migration. No schema changes.

---

## Task 1: Path convention module

**Files:** `packages/secrets/resolver/paths.ts`, `packages/secrets/resolver/__tests__/paths.test.ts`

- [ ] Implement `tenantPath(tid, key)`, `teamPath(tid, teamChainSegments[], key)`, `userPath(tid, uid, key)`.
- [ ] Implement `parsePath(p)` -> `{ tenant, scopeKind, scopeId, key } | null` for parsing back.
- [ ] Implement `validateSegment(s)` and `validateKey(k)`. Hard-fail on `..`, `/`, leading dot.
- [ ] Tests: round-trip every shape; reject invalid segments; reject keys not matching `[A-Z][A-Z0-9_]*`; assert max-length math.

**Verification:** `bun test packages/secrets/resolver/__tests__/paths.test.ts` green. Atomic commit: `feat(secrets): path-convention helpers for hierarchical resolver`.

---

## Task 2: SecretsCapability interface extension

**Files:** `packages/core/secrets/types.ts` (or wherever the interface lives), `packages/core/secrets/__tests__/secrets-capability.test.ts`

- [ ] Add two methods to the `SecretsCapability` interface:
  - `listAt(prefix: string): Promise<{ name: string }[]>` -- name is the full path, not just the leaf.
  - `batchGet(paths: string[]): Promise<Record<string, string>>` -- returns map of `path -> value`. Missing paths are absent from the map (no throw).
- [ ] Update existing implementations to compile (stubs throwing `NotImplemented` are fine for this task; real impls in tasks 3-4).

**Verification:** `make lint` + `bun test packages/core/secrets/` green. Atomic commit: `feat(secrets): extend SecretsCapability with listAt + batchGet`.

---

## Task 3: AwsSecretsProvider implementation

**Files:** `packages/core/secrets/aws-provider.ts`, `packages/core/secrets/__tests__/aws-provider.test.ts`

- [ ] Implement `listAt(prefix)` using `GetParametersByPathCommand` with `Recursive=true`, pagination via `NextToken`, until exhausted. Return `{ name: <full path> }` for each `Parameter`.
- [ ] Implement `batchGet(paths)` chunking input into groups of 10 (SSM limit), calling `GetParametersCommand` for each chunk with `WithDecryption=true`. Merge results into a single map.
- [ ] Errors: surface AWS error codes the same way `SsmKekBackend` does (no key bytes in errors, no path bytes for non-Parameter errors).
- [ ] Tests: mocked SSM client. Pagination: 2-page list returns combined results. Batch: 17 paths -> 2 chunks (10 + 7). Missing paths: absent from map. AccessDenied surfaces error code.

**Verification:** `bun test packages/core/secrets/__tests__/aws-provider.test.ts` green. Atomic commit: `feat(secrets): listAt + batchGet on AwsSecretsProvider`.

---

## Task 4: FileSecretsProvider implementation

**Files:** `packages/core/secrets/file-provider.ts`, `packages/core/secrets/__tests__/file-provider.test.ts`

- [ ] The file store today is a flat `Record<tenant, Record<name, FileStoredSecret>>`. For the convention to work, names ARE the full paths (`/ark/<tid>/...`). Migration: existing flat names (e.g. `ANTHROPIC_API_KEY`) live under the tenant scope; treat them as `/ark/<tid>/tenant/ANTHROPIC_API_KEY` for reading purposes, store/move them under that key on the next write (lazy migration).
- [ ] Implement `listAt(prefix)`: filter entries whose name starts with `prefix`.
- [ ] Implement `batchGet(paths)`: lookup each path; absent if missing.
- [ ] Tests: legacy flat name returns under tenant prefix; user/team paths returned only when prefix matches; missing paths absent.

**Verification:** `bun test packages/core/secrets/__tests__/file-provider.test.ts` green. Atomic commit: `feat(secrets): listAt + batchGet on FileSecretsProvider`.

---

## Task 5: HierarchicalSecretResolver

**Files:** `packages/secrets/resolver/resolver.ts`, `packages/secrets/resolver/__tests__/resolver.test.ts`

- [ ] Class `HierarchicalSecretResolver` constructor takes a `SecretsCapability`.
- [ ] Method `resolveAll(session)` -> `Promise<Record<string, string>>`:
  1. Read `tenant_id`, `user_id`, `teamChain` from session (use `sessions_auth.teamChain` if cached; fall back to a one-time DB walk).
  2. Call `provider.listAt(prefix)` in parallel for the user prefix, each team prefix, and the tenant prefix.
  3. Merge into `Map<key, fullPath>` with first-hit-per-key in scope order (user, then teams most-specific-first, then tenant).
  4. Call `provider.batchGet(Array.from(map.values()))`.
  5. Return `{ key: value }`.
- [ ] Method `assertPresent(session, requiredKeys[])`: optional. Used by stage-level `secrets:` lists when retained as a "must-be-present" assertion. Throws if any required key missing.
- [ ] Tests (mocked provider):
  - User overrides team overrides tenant for same key.
  - Disjoint keys at different scopes all included.
  - Empty scopes yield empty map (not throw).
  - Same key in two team levels: most-specific wins.

**Verification:** `bun test packages/secrets/resolver/__tests__/resolver.test.ts` green. Atomic commit: `feat(secrets): HierarchicalSecretResolver walks user -> team -> tenant via path convention`.

---

## Task 6: LocalStack integration test

**File:** `packages/secrets/resolver/__tests__/resolver.localstack.test.ts`

- [ ] Use the existing `localstack-ssm-helper.ts` pattern from Phase 1.
- [ ] Seed values: `/ark/t1/tenant/A=tenant-a`, `/ark/t1/teams/eng/B=team-b`, `/ark/t1/teams/eng/A=team-a`, `/ark/t1/users/u1/A=user-a`.
- [ ] Construct a session with `tenant_id=t1, user_id=u1, teamChain=["eng"]`.
- [ ] Resolver returns `{ A: "user-a", B: "team-b" }` (A wins at user scope; B only at team).
- [ ] `describe.skip` when docker unavailable.

**Verification:** With docker running: `bun test packages/secrets/resolver/__tests__/resolver.localstack.test.ts` green. Atomic commit: `test(secrets): LocalStack-backed end-to-end resolver test`.

---

## Task 7: Wire resolver into dispatch

**File:** `packages/core/services/dispatch/secrets-resolve.ts`

- [ ] Replace the runtime/stage YAML walk in `StageSecretResolver.resolve()` with:
  1. Call `HierarchicalSecretResolver.resolveAll(session)` to get the effective env-var set.
  2. If the stage def has a non-empty `secrets: [NAMES]` list, treat it as a `assertPresent` check (force-include / fail if missing). This preserves the legacy hard-fail behavior for stages that genuinely require a key, without making the YAML the source of WHAT to resolve.
  3. Return `{ env, error }` matching the existing contract.
- [ ] Update the docstring to describe the new precedence (resolver-first, YAML-as-assertion).

**Verification:** Existing dispatch tests pass (`bun test packages/core/services/dispatch/`). Atomic commit: `refactor(dispatch): use HierarchicalSecretResolver; YAML secrets: now an assertion only`.

---

## Task 8: Runtime YAML cleanup

**Files:** `runtimes/claude-agent.yaml`, `runtimes/claude-code.yaml`, `runtimes/codex.yaml`, `runtimes/gemini.yaml`, `runtimes/goose.yaml`, `runtimes/claude-max.yaml`

- [ ] Remove the `secrets:` field from each runtime YAML. After Task 7, this field is no-op for resolution and only confuses operators.
- [ ] Update any docs/comments referencing the runtime-YAML allowlist mechanism.

**Verification:** `make test` green; smoke session in Task 9 confirms ANTHROPIC_* still placed (now via tenant scope, not runtime YAML). Atomic commit: `chore(runtimes): drop superseded YAML secrets: allowlist`.

---

## Task 9: CLI scope flags

**Files:** `packages/cli/commands/secrets/{set,list,delete,get,describe}.ts`

- [ ] Add `--scope <tenant|team|user>` (default: `tenant`) and `--scope-id <id>` (required for non-tenant scopes).
- [ ] Translate CLI invocation -> path-conventioned write/read against the configured provider.
- [ ] Back-compat: `ark secrets set FOO=bar` writes to `/ark/<tid>/tenant/FOO`. Existing CI/scripts keep working.
- [ ] `ark secrets list` defaults to "everything visible to the caller in their tenant"; `--scope user --scope-id u1` filters to user u1.

**Verification:** Manual smoke: set a secret at each scope, list, get, delete. Unit tests on the CLI command wiring. Atomic commit: `feat(cli): scope flags on secrets set/list/get/delete/describe`.

---

## Task 10: End-to-end smoke against segmentation repo

- [ ] Seed:
  - `/ark/default/tenant/DEMO_USER=tenant-demo-user`
  - `/ark/default/users/<your-user-id>/DEMO_USER=user-demo-user` (override at user scope)
  - `/ark/default/tenant/DEMO_TOKEN=tenant-demo-token` (no override)
- [ ] Dispatch a `bare-auto` session against `/Users/tusharaggarwal/IdeaProjects/segmentation` with no inline-flow secrets allowlist.
- [ ] Confirm the agent's env contains:
  - `DEMO_USER=user-demo-user` (user scope wins)
  - `DEMO_TOKEN=tenant-demo-token` (only tenant scope present)
- [ ] Have the agent write `/tmp/resolver-smoke.txt` with both env values and a one-line report.
- [ ] Inspect the file from the host.

**Verification:** File contents match expectations. Atomic commit: `test(e2e): hierarchical secrets resolver smoke against segmentation repo`. (If smoke fails, fix root cause; do not paper over.)

---

## Task 11: Operator doc

**File:** `docs/secrets-usage.md`

- [ ] Short doc (~150 lines): the convention, the precedence rule, CLI cheatsheet, a worked example mirroring Task 10, and a "when do I want this" decision tree (tenant default vs team override vs user override).
- [ ] Link from `CLAUDE.md`'s schema-and-migrations section.

**Verification:** Doc renders cleanly; commands listed all work as documented. Atomic commit: `docs(secrets): operator usage guide for hierarchical resolver`.

---

## Acceptance criteria (work back from here)

- `bun test packages/secrets/` and `bun test packages/core/secrets/` green.
- `make test` green; no existing test needs the runtime-YAML `secrets:` allowlist to pass.
- LocalStack integration covers user-overrides-team-overrides-tenant for the same key.
- Task 10 smoke produces the expected file on the host.
- A dispatched session can read tenant-scoped, team-scoped, and user-scoped secrets without any YAML allowlist anywhere.
- `runtimes/*.yaml` no longer has a `secrets:` field; if a stage YAML still lists `secrets: [NAMES]`, those are treated as assert-present, not as filters.
- No new DB migration introduced by this plan.
- `make format && make lint` green.

## Intentional deviations from the parent design spec

These are the supersessions Phase 2 makes explicit. Surface in PR description so reviewers see them up-front.

- D2 (final state) -- legacy YAML-allowlist as the resolution source: **REPLACED.** Resolver enumerates from the backend per scope.
- Per-tenant DEK + `tenant_deks` table: **DROPPED.** Backend handles at-rest.
- AES-256-GCM cipher with AAD: **DROPPED.** No Ark-managed ciphertext.
- `secret_bindings` table: **DROPPED.** Path convention IS the binding.
- Encryption-at-rest in Ark DB: **DROPPED.** Backend handles at-rest.
- BYOK per tenant: still deferred; the convention can carry it later (e.g., per-tenant KMS key reference stored as an SSM parameter sibling).
- Audit log: deferred to a follow-up. SSM CloudTrail covers backend-side; an Ark-side audit is a separate concern.

## Out of scope (follow-ups)

Track separately; do NOT pull into this plan.

- Audit log table + write-path instrumentation
- Per-key policy (e.g., "locked at tenant" -> reject user-scope override at write time)
- HTTP/REST surface for secrets management
- Web UI for secrets
- Onboarding wizards (`ark onboard tenant|team|user`)
- Vault backend implementation
- Migration script for the legacy flat `secrets` table -> path-conventioned writes (one-time, can be done outside this plan)
- Per-session input narrowing if a stage genuinely wants fewer keys (today: stage-YAML `secrets:` as assert-present; future: explicit `agent.requires` declaration)
