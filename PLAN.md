# PLAN -- Phase 2: Hierarchical Secrets Resolver

**Source of truth:** `docs/superpowers/plans/2026-05-15-hierarchical-secrets-resolver.md` (11 tasks, file-by-file responsibilities). This document is a strategy + delta layer: it locks the exact wiring points in the current codebase, calls out the few decisions the source plan leaves to the implementer, and orders the work for atomic commits.

The earlier Phase 1 plan ("Execute SSM-backed KEK Backend") has shipped; commits `df218af5..260be8d9` and `95cc94ad`, `9471ae05` plus the prettier sweep are merged on this branch. This PLAN.md replaces that content as the working plan for Phase 2.

---

## 1. Summary

Replace the runtime/stage YAML `secrets:` allowlist with a path-walking resolver against the configured `SecretsCapability` backend. The resolver enumerates `/ark/<tid>/{users/<uid>|teams/<chain>|tenant}/<KEY>` for the dispatching session, merges with first-hit-per-key precedence (user > team-most-specific > tenant), and emits the effective env-var set to `placeAllSecrets`. The backend (SSM today, file in local-dev) is the source of truth -- Ark stores no secret values, no ciphertext, no DEK. No DB migration, no schema change. Phase 1's `packages/secrets/kek/*` stays as-is; it is intentionally off the Phase 2 read path.

---

## 2. Files to modify/create

### New: resolver module under `packages/secrets/resolver/`
| File | Change |
|---|---|
| `packages/secrets/resolver/paths.ts` | `tenantPath`, `teamPath(tid, segments[], key)`, `userPath`, `parsePath`, `validateSegment`, `validateKey`. Pure functions, no IO. SLUG_RE = `/^[a-z0-9][a-z0-9-]{0,62}$/`. KEY validation reuses `SECRET_NAME_RE` from `../../core/secrets/types.js` (existing `[A-Z0-9_]+`); the source plan's stricter `[A-Z][A-Z0-9_]*` is enforced *additionally* at write time so existing legacy names keep reading. |
| `packages/secrets/resolver/resolver.ts` | `HierarchicalSecretResolver` class. Constructor takes a `SecretsCapability`. `resolveAll(session, teamChain) -> Promise<Record<string,string>>`; `assertPresent(requiredKeys[], env)`. Returns `{}` when session has null `user_id` and empty `teamChain` -- single-tenant CLI path keeps working. |
| `packages/secrets/resolver/index.ts` | Public re-exports of `HierarchicalSecretResolver`, `tenantPath`, `teamPath`, `userPath`, `parsePath`. |
| `packages/secrets/resolver/__tests__/paths.test.ts` | 6 cases: round-trip each shape; reject `..`/`/`/leading-dot; reject keys not matching the regex; deepest legal path < 2048 chars. |
| `packages/secrets/resolver/__tests__/resolver.test.ts` | 6 cases against an in-memory mock provider: user-overrides-team-overrides-tenant; disjoint keys across scopes; empty scopes yield empty map; same key in two team levels -> most-specific wins; assertPresent throws on missing key; resolver returns `{}` when session has null user/empty chain. |
| `packages/secrets/resolver/__tests__/resolver.localstack.test.ts` | LocalStack integration. Seed 4 paths per source plan Task 6; assert `{ A: "user-a", B: "team-b" }`. `describe.skip` on missing docker; reuse `packages/secrets/kek/__tests__/localstack-ssm-helper.ts`. |

