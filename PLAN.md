# PLAN — Execute SSM-backed KEK Backend

**Source of truth:** `docs/superpowers/plans/2026-05-14-ssm-kek-backend.md` (10 tasks, fully specified with code blocks). This document is a strategy + delta layer over that plan: it locks the exact wiring points in the current codebase, calls out the few decisions the plan leaves to the implementer, and orders the work for atomic commits.

---

## 1. Summary

Introduce a new `packages/secrets/` package whose v1 surface is the KEK seam only: a `KekBackend` interface, a `SsmKekBackend` implementation that reads a base64-encoded 32-byte SecureString from AWS SSM Parameter Store, a `SecureBuffer` with zero-on-dispose, and a `loadMasterKey(config)` factory. Wire `loadMasterKey()` into `AppContext.boot()` (after schema init, before compute-template seed) and add a `stubKek` test hook so `forTestAsync()` keeps working without LocalStack. Per-tenant DEK, cipher, resolver, HTTP routes, and CLI are explicitly out of scope and tracked as follow-ups.

---

## 2. Files to modify/create

### New package: `packages/secrets/`
| File | Change |
|---|---|
| `packages/secrets/index.ts` | Public surface — re-exports `KekBackend`, `LoadedKek`, `KekLoadError`, `SecureBuffer`, `KekConfig`, `loadMasterKey`, `selectKekBackend`, `parseKekConfigFromEnv`. |
| `packages/secrets/kek/memory.ts` | `SecureBuffer` — 32-byte buffer, `dispose()` zero-fills, idempotent. |
| `packages/secrets/kek/backend.ts` | `KekBackend` interface, `LoadedKek` result type, `KekLoadError` class. No test (pure types). |
| `packages/secrets/kek/ssm.ts` | `SsmKekBackend` — single `GetParameter WithDecryption=true`, base64 decode, length=32 check; lazy `@aws-sdk/client-ssm` import; `client` injection hook for tests. |
| `packages/secrets/kek/load.ts` | `KekConfig` type, `selectKekBackend()`, `loadMasterKey()`, `parseKekConfigFromEnv()`. v1 supports only `backend: "ssm"`. |
| `packages/secrets/kek/__tests__/memory.test.ts` | 6 cases — length, copy semantics, dispose zeroes, double-dispose no-op, post-dispose read returns zeros. |
| `packages/secrets/kek/__tests__/ssm.test.ts` | 9 cases against a mock SSM client — happy path, version default, missing/empty/non-base64/wrong-length errors, SDK error wrapping, "error msg never leaks bytes" regression. |
| `packages/secrets/kek/__tests__/load.test.ts` | factory selection + env parsing + `ARK_MASTER_KEY` deprecation warning. |
| `packages/secrets/kek/__tests__/localstack-ssm-helper.ts` | Docker-gated LocalStack helper, cloned from `packages/core/storage/__tests__/localstack-helper.ts` and adapted for `SERVICES=ssm,kms`. |
| `packages/secrets/kek/__tests__/ssm.localstack.test.ts` | LocalStack round-trip — `PutParameter` + `SsmKekBackend.load()` byte-equality; missing-param error path. Auto-skips when docker absent. |

### Modified: existing core wiring
| File | Change |
|---|---|
| `packages/core/config.ts` | Add `kek?: KekConfig` to `ArkConfig` (after the `secrets?` block at L186–190). Extend `assemble()` to populate it via `parseKekConfigFromEnv(process.env)` (gated on `ARK_KEK_BACKEND` presence so test runs without env vars stay quiet). Import via `"../secrets/index.js"`. |
| `packages/core/container.ts` | Add `stubKek?: LoadedKek` to `AppBootOptions` (L75–80) and `loadedKek: LoadedKek` to the `Cradle` interface (L82+). |
| `packages/core/app.ts` | (a) Add `_loadedKek` private field + public `loadedKek` getter near the `_drizzle` field (L97). (b) In `boot()` (around L131, after `_seedComputeTemplates`), insert KEK load with `stubKek` short-circuit. (c) After the `buildContainer(...)` call (L137), register `loadedKek` via `asValue`. (d) In `shutdown()` (L235, inside `if (wasBooted)`), call `_loadedKek?.material.dispose()` and null it out before `_container.dispose()`. (e) In `forTestAsync()` (L1042) and `forTest()` (L1035), default a deterministic `stubKek` (32-byte `0xa5` fill) when caller didn't supply one. |

