# Phase 2 Follow-up: Route placeAllSecrets through the resolver

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Status:** small, focused follow-up to the Phase 2 resolver plan (`2026-05-15-hierarchical-secrets-resolver.md`). Closes the D2 supersession gap that the Phase 2 implementer missed.

## What's broken (concrete failure surfaced in smoke test)

After Phase 2, `HierarchicalSecretResolver` is wired into `StageSecretResolver` and produces a correct effective env-var set under `secretEnv.env`. But the dispatch path in `packages/core/services/dispatch/launch.ts:99-129` still calls `placeAllSecrets(app, session, ctx, { narrow })` **as a parallel step** and merges its output via `Object.assign(env, ctx.getEnv())` -- which overrides the resolver's output.

`placeAllSecrets` reads from the flat tenant secrets table (via `SecretsCapability.resolveMany` / equivalent). For tenant-scoped keys that's fine, but for user/team-scoped writes the CLI stores rows whose **name is the full SSM path** (`/ark/<tid>/users/<uid>/<KEY>`). `placeAllSecrets` returns those path-shaped names verbatim, env-var name validation (`[A-Z0-9_]+`) at `packages/core/secrets/types.ts:179` then rejects them, and the entire session fails to dispatch:

```
Secret placement failed: Invalid secret name '/ark/default/users/default-dev/DEMO_USER':
  must match [A-Z0-9_]+ (uppercase ASCII, digits, underscore)
```

Even when the name happens to validate (tenant-scoped flat writes), the legacy iterator wins the merge and overwrites the resolver's correct user-scope value -- silently breaking the supersession.

## Goal

Make `placeAllSecrets` consume the resolver's effective set as its env-var source-of-truth. The flat-iteration code path stops being authoritative for env-var-typed secrets. Typed-secret placement for `ssh-private-key`, `generic-blob`, `kubeconfig` continues to work through their existing placers.

## Source specs

- `docs/superpowers/specs/2026-05-13-hierarchical-secrets-design.md` -- parent spec, the D2 supersession ("the input to `placeAllSecrets` is now the per-user effective set produced by this layer's resolver, not the flat tenant secret list") is the load-bearing motivation.
- `docs/superpowers/plans/2026-05-15-hierarchical-secrets-resolver.md` -- Phase 2 plan. This follow-up closes the gap in its Task 7.

## Tasks

### Task 1: Reproduce the failure as a test

- [ ] In `packages/core/services/dispatch/__tests__/launch.test.ts` (or the file that holds the existing `StageSecretResolver` integration tests; create if missing), add a test:
  - Seed the in-memory secrets capability with: `/ark/t/tenant/DEMO_USER=tenant-val`, `/ark/t/users/u1/DEMO_USER=user-val`, `/ark/t/tenant/DEMO_TOKEN=tt`.
  - Build a session with `tenant_id=t, user_id=u1, teamChain=[]`.
  - Call the launch helper (or `resolveStageSecrets + placeAllSecrets` pair) the same way dispatch does.
  - Assert: `env.DEMO_USER === "user-val"` AND `env.DEMO_TOKEN === "tt"` AND **no env key contains a `/` character**.
- [ ] Run: it must FAIL today (asserts on the right thing).

**Verification:** `bun test packages/core/services/dispatch/__tests__/launch.test.ts -t 'user scope wins over tenant' 2>&1 | grep -E "fail|FAIL"` shows the expected failure. Atomic commit: `test(dispatch): failing regression -- placeAllSecrets overrides resolver user-scope`.

### Task 2: Route placeAllSecrets through the resolver

- [ ] Read `packages/core/secrets/placement.ts` to understand the current shape of `placeAllSecrets(app, session, ctx, { narrow })`.
- [ ] Change `placeAllSecrets` so its env-var source is the `HierarchicalSecretResolver.resolveAll(session, teamChain)` output **rather than** an iteration of the flat tenant secrets table.
  - The resolver is already exposed via the DI container from Phase 2 (`packages/core/container.ts`). Resolve it; do not new-up an instance inside placement.
  - `teamChain` comes from `session.team_chain` if cached, else look it up from `sessions_auth` -- whatever the existing dispatch path uses (see `StageSecretResolver.resolve()` for the canonical lookup).