### Modified: `SecretsCapability` interface + impls
| File | Change |
|---|---|
| `packages/core/secrets/types.ts` | Add to `SecretsCapability` interface (after L70 `resolveMany`): `listAt(prefix: string): Promise<{ name: string }[]>` and `batchGet(paths: string[]): Promise<Record<string, string>>`. Document: full-path names; missing paths absent from `batchGet` map (no throw -- this is the contract diff vs `resolveMany`). Add `SCOPE_SEGMENT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/` + `assertValidScopeSegment(s)` helpers used by paths.ts + write-path CLI. |
| `packages/core/secrets/aws-provider.ts` | Implement `listAt(prefix)` using `GetParametersByPathCommand{ Path: prefix, Recursive: true, WithDecryption: false }` with `NextToken` pagination; return `[{ name: Parameter.Name }]`. Implement `batchGet(paths)` chunking into 10 (SSM `GetParameters` limit), `WithDecryption: true`, merge into map; `InvalidParameters` from response -> absent (no throw). Sanitise unexpected AWS errors so no path values leak (mirror `SsmKekBackend` style). |
| `packages/core/secrets/file-provider.ts` | Read-side shim: `listAt(prefix)` walks `data.secrets[tid]` entries; a bare legacy `NAME` (no slash) is treated as living at `/ark/<tid>/tenant/NAME`; explicit path-shaped names match literally. `batchGet(paths)` same convention. Lazy-migrate-on-write is intentionally NOT done here -- see "Open question C" + Risk section. |
| `packages/core/secrets/__tests__/aws-provider.test.ts` | Add: 2-page `listAt` pagination merge; 17-path `batchGet` -> 2 chunks (10 + 7); missing paths absent from map; `AccessDenied` surfaces an error without leaking path values. |
| `packages/core/secrets/__tests__/file-provider.test.ts` | Add: legacy flat `ANTHROPIC_API_KEY` discoverable under tenant prefix via `listAt`; explicit user/team paths only returned by their own prefix; `batchGet` missing-path absent. |

### Modified: dispatch wiring
| File | Change |
|---|---|
| `packages/core/services/dispatch/secrets-resolve.ts` | Rewrite `StageSecretResolver.resolve()` (L17-54). New flow: (a) load `teamChain` for the session via injected loader (Open question B); (b) `new HierarchicalSecretResolver(this.deps.secrets).resolveAll(session, teamChain)` -> `env`; (c) if `stageDef?.secrets?.length`, run `assertPresent(stageDef.secrets, env)` -- on failure return `{ env: {}, error }`; (d) DROP the runtime-YAML `secrets:` allowlist read entirely (L32-41). Update header docstring -- precedence is now resolver-first, stage YAML as assert-present. |
| `packages/core/services/dispatch/__tests__/secrets-resolve.test.ts` (create or extend) | Cover: resolver returns env even with empty stage `secrets:`; non-empty stage list with all resolved -> env returned; non-empty stage list with one missing -> error populated, env empty; runtime-YAML allowlist is now ignored (regression guard). |

### Modified: runtime YAML cleanup
| File | Change |
|---|---|
| `runtimes/claude-agent.yaml` | Remove `secrets:` block (L13-16). |
| `runtimes/claude-code.yaml` | Remove `secrets:` block and the now-stale leading comment (L9-16). |
| `runtimes/codex.yaml`, `runtimes/gemini.yaml`, `runtimes/goose.yaml`, `runtimes/claude-max.yaml` | Verified by `grep "secrets:" runtimes/*.yaml` -- already clean. Skip or no-op as needed. |

### Modified: CLI scope flags
| File | Change |
|---|---|
| `packages/cli/commands/secrets.ts` | Add `--scope <tenant\|team\|user>` (default `tenant`) and `--scope-id <id>` (required for non-tenant) to `set` (L201-229), `delete` (L231-259), `get` (L358-386), `list` (L181-199). Bare invocation -> tenant scope (back-compat). Translate to path via `tenantPath`/`teamPath`/`userPath`; write via `setAtPath` (see Open question A). |
| `packages/cli/commands/secrets/describe.ts` | Same scope flags so describe can find user/team-scoped secrets. |
| `packages/cli/__tests__/secrets.test.ts` | Cases per scope flag combination + back-compat default (bare `set FOO=bar` writes tenant). |
| `packages/core/secrets/types.ts` (extra) | Add optional `setAtPath?(tenantId, fullPath, value, opts)` to `SecretsCapability`, implemented in both providers; preserves the leaf-name regex invariant on `set()` while letting the CLI write path-shaped names. |