### New: smoke test
| File | Change |
|---|---|
| `packages/arkd/__tests__/kek-boot.test.ts` | Three cases — boot installs default stub KEK; shutdown zero-fills the buffer; boot throws if `config.kek` is missing AND `stubKek` is unset. |

**Note:** `packages/secrets/` is a sibling of `packages/core/`. Ark uses ES-module relative imports with `.js` extensions (per `CLAUDE.md`), so `packages/core/config.ts` reaches it as `"../secrets/index.js"`. Verify `bunx tsc --noEmit` at Step 1 — no workspace add needed if the root tsconfig globs `packages/*`.

---

## 3. Implementation steps

Each task below maps 1:1 to a commit; the source plan has the exact code to paste in. Steps run sequentially.

### Step 1 — Scaffold `packages/secrets/`
- `mkdir -p packages/secrets/kek/__tests__`
- Create `packages/secrets/index.ts` with placeholder `export {};` and the doc block from the source plan.
- Verify: `bunx tsc --noEmit` passes.
- Commit: `feat(secrets): scaffold packages/secrets folder for KEK module`

### Step 2 — `SecureBuffer` (TDD)
- Write `__tests__/memory.test.ts` (6 cases per source plan).
- Confirm failing (module not found).
- Implement `kek/memory.ts`: 32-byte enforcement, copy-on-construct, idempotent `dispose()`.
- Verify: `bun test packages/secrets/kek/__tests__/memory.test.ts` PASS.
- Commit: `feat(secrets): SecureBuffer with zero-on-dispose for 32-byte key material`

### Step 3 — `KekBackend` interface + `KekLoadError`
- Implement `kek/backend.ts` (types only).
- Verify: `bunx tsc --noEmit` passes.
- Commit: `feat(secrets): KekBackend interface, LoadedKek result, KekLoadError`

### Step 4 — `SsmKekBackend` (TDD with mocked client)
- Write `__tests__/ssm.test.ts` with `MockSsmClient` (9 cases).
- Implement `kek/ssm.ts`. Critical guardrails:
  - lazy `await import("@aws-sdk/client-ssm")` so the SDK only loads when SSM is used
  - re-encode-equality base64 check (Buffer.from is permissive)
  - `decoded.fill(0)` after copying into `SecureBuffer`
  - error messages contain backend id + AWS error name, never any decoded byte
- Verify: `bun test packages/secrets/kek/__tests__/ssm.test.ts` PASS.
- Commit: `feat(secrets): SsmKekBackend reads base64 32-byte KEK from SSM SecureString`

### Step 5 — Loader factory + env parsing
- Write `__tests__/load.test.ts` (selection + env parsing + `ARK_MASTER_KEY` warning).
- Implement `kek/load.ts` exporting `KekConfig`, `selectKekBackend`, `loadMasterKey`, `parseKekConfigFromEnv`. `SUPPORTED = ["ssm"]` const gates v1.
- Replace `packages/secrets/index.ts` with the full public surface (per source plan §Task 5 Step 5).
- Verify: `bun test packages/secrets/` all green.
- Commit: `feat(secrets): loadMasterKey + parseKekConfigFromEnv with SSM-only v1 surface`

### Step 6 — LocalStack helper
- Create `__tests__/localstack-ssm-helper.ts` (clone of `packages/core/storage/__tests__/localstack-helper.ts`, swap `SERVICES=ssm,kms`).
- Commit: `test(secrets): LocalStack helper for SSM-backed integration tests`