- [ ] Typed-secret placement for non-env types (ssh-private-key, generic-blob, kubeconfig) continues to read from the flat secrets table BY NAME for now. Their names are validated env-var-shape on write, so they don't carry path-shaped storage keys -- they're unaffected by this change. Document this asymmetry in a comment at the top of `placement.ts` so future readers don't get confused.
- [ ] `narrow` filter (the legacy stage/runtime YAML assert-only list) continues to apply on top of the resolver output: if `narrow` is set and a key isn't in it, drop it.

**Verification:** Task 1's regression test passes. Atomic commit: `fix(secrets): placeAllSecrets reads env-var secrets from HierarchicalSecretResolver, not flat tenant table`.

### Task 3: Drop the redundant resolver call in launch.ts

- [ ] After Task 2, `secretEnv.env` (from `StageSecretResolver.resolve`) and `ctx.getEnv()` (from `placeAllSecrets`) both produce the same env-var set via the resolver. Keeping both is wasteful and the `Object.assign` merge becomes confusing.
- [ ] Pick one as authoritative. Recommended: keep `placeAllSecrets` as the single source (its `ctx` carries typed secrets too) and drop the standalone `StageSecretResolver.resolve` call's env-var output from the merge. `StageSecretResolver.resolve` can still run if it serves the `narrow`/`assertPresent` semantics; just don't merge its env into the final result.
- [ ] Update `launch.ts:82-129` accordingly. Preserve `claudeAuth.env` merging.
- [ ] If any unit test asserts on `secretEnv.env` content directly, retarget it to assert on the final merged env.

**Verification:** All existing dispatch tests pass. Task 1's test still passes. Atomic commit: `refactor(dispatch): single env-var source -- placeAllSecrets via resolver`.

### Task 4: End-to-end smoke (the Task 10 we missed in Phase 2)

- [ ] Add a new integration test at `packages/core/services/dispatch/__tests__/launch.hierarchical-smoke.test.ts` that uses the real `LocalCompute` + DeferredPlacementCtx path:
  - Seed via the existing `SecretsCapability` interface (no CLI dependency): one key at tenant scope, same key with a different value at user scope, plus a tenant-only key.
  - Run `launchAgent` (or the closest test-friendly entrypoint) and assert on the materialized env.
  - Confirm no path-shaped names leak through. Confirm user-scope override wins. Confirm tenant-only key is present.
- [ ] This is the integration-level Task 10 of the Phase 2 plan; it was deferred because the implementer agent couldn't dispatch its own session. Doing it in-process here is the right scope.

**Verification:** `bun test packages/core/services/dispatch/__tests__/launch.hierarchical-smoke.test.ts` green. Atomic commit: `test(dispatch): in-process end-to-end smoke for hierarchical resolver -> placement`.

### Task 5: Manual smoke against segmentation

- [ ] After all the above land, leave a one-paragraph note in the commit message of Task 4 (or a new short doc) describing how to seed two tenant + user secrets and dispatch a `bare-auto` session against a real repo, with the expected `printenv` output. This is the human-confirmation step; the implementer agent shouldn't try to dispatch a session itself.

## Acceptance criteria (work back from here)

- All existing tests pass (`make test`).
- New regression test from Task 1 passes (was failing pre-fix).
- New in-process smoke from Task 4 passes.
- `make format && make lint` green.
- Final dispatched env for a session with same-key seeds at tenant + user scope: **user scope value wins**.
- No env-var name in the final dispatched env contains `/`.
- `placeAllSecrets` no longer reads from the flat tenant table for env-var-typed secrets; it consumes the resolver.

## Intentional non-goals

- Do NOT migrate non-env-var typed secrets (ssh-private-key, generic-blob, kubeconfig) to scope-aware storage in this plan. They still store flat-tenant-keyed; that's fine because their names are validated env-var-shape on write and don't carry path-shaped keys.
- Do NOT add team-scope support beyond what the resolver already does. teamChain plumbing through dispatch is unchanged.
- Do NOT touch `packages/secrets/kek/*` (Phase 1) or `packages/secrets/resolver/*` (Phase 2 resolver itself). The bug is in how dispatch wires the resolver, not in the resolver.

## Follow-ups (NOT in this plan)

- A real end-to-end session-against-real-repo smoke (Task 10 of Phase 2). Tracked separately; the operator runs it after this fix lands.
- Migrate ssh-private-key / generic-blob / kubeconfig to scope-aware storage. Separate plan; touches placer signatures.
- Per-tenant defaults for ANTHROPIC_* -- they currently live as flat-tenant; the resolver finds them as tenant-scope just fine, but the CLI write path could be tidied to use `--scope tenant` explicitly.