### New: operator doc
| File | Change |
|---|---|
| `docs/secrets-usage.md` | ~150 lines: path convention; precedence rule; CLI cheatsheet (`set --scope user --scope-id u1 KEY` etc.); worked example mirroring Task 10; "tenant vs team vs user" decision tree. |
| `CLAUDE.md` | One line under "Schema & Migrations" linking to `docs/secrets-usage.md`. |

---

## 3. Implementation steps

Each step maps 1:1 to an atomic commit. Steps are sequenced; later steps depend on earlier interfaces.

### Step 1 -- Path-convention module
- Create `packages/secrets/resolver/paths.ts` + `__tests__/paths.test.ts`.
- TDD: write 6 path tests first (round-trip + rejection cases).
- Implement `tenantPath`, `teamPath(tid, segments[], key)`, `userPath`, `parsePath`, `validateSegment`, `validateKey`. Hard-fail on `..`, `/`, leading dot, empty segment.
- Verify: `bun test packages/secrets/resolver/__tests__/paths.test.ts` green; `make lint` green.
- Commit: `feat(secrets): path-convention helpers for hierarchical resolver`

### Step 2 -- Extend SecretsCapability interface
- Edit `packages/core/secrets/types.ts`: add `listAt`, `batchGet`, optional `setAtPath` to the interface.
- Add stub implementations in `AwsSecretsProvider` and `FileSecretsProvider` that throw `Error("NotImplemented")` -- compile must pass.
- Verify: `bunx tsc --noEmit` green; `make lint` green.
- Commit: `feat(secrets): extend SecretsCapability with listAt + batchGet`

### Step 3 -- AwsSecretsProvider implementation
- TDD: extend `__tests__/aws-provider.test.ts` with the 4 new cases.
- Implement `listAt`: paginated `GetParametersByPathCommand{ Recursive: true, WithDecryption: false }`. Return `[{ name: Parameter.Name }]` only (discovery API, no value).
- Implement `batchGet`: chunk into 10, `GetParametersCommand{ WithDecryption: true }`, merge results. `InvalidParameters` -> silently absent.
- Implement `setAtPath`: as `set()` but with a pre-validated full path; no leaf-name regex assertion.
- Verify: `bun test packages/core/secrets/__tests__/aws-provider.test.ts` green.
- Commit: `feat(secrets): listAt + batchGet on AwsSecretsProvider`

### Step 4 -- FileSecretsProvider implementation
- TDD: extend `__tests__/file-provider.test.ts` for legacy-flat-discoverable + path-shaped + missing-absent.
- Implement `listAt(prefix)`: walk `data.secrets[tid]` entries; effective full-path = `name` if it starts with `/ark/`, else `/ark/<tid>/tenant/<name>`. Filter by prefix.
- Implement `batchGet(paths)`: same convention; absent if missing.
- Implement `setAtPath`: store the literal full path as the entry `name` (no rewrite of the leaf, no legacy migration).
- Verify: `bun test packages/core/secrets/__tests__/file-provider.test.ts` green.
- Commit: `feat(secrets): listAt + batchGet on FileSecretsProvider`

### Step 5 -- HierarchicalSecretResolver
- TDD: `packages/secrets/resolver/__tests__/resolver.test.ts` with an in-memory mock `SecretsCapability`; 6 cases per source plan Task 5.
- Implement `packages/secrets/resolver/resolver.ts`:
  - `resolveAll(session, teamChain)`: parallel `listAt(userPrefix)` (if `session.user_id`), `listAt(teamPrefix_i)` for each chain entry, `listAt(tenantPrefix)`.
  - Build `Map<key, fullPath>` in precedence order: user first, then team chain most-specific -> root, then tenant. Only set when key not already present.
  - One `batchGet(Array.from(map.values()))`; re-key results by `parsePath(fullPath).key`.
  - `assertPresent(requiredKeys, env)` -- pure check helper, throws on missing.
- Create `packages/secrets/resolver/index.ts` re-exports.
- Verify: `bun test packages/secrets/resolver/__tests__/resolver.test.ts` green.
- Commit: `feat(secrets): HierarchicalSecretResolver walks user -> team -> tenant`