### Step 7 — LocalStack integration test
- Create `__tests__/ssm.localstack.test.ts` (PutParameter + `SsmKekBackend.load()` byte-equality round-trip; 2 cases; auto-skip without docker).
- Verify locally with docker if available; CI without docker reports skipped.
- Commit: `test(secrets): SsmKekBackend LocalStack round-trip integration`

### Step 8 — Wire into `AppContext.boot()`

**8a. Extend `ArkConfig` in `packages/core/config.ts`:**
- Add `import type { KekConfig } from "../secrets/index.js";`
- Add `kek?: KekConfig;` field next to the existing `secrets?` block (L186–190).
- In `assemble()` (L317+), call `parseKekConfigFromEnv(process.env)` only when `process.env.ARK_KEK_BACKEND` is set; attach to `ArkConfig.kek`. Tests that don't set the env var continue through the `stubKek` path.

**8b. Extend types in `packages/core/container.ts` (L75):**
```ts
// AppBootOptions
stubKek?: import("../secrets/index.js").LoadedKek;

// Cradle
loadedKek: import("../secrets/index.js").LoadedKek;
```

**8c. Edit `packages/core/app.ts`:**
- Near `_drizzle` (L97): add `_loadedKek` private field + public `loadedKek` getter that throws if accessed pre-boot.
- In `boot()` after `await this._seedComputeTemplates(db);` (L131) and before `this._container = buildContainer(...)`:
  ```ts
  if (this.options.stubKek) {
    this._loadedKek = this.options.stubKek;
  } else {
    if (!this.config.kek) {
      throw new Error("AppContext.boot: config.kek missing -- ARK_KEK_BACKEND not configured");
    }
    const { loadMasterKey } = await import("../secrets/index.js");
    this._loadedKek = await loadMasterKey(this.config.kek);
  }
  ```
- After `this._container = buildContainer(...)` (L137):
  ```ts
  this._container.register({ loadedKek: asValue(this._loadedKek) });
  ```
- In `shutdown()` (inside `if (wasBooted)` at L235, before `await this._container.dispose()`):
  ```ts
  this._loadedKek?.material.dispose();
  this._loadedKek = null;
  ```

