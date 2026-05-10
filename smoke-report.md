# Smoke Report -- final post-fixes autonomous-sdlc sanity

**Branch:** smoke/post-fixes-final
**Commit:** 7f9683daff8fedcb4aa020aacebfc25f418df81a (plan commit on top of d61321aa, code-identical to main)
**Run date (UTC):** 2026-05-10T02:55:42Z
**Prior smoke:** smoke/post-auth-merge @ fae690cc -- PASS (step 5 SKIP, MISSING_PREREQS)

## Results

| # | Step | Status | Duration | Evidence / notes |
|---|------|--------|----------|------------------|
| 0 | Initialize report | PASS | <1s | `.workflow/logs/` created; HEAD captured |
| 1 | `bun install` | PASS | 5.4s | exit 0, 759 packages installed; log: `.workflow/logs/01-install.log` |
| 2 | `make format && make lint` | PASS | ~25s | format clean (no diff after `git diff --quiet`), eslint exit 0 with `--max-warnings 0`; logs: `02-format.log`, `02-lint.log` |
| 3 | Targeted regression test files (23 files) | PASS | ~70s | All 23 files exit 0; aggregate counts below; logs: `03-*.log` |
| 4 | Full unit test suite (`make test`) | PASS | 346s | 5131 pass / 16 skip / 0 fail / 13566 expect() / 5147 tests across 508 files; log: `04-test.log` |
| 5 | Control-plane E2E (`test-e2e-control-plane`) | SKIP | n/a | MISSING_PREREQS -- docker daemon (colima) not running; binary present, tmux present; log: `05-e2e.log` |
| 6 | Flow + agent YAML static resolve | PASS | <1s | `OK autonomous-sdlc: planner,implementer,verifier,reviewer | bare-auto: worker`; log: `06-flow-resolve.log` |
| 7a | Dispatch hint ordering invariant | PASS | <1s | Order at call site: `applyScopingRuntimeHint` (167) -> `applyScopingModelHint` (168) -> `applyStageModelAndResolveSlug` (169); log: `07a-dispatch-order.log` |
| 7b | Migration 018 registered as version 18 | PASS | <1s | `import * as m018` at `registry.ts:44`; entry at line 68; `VERSION = 18` at `018_scoping_overrides.ts:13`; log: `07b-migration-018.log` |
| 7c | `bare-auto.yaml` exists with correct name | PASS | <1s | `name: bare-auto` present in `flows/definitions/bare-auto.yaml`; log: `07c-bare-auto.log` |
| 7d | `bootstrap-key` Makefile target intact | PASS | <1s | target at line 158, daemon-running guard at 163, `--name "$(NAME)"` at 173; log: `07d-bootstrap-key.log` |
| 8 | Installed-builtin-flows install regression | PASS | 5s (1s build, 4s test) | `ark flow list` shows all 4 staged builtins (autonomous, autonomous-sdlc, quick, bare); `bare-auto` also appears in output (out-of-scope per plan); log: `08-builtin-flows.log` |

### Step 3 detail (carry-over auth + scoping + new deltas)