### Step 6 -- LocalStack integration test
- Create `__tests__/resolver.localstack.test.ts` reusing `packages/secrets/kek/__tests__/localstack-ssm-helper.ts`.
- Seed `PutParameter` for the 4 paths from source plan Task 6; run `resolveAll` for `tenant_id=t1, user_id=u1, teamChain=["eng"]`; assert `{ A: "user-a", B: "team-b" }`.
- Verify with docker locally; CI without docker reports skipped.
- Commit: `test(secrets): LocalStack end-to-end resolver test`

### Step 7 -- Wire resolver into dispatch
- Rewrite `packages/core/services/dispatch/secrets-resolve.ts`:
  - Drop the `Set<string>` build-from-YAML logic at L26-41.
  - Construct `new HierarchicalSecretResolver(this.deps.secrets)`; call `resolveAll(session, await teamChainLoader(session))`.
  - If `stageDef?.secrets?.length`, run `assertPresent(stageDef.secrets, env)` -- on failure populate `{ env: {}, error }`.
  - Update docstring (L1-10).
- Inject `teamChainLoader` via existing `DispatchDeps` (per Open question B's resolution).
- Extend dispatch test for the new contract.
- Verify: `bun test packages/core/services/dispatch/` green.
- Commit: `refactor(dispatch): HierarchicalSecretResolver; stage YAML is assert-only`

### Step 8 -- Runtime YAML cleanup
- Edit `runtimes/claude-agent.yaml` (drop L13-16) and `runtimes/claude-code.yaml` (drop L9-16 inc. stale comment).
- `make test` sweep -- nothing should rely on the runtime-YAML allowlist for resolution.
- Commit: `chore(runtimes): drop superseded YAML secrets: allowlist`

### Step 9 -- CLI scope flags
- Edit `packages/cli/commands/secrets.ts` to add `--scope` + `--scope-id` to `set`, `delete`, `get`, `list`; same on `secrets/describe.ts`.
- Writes go through `setAtPath(tenantId, fullPath, value, opts)`; back-compat default keeps writing to the legacy flat name on bare invocation (no path translation -- preserves existing `~/.ark/secrets.json` shape).
- Extend `packages/cli/__tests__/secrets.test.ts` for each scope.
- Verify: `bun test packages/cli/` green.
- Commit: `feat(cli): scope flags on secrets set/list/get/delete/describe`

### Step 10 -- End-to-end smoke
- Seed (against local file-provider OR LocalStack SSM):
  - `/ark/default/tenant/DEMO_USER=tenant-demo-user`
  - `/ark/default/users/<my-uid>/DEMO_USER=user-demo-user`
  - `/ark/default/tenant/DEMO_TOKEN=tenant-demo-token`
- Dispatch a `bare-auto` session against `/Users/tusharaggarwal/IdeaProjects/segmentation`.
- Have the agent write both env values to `/tmp/resolver-smoke.txt`. Inspect from host.
- If smoke fails -- fix root cause, do NOT paper over.
- Commit: `test(e2e): hierarchical secrets resolver smoke against segmentation repo`

### Step 11 -- Operator doc
- Write `docs/secrets-usage.md` (~150 lines). Cross-link from `CLAUDE.md` schema section.
- Commit: `docs(secrets): operator usage guide for hierarchical resolver`

Final pre-PR sweep: `make format && make lint && make test`.

---

## 4. Testing strategy

**Unit (mocked, fast):**
- `paths.test.ts` -- 6 cases.
- `resolver.test.ts` -- 6 cases against an in-memory mock provider.
- `aws-provider.test.ts` (extended) -- pagination, chunking, missing-absent, error sanitisation.
- `file-provider.test.ts` (extended) -- legacy-flat + path-shaped + missing.
- `secrets-resolve.test.ts` (extended) -- env-from-resolver + assertPresent success/failure + runtime-YAML regression guard.
- `cli/__tests__/secrets.test.ts` (extended) -- every scope flag combination + back-compat default.

**Integration (Docker-gated, auto-skip):**
- `resolver.localstack.test.ts` -- 4-key seed, asserts user-wins-over-team-wins-over-tenant.

**End-to-end:**
- Smoke against `segmentation` repo (Step 10). Manual; produces `/tmp/resolver-smoke.txt`.

**Regression coverage:**
- `bun test packages/core/services/dispatch/` (re-runs existing dispatch suite; YAML allowlist removal must not break anything).
- `make test` full sweep.

---

## 5. Risk assessment

- **Back-compat for the file provider.** Existing on-disk `~/.ark/secrets.json` stores flat names. Read-side shim in Step 4 maps `NAME -> /ark/<tid>/tenant/NAME` for reads. Write-side: bare `ark secrets set FOO=bar` keeps writing the legacy flat shape; lazy-migrate-on-write is intentionally deferred (Open question C). Flag in PR.
- **`assertValidSecretName` regex.** The existing `[A-Z0-9_]+` regex rejects path-shaped names. Adding `setAtPath()` sidesteps this without weakening leaf validation. Documented as Open question A.
- **Runtime-YAML removal blast radius.** Tenants relying on `runtimes/claude-agent.yaml` `secrets:` to act as an allowlist will silently get resolver behaviour. The resolver's tenant-default scope preserves the practical effect for normal `ANTHROPIC_API_KEY` flows. Call out in PR description + CHANGELOG.
- **Team-chain lookup at dispatch.** `sessions_auth.team_chain` is cached at login. CLI-driven dispatch (no logged-in user) hits the null-user path and the resolver returns tenant-only -- intended behaviour; verify in the dispatch test.
- **SSM `GetParametersByPath` page size.** Default page size means many round-trips for large tenants. Acceptable for v1 -- no caching this phase. Defer per-session memoisation as follow-up.
- **No DB migration.** Source plan is explicit: zero schema changes. Enforced.
- **Provider interface surface growth.** Adding `listAt` + `batchGet` + `setAtPath` to `SecretsCapability` is a breaking change for any out-of-tree implementation. Acceptable -- there are none today.

---

## 6. Open questions (need sign-off before implementation)

**A. `setAtPath` vs relaxing `assertValidSecretName`.**
The CLI needs to write to a full path like `/ark/<tid>/users/<uid>/<KEY>`, but `SecretsCapability.set(tenant, name, value)` asserts `name` matches `[A-Z0-9_]+`. Two options:
1. Add `setAtPath(tenantId, fullPath, value, opts)` as a sibling method, validated by resolver helpers. (Recommended -- preserves leaf invariant.)
2. Relax `assertValidSecretName` to accept either shape.

Recommend (1). Need sign-off before Step 2.

**B. Where does the resolver get `teamChain` from?**
`Session` rows carry `tenant_id`/`user_id`; `sessions_auth.team_chain` is the cached JSON array populated at login. Two wiring choices:
1. Inject `teamChainLoader: (session) => Promise<string[]>` into `StageSecretResolver` via `DispatchDeps` (auth coupling lives at the dispatch seam).
2. Resolver accepts `teamChain` as an explicit arg; dispatch caller loads it. (Recommended -- resolver stays pure.)

Recommend (2). Need sign-off before Step 5.

**C. Lazy migration of flat file-provider entries.**
Source plan Task 4 mentions "store/move them under that key on the next write". Punt this to a separate follow-up commit/PR? It changes on-disk format and benefits from its own test matrix. Recommend deferring out of this plan.

**D. Which `user_id` does Step 10 seed against?**
Step 10 seeds `/ark/default/users/<your-user-id>/DEMO_USER`. Confirm the exact uid before the smoke (google-sub-derived id vs JIT-onboarded default-user id depending on whether the dispatch comes from the web UI or the CLI).

---

## Acceptance summary (work back from here)

- All new + extended tests green under `make test`.
- `runtimes/claude-agent.yaml` and `runtimes/claude-code.yaml` no longer carry `secrets:`.
- A dispatched session reads tenant + team + user secrets without any YAML allowlist anywhere.
- Step 10 smoke produces the expected `/tmp/resolver-smoke.txt`.
- No DB migration introduced.
- `make format && make lint` clean.