**8d. Default `stubKek` in `forTestAsync` (L1042) and `forTest` (L1035):**
- Build a deterministic 32-byte `SecureBuffer` (fill `0xa5`), wrap in `{ material, version: 1, describe: () => "stub:forTestAsync@v1" }`.
- Merge into a per-call options object (clone `TEST_OPTIONS`; don't mutate the module-level constant).

**Verify:** `bun test packages/core/` PASS. Any test that constructs `new AppContext(...)` directly must route through `forTestAsync` or pass `stubKek` explicitly.

- Commit: `feat(core): load master KEK during AppContext.boot via KekBackend`

### Step 9 — arkd smoke test
- Create `packages/arkd/__tests__/kek-boot.test.ts` (3 cases — default stub, shutdown disposal, missing-config fail).
- Verify: `bun test packages/arkd/__tests__/kek-boot.test.ts` PASS.
- Commit: `test(arkd): smoke test that boot eager-loads KEK and dispose zeroes it`

### Step 10 — Full suite + lint/format
- `make test` — full suite green.
- `make format && make lint` — zero warnings (CI policy from `CLAUDE.md`).
- If format/lint changed anything, commit: `chore(secrets): apply prettier + eslint to KEK module`.

---

## 4. Testing strategy

| Layer | What it proves | File |
|---|---|---|
| Unit — SecureBuffer | Length enforcement, copy-on-construct, dispose zero-fills, idempotency | `memory.test.ts` |
| Unit — SsmKekBackend mocked | Correct SDK call shape (`WithDecryption: true`), version parsing, all failure modes wrap into `KekLoadError`, error messages never contain key bytes | `ssm.test.ts` |
| Unit — Loader/config | Factory selects SSM, rejects other backends, env parser surfaces clear errors, `ARK_MASTER_KEY` deprecation only warns | `load.test.ts` |
| Integration — LocalStack | Byte-for-byte round-trip via real AWS SDK against LocalStack SSM; auto-skips without docker | `ssm.localstack.test.ts` |
| Integration — arkd boot | `AppContext.boot()` eager-loads KEK; shutdown disposes; missing config fails fast | `kek-boot.test.ts` |
| Regression — full suite | No existing test breaks because every test-mode `AppContext` gets the stub KEK by default | `make test` |

**Negative-path coverage to verify explicitly:**
- AWS `AccessDeniedException` surfaces as `KekLoadError` containing the error code but not the parameter value.
- Length-mismatch error message does not contain the decoded bytes (regression-tested with recognizable `0xab` pattern).
- `Parameter: undefined` / `Value: ""` / non-base64 / wrong-length all produce distinct, actionable errors.

**Test-mode hygiene:** `make test` must not require AWS credentials. The `stubKek` default in `forTestAsync` is what guarantees this — verify by running `make test` with `AWS_*` env vars unset.

---

## 5. Risk assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Existing tests construct `new AppContext(...)` directly and skip `forTestAsync` | Medium | Step 8 explicitly checks `bun test packages/core/`; failing tests get the `stubKek` option passed inline. Source plan §Task 8 Step 10 calls this out. |
| `packages/secrets` not picked up by root tsconfig | Low | `CLAUDE.md` lists existing siblings (`packages/{cli,core,...}`); a new sibling follows the same pattern. Verify with `bunx tsc --noEmit` at Step 1. |
| E2E tests under `packages/e2e/` boot real `AppContext` and break without `ARK_KEK_BACKEND` | Medium | Source plan §Task 8 Step 10 notes this — gate e2e tests on docker + LocalStack as needed, or route through `forTestAsync`. Tackle as a follow-up only if regression surfaces. |
| `ARK_MASTER_KEY` legacy env var still set in some dev configs | Low | Loader emits warning (not error). Covered in `load.test.ts`. |
| Key material leaks via V8 string interning | Acknowledged — not solvable | `SecureBuffer.dispose()` is documented as "harm reduction, not proof" per the source plan's docstring. |
| LocalStack flakes on slow CI | Low | Helper has 30s health-poll timeout; docker availability gate means CI without docker skips cleanly. Each test has 60s `timeout` (well under the CLAUDE.md 180s cap). |
| **Breaking change**: `local` + `control-plane` profiles refuse to boot without `ARK_KEK_BACKEND` | High | Intentional per spec ("fail fast"). Document in PR description + `CLAUDE.md` follow-up. Only `test` profile (via stub) unaffected. |

---

## 6. Open questions

1. **Local-dev fail-fast posture.** The plan makes `make dev` (local profile) refuse to boot without SSM. Is that acceptable for v1, or should the `local` profile auto-default to a stub/EnvKekBackend so `make dev` keeps working? The source plan defers `EnvKekBackend` to a follow-up. **Recommendation:** ship as specced; add `EnvKekBackend` in the very next plan; mention the new required env vars in the PR description.

2. **`stubKek` exposure on `AppBootOptions`.** The plan places `stubKek` on the public `AppBootOptions` surface alongside `skipConductor` / `skipSignals`. Should it be renamed (e.g., `_stubKek`) to signal "test-only"? **Recommendation:** keep parity with the existing `skip*` toggles; rename only if reviewers push back.

3. **Branch target for the PR.** This worktree is on `ark-s-q3vzuxq3kv` on top of `feature/ssm-kek-backend` per the harness env. Confirm the PR target before opening one — the source plan's §Task 10 Step 4 references a different branch (`feature/secrets-management-revisions`).

4. **Contract test omission.** Source plan intentionally skips `backend.contract.test.ts` (only one backend in v1). Hold the line; point reviewers at the spec's "Intentional deviations" section.

5. **`parseKekConfigFromEnv` location.** Source plan keeps it inside the secrets package and calls it from `packages/core/config.ts`. Alternative: inline parsing in `config.ts`. **Recommendation:** keep it in the secrets package — owning your own env contract is cleaner.
