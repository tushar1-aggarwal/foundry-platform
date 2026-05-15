# PLAN: Route `placeAllSecrets` through HierarchicalSecretResolver

Source plan: `docs/superpowers/plans/2026-05-15-resolver-placement-integration-fix.md`.

## 1. Summary

Phase 2 wired `HierarchicalSecretResolver` into `StageSecretResolver`, but `placeAllSecrets` still iterates the flat tenant secrets table at `packages/core/secrets/placement.ts:46-87`. The dispatch path then merges its output OVER the resolver's via `Object.assign` at `packages/core/services/dispatch/launch.ts:120`, so user-scope overrides are silently lost AND path-shaped storage keys (`/ark/<tid>/users/<uid>/<KEY>`) leak into env-var-name validation, hard-failing dispatch. This plan makes `placeAllSecrets` consume the resolver's effective env-var set for env-var-typed secrets while leaving typed-blob placement (ssh-private-key, kubeconfig, generic-blob) on its current flat-table path; those names are already env-var-shape-validated on write.

## 2. Files to modify/create

| Path | Change |
|---|---|
| `packages/core/secrets/placement.ts` | Add `envVars?: Record<string, string>` to `PlaceAllSecretsOpts`. When set, source env-var-typed placement from that map; skip env-var entries during flat-table iteration. Blob/file iteration unchanged. Module-header doc records the asymmetry. |
| `packages/core/services/dispatch/launch.ts` | In `buildLaunchEnv`, construct a `HierarchicalSecretResolver` over `deps.secrets`, load `teamChain` via `deps.teamChainLoader`, call `resolveAll` once. Pass the result as `envVars` to `placeAllSecrets`. Drop `secretEnv.env` from the launch-env merge so placement is the sole env-var source. `StageSecretResolver.resolve` still runs for `assertPresent`; only `.error` is consumed. |
| `packages/core/services/dispatch/types.ts` | Add `secrets: SecretsCapability` to `Pick` used by `buildLaunchEnv` (already present at the top-level `DispatchDeps` interface, just thread it into the `Pick`). No new field. |
| `packages/core/services/dispatch/secrets-resolve.ts` | Header comment updated: `.env` is retained because `assertPresent` runs against it; downstream (`buildLaunchEnv`) no longer merges it. |
| `packages/core/services/dispatch/__tests__/launch.test.ts` | **Create.** Regression test from source-plan Task 1: same key seeded at tenant + user scope; user-scope wins; no env name contains `/`. |
| `packages/core/services/dispatch/__tests__/launch.hierarchical-smoke.test.ts` | **Create.** In-process integration smoke that exercises `buildLaunchEnv` end-to-end against an in-memory `SecretsCapability`, asserting on materialized env. |
| `packages/core/secrets/__tests__/placement.test.ts` | Add coverage for the `envVars` opt path (env vars come from the map; flat-table env-var entries are NOT double-emitted). Existing tests stay green. |
| `packages/core/services/__tests__/launch-placement.test.ts` | Retarget assertions onto the final merged env (placement is now authoritative for env vars). |

No schema changes. No container changes.

## 3. Implementation steps

### Step 1 -- Failing regression test (source-plan Task 1)

Create `packages/core/services/dispatch/__tests__/launch.test.ts`. Test exercises `buildLaunchEnv` directly with a stub `SecretsCapability` that implements `listAt`, `batchGet`, `listBlobsDetailed` (returns `[]`), and the few methods placement still touches (`list`, `resolveMany` -- can stub as `[]`/`{}`). Seed:

- `/ark/t/tenant/DEMO_USER=tenant-val`
- `/ark/t/users/u1/DEMO_USER=user-val`
- `/ark/t/tenant/DEMO_TOKEN=tt`

Build the dispatch `secrets` (`StageSecretResolver`) with `teamChainLoader: async () => []` and a session `{ tenant_id: "t", user_id: "u1" }`. Wire minimal `deps` for `buildLaunchEnv`: `computes.get` returns a stub compute; `materializeClaudeAuth` returns `{env:{}}`; `runtimes.get` returns `null`; `getApp` returns an object exposing `.secrets` (same stub) and `.config.authSection.defaultTenant = "default"`.

Assert:
- `result.error === undefined`
- `result.env.DEMO_USER === "user-val"` (user-scope precedence)
- `result.env.DEMO_TOKEN === "tt"`
- `Object.keys(result.env).every(k => !k.includes("/"))` (no path-shaped names)

Run: must FAIL today against the current code. Commit: `test(dispatch): failing regression -- placeAllSecrets overrides resolver user-scope`.

### Step 2 -- Extend `placeAllSecrets` with the `envVars` opt

In `packages/core/secrets/placement.ts`:

1. Extend `PlaceAllSecretsOpts`:
   ```
   /**
    * Pre-resolved env-var set from HierarchicalSecretResolver. When set,
    * env-var-typed placement is sourced from this map; flat-table
    * iteration handles only typed blobs/files. Keys are bare env-var
    * names (validated [A-Z0-9_]+) -- never path-shaped storage keys.
    */
   envVars?: Record<string, string>;
   ```
2. After computing `stringRefs`/`blobRefs`, branch the env-var path:
   - If `opts.envVars` is provided: iterate its entries, apply `opts.narrow` defensively (drop keys not in `narrow` when `narrow` is non-empty), construct `TypedSecret{ name, type:"env-var", value }`, and run `envVarPlacer.place`. Skip `type === "env-var"` entries inside the existing `stringSelected` loop.
   - Else: existing behaviour.
3. Update the module header to document the asymmetry: env-var secrets come from the hierarchical resolver via `opts.envVars`; typed blobs/files remain flat-tenant-keyed because their names are env-var-shape-validated on write.

Tests stay green (existing callers don't pass `envVars`). Atomic commit: `feat(secrets): placeAllSecrets accepts pre-resolved envVars from hierarchical resolver`.

### Step 3 -- Rewire `buildLaunchEnv` to drive the resolver

In `packages/core/services/dispatch/launch.ts`:

1. Add imports: `HierarchicalSecretResolver` from `../../../secrets/resolver/index.js`; widen the `deps` `Pick` to include `secrets` and `teamChainLoader`.
2. After the existing `secrets.resolve(session, stageDef, runtime, log)` call (which keeps doing `assertPresent` and surfaces `.error`):
   - If `secretEnv.error`, return `{ env: {}, error: secretEnv.error }` (unchanged).
   - Else: load `teamChain` via `deps.teamChainLoader` with the same try/catch + `logWarn` pattern as `StageSecretResolver.resolve`; build `const resolver = new HierarchicalSecretResolver(deps.secrets)`; compute `const envVars = await resolver.resolveAll({ tenant_id: tenantId, user_id: session.user_id ?? null }, teamChain)`.
3. Replace line 82's seed-merge:
   ```
   const env: Record<string, string> = {};
   ```
4. Inside the `if (computeForAuth)` block, pass `envVars` to placement:
   ```
   await placeAllSecrets(app, session, ctx, { narrow, envVars });
   Object.assign(env, ctx.getEnv());
   ```
5. Merge `claudeAuth.env` LAST so the documented precedence holds (tenant claude auth wins over resolver):
   ```
   Object.assign(env, claudeAuth.env);
   ```
6. The "no resolved compute" branch (`!computeForAuth`): seed `env` from `envVars` directly (placement is the env-var source even when placement-ctx flushing is unavailable), then `Object.assign(env, claudeAuth.env)`. This preserves env materialisation for compute-less legacy paths.
7. `narrow` keeps its current shape (union of `stageDef.secrets` + `runtime.secrets`). The opt-only `envVars` path inside `placeAllSecrets` enforces it.
8. Keep all log lines around claudeAuth materialisation as-is.

Atomic commit: `fix(secrets): placeAllSecrets reads env-var secrets from HierarchicalSecretResolver, not flat tenant table`.

### Step 4 -- Test updates + doc cleanup

1. `packages/core/services/dispatch/secrets-resolve.ts` -- update the file-header doc to record that `.env` is now consumed only for `assertPresent`; the dispatch path resolves the launch env independently in `buildLaunchEnv`.
2. `packages/core/services/__tests__/launch-placement.test.ts` -- retarget assertions onto the final `result.env` (placement is now the env-var authority). If any assertion expected a key sourced from `StageSecretResolver.resolve` alone, switch it to seed via `secrets.listAt` instead.
3. `packages/core/secrets/__tests__/placement.test.ts` -- add a new test: call `placeAllSecrets(app, session, ctx, { envVars: { FOO: "bar" } })`; assert `ctx.getEnv().FOO === "bar"` and that env-var entries in the flat list are NOT re-emitted (seed both `flat[FOO]=stale` and `envVars[FOO]=bar`; observe `bar`).
4. The Step 1 regression test now passes.

Atomic commit: `refactor(dispatch): single env-var source -- placeAllSecrets via resolver`.

### Step 5 -- In-process E2E smoke (source-plan Task 4)

Create `packages/core/services/dispatch/__tests__/launch.hierarchical-smoke.test.ts`. Compose against an in-memory `FileSecretsProvider` (or the same stub `SecretsCapability` from Step 1, widened to support blob ops) plus a synthetic Compute. Seed:

- Tenant + user same key (different values) -- assert user wins.
- Tenant-only key -- assert present.
- One typed-blob secret (e.g. `ssh-private-key`) -- assert placement queue contains the corresponding file op.

Drive via `buildLaunchEnv` (not the full `DispatchService`). Assert no env-var name contains `/`. Per-test timeout 180 000 ms per CLAUDE.md.

Atomic commit: `test(dispatch): in-process end-to-end smoke for hierarchical resolver -> placement`.

### Step 6 -- Manual smoke note (source-plan Task 5)

Append to the Step 5 commit body:

```
# Manual smoke (operator-run)
ark secrets set DEMO_KEY=tenant-val --scope tenant
ark secrets set DEMO_KEY=user-val --scope user
ark session start <agent> <repo>
# expected: printenv inside the agent reports DEMO_KEY=user-val
```

## 4. Testing strategy

| Test | Asserts | Type |
|---|---|---|
| `launch.test.ts` (new) | user-scope override wins; no `/` in env-var names | regression unit |
| `placement.test.ts` (extended) | `envVars` opt path emits env vars; legacy flat-table env-var path still works when `envVars` absent | unit |
| `launch-placement.test.ts` (updated) | wiring still respects precedence; placement ctx is forwarded | unit |
| `launch.hierarchical-smoke.test.ts` (new) | end-to-end resolver -> placement -> env materialisation; typed-blob placement still triggers | integration |
| `secrets-resolve.test.ts` (existing) | unchanged -- `StageSecretResolver` semantics intact (`assertPresent`, error shape) | regression |

Run `make test` for the full suite. `make format && make lint` must be clean per CLAUDE.md.

## 5. Risk assessment

**Breakage risk**

- **Tenant claude auth precedence**: `launch.ts:46-47` doc-comment says tenant claude auth wins over secrets. Step 3 preserves this by merging `claudeAuth.env` LAST. Add an inline test in `launch.test.ts` that seeds `ANTHROPIC_API_KEY` both as a tenant secret AND through claude auth materialisation; assert claude auth value wins.
- **Existing `placeAllSecrets` call sites** (`acceptance.ec2.test.ts`, `placement.test.ts`, `temporal/activities/dispatch-deps.ts`): all continue to work because `envVars` is optional. When omitted, behaviour is unchanged.
- **`StageSecretResolver.resolve` callers in tests asserting on `.env`**: unchanged -- the resolver still returns `.env`; we just don't merge it inside `buildLaunchEnv`. `secrets-resolve.test.ts` remains valid.

**Edge cases**

- `session.tenant_id` null -> fallback to `config.authSection.defaultTenant` (mirrors `StageSecretResolver`).
- `user_id` null + empty teamChain -> resolver walks tenant prefix only. No regression.
- `teamChainLoader` throws -> caught + `logWarn`, fall back to `[]`. Same as `StageSecretResolver`.
- `narrow` with `envVars` -> bare-key filtering inside `placeAllSecrets`.
- `computeForAuth` absent -> placement loop skipped; resolved `envVars` still seed `env` (Step 3.6).
- Same key in `envVars` AND `claudeAuth.env` -> claudeAuth wins (merged last).

**Non-goals (per source plan §"Intentional non-goals")**

- Migrating typed-blob secrets (ssh-private-key, generic-blob, kubeconfig) to scope-aware storage -- separate plan.
- Adding team-scope plumbing to dispatch beyond what the resolver already does.
- Touching `packages/secrets/kek/*` or the resolver core.

**Performance**

The resolver is invoked TWICE per dispatch (once inside `StageSecretResolver.resolve` for `assertPresent`, once inside `buildLaunchEnv` for placement). Each call is `listAt` + `batchGet` over the same prefixes; backends cache cheaply and dispatch is not hot-path. Optimisation (e.g., surfacing the resolved env from `StageSecretResolver.resolve` to skip the second call) is tracked as a follow-up.

## 6. Open questions

1. **Should `HierarchicalSecretResolver` be a container singleton?** The source plan claims it is, but it isn't -- `StageSecretResolver` constructs its own; this fix constructs a second. **Recommendation:** keep `new HierarchicalSecretResolver(secrets)` inline; track a follow-up to move it into `container.ts` if/when a third construction site appears.

2. **Read `SecretsCapability` via `deps.secrets` or `deps.getApp().secrets` in `buildLaunchEnv`?** `DispatchDeps.secrets` already exists (line 198 of `types.ts`); the `Pick` for `buildLaunchEnv` doesn't include it yet. **Recommendation:** widen the `Pick` to include `secrets` and `teamChainLoader` (explicit deps; no `getApp()` indirection).

3. **Can `StageSecretResolver` be deleted entirely?** Its only post-fix role is `assertPresent` against stage YAML -- foldable into `buildLaunchEnv` (one extra `resolver.assertPresent` call). **Recommendation:** out of scope for this fix. Track as follow-up cleanup; keeping it preserves the existing test surface.