| File | Status | Pass count |
|------|--------|------------|
| `packages/core/services/dispatch/__tests__/runtime-override.test.ts` | PASS | 13 |
| `packages/conductor/__tests__/list-handlers.test.ts` | PASS | 37 |
| `packages/conductor/__tests__/auth-routes.test.ts` | PASS | 28 |
| `packages/conductor/handlers/__tests__/apikey.test.ts` | PASS | 23 |
| `packages/conductor/handlers/__tests__/auth-whoami.test.ts` | PASS | 10 |
| `packages/core/auth/__tests__/sessions.test.ts` | PASS | 18 |
| `packages/core/auth/__tests__/login.test.ts` | PASS | 15 |
| `packages/core/auth/__tests__/context.test.ts` | PASS | 15 |
| `packages/core/auth/__tests__/cookies.test.ts` | PASS | 29 |
| `packages/core/auth/__tests__/csrf.test.ts` | PASS | 11 |
| `packages/core/auth/__tests__/origin.test.ts` | PASS | 18 |
| `packages/core/auth/__tests__/google-oidc.test.ts` | PASS | 11 |
| `packages/core/repositories/__tests__/sessions-auth.test.ts` | PASS | 20 |
| `packages/core/repositories/__tests__/scoping-overrides.test.ts` | PASS | 12 |
| `packages/core/scoping/__tests__/resolver.test.ts` | PASS | 15 |
| `packages/core/scoping/__tests__/team-chain.test.ts` | PASS | 12 |
| `packages/core/migrations/__tests__/runner.test.ts` | PASS | 11 |
| `packages/core/migrations/__tests__/runner-hardening.test.ts` | PASS | 7 |
| `packages/core/__tests__/tenant-scoping.test.ts` | PASS | 31 |
| `packages/conductor/handlers/__tests__/tenant-scoping.test.ts` | PASS | 13 |
| `packages/core/__tests__/dag-flow-load.test.ts` | PASS | 9 |
| `packages/core/__tests__/dag-flow.test.ts` | PASS | 11 |
| `packages/core/__tests__/flow.test.ts` | PASS | 53 |
| **Total** | **23/23** | **422 passing** |

## Summary

- Total steps: 9 (steps 0-8 from PLAN.md)
- PASS: 8  (0, 1, 2, 3, 4, 6, 7, 8)
- FAIL: 0
- SKIP: 1  (step 5 -- MISSING_PREREQS, docker daemon / colima not running)

**Verdict:** PASS

Step 5 SKIP is the same outcome as the prior smoke (`smoke/post-auth-merge @ fae690cc`) and per PLAN.md acceptance criteria does NOT downgrade the verdict; it is called out here so the reviewer can decide separately. The control-plane dispatch chain is still covered indirectly:

- Migration 018 + 017 application against ephemeral sqlite DBs is exercised in step 4 (full suite includes migration runner tests via `AppContext.forTestAsync()`).
- Stage-chain advance / action-stage short-circuit logic is exercised in step 4 via the unit suite.
- The fresh-Postgres path for migration 018 + the `e2e-docs`/`e2e-noop` flows under stub-runner is the gap; only step 5 covers that. To close on a host with colima available, re-run step 5 alone: `make test-e2e-control-plane`.

## Findings

- **`bare-auto` not in `test-installed-builtin-flows.sh` grep list (carry-over from PLAN.md open question 2).** The script greps for `autonomous, autonomous-sdlc, quick, bare` (whole-word). `bare-auto` is observed in the binary's `ark flow list` output during step 8 but is not asserted. Plan flagged this as an out-of-scope follow-up; recording for the reviewer to file as a small follow-up PR touching only `scripts/tests/install/test-installed-builtin-flows.sh` lines 89/128/144 and the staged-yaml copy loop at line 88.
- **Pre-existing `bun build` warning during step 8 build-cli.** `Import "searchAllConversations" will always be undefined because there is no matching export in "packages/core/index.ts"` at `packages/cli/commands/search.ts:69:28`. Unrelated to PRs #534/#549/#546/#550 (the warning predates this branch). Recording for visibility; not a gating issue.
- **`bare-auto` end-to-end coverage gap.** Step 5 (which would have exercised `e2e-docs`/`e2e-noop` flows under stub-runner) was skipped due to missing docker daemon. There is currently no e2e coverage of the new `bare-auto` flow's fire-and-forget dispatch under the stub-runner. PLAN.md open question 3 already flagged this as a follow-up to extend `e2e/control-plane.test.ts`; recording for the reviewer.
- **Migration 018 fresh-Postgres path uncovered by this run.** Same root cause: step 5 SKIP. Step 4 covers the sqlite path through the migration runner unit tests. The Postgres-shaped 018 migration body has unit-level coverage in `scoping-overrides.test.ts` and `migrations/runner.test.ts` but a fresh-DB Postgres bootstrap was not exercised on this host. Recommend step 5 be re-run on a host with colima up before this verdict is treated as fully load-bearing for the migration delta.
