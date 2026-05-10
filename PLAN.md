# PLAN: final post-fixes sanity confirm autonomous-sdlc on main

## 1. Summary

This is a **smoke / sanity** task. Three small follow-ups landed on `main`
on top of PR #534 (auth Phase 1) since the previous post-auth-merge smoke
ran -- migration 018 (`scoping_overrides` backfill, #549), the new
`bare-auto` builtin flow (#546), and a `bootstrap-key` Makefile target
(#550). We need a final confirmation that the **autonomous-sdlc** flow
(`flows/definitions/autonomous-sdlc.yaml`: plan -> implement -> verify ->
review -> pr -> merge) still wires up end-to-end on this branch
(`smoke/post-fixes-final`, head `d61321aa`, identical to `main`). This
task does NOT modify product code -- it produces `smoke-report.md`
documenting results of a fixed verification matrix; downstream stages
(verify, review) read that report.

## 2. Files to modify/create

| File | Purpose |
|------|---------|
| `smoke-report.md` (create, repo root) | Markdown report with a results table per verification step plus failure diagnostics. Read by `verifier` and `reviewer` stages. Note: the previous smoke also wrote this file at the repo root with the same name; on this branch it does not yet exist (this branch is at the same SHA as `main` and the prior smoke lived on `smoke/post-auth-merge`). Create fresh. |
| `.workflow/logs/*.log` (create dir + files) | Per-step stdout/stderr captures referenced from the report. |
| `PLAN.md` (this file, already committed via `git add -f`) | Plan handoff to implementer. `PLAN.md` is gitignored at the repo root (`.gitignore:1`); the planner already used `git add -f` to commit it. The implementer must NOT delete or re-`.gitignore`-respect this. |

**Do NOT modify** anything in `packages/`, `flows/`, `agents/`, `runtimes/`,
`drizzle/`, or `Makefile`. If a real bug surfaces, capture it in
`smoke-report.md` under "Findings" and let the verifier/reviewer route
it -- do not patch on this branch. The post-fixes PRs (#549, #546, #550)
are tiny and recently merged; out-of-band fixes here would race any
follow-up the auth + flows teams ship.

## 3. Implementation steps

Run these in order from the repo root. After each, append the result row
to `smoke-report.md` (create the file at the start of step 1 with the
header below). Use the literal commands shown -- no creative substitutions.

### Step 0 -- Initialize the report

Create `smoke-report.md` with this exact header (substituting the live
SHA + UTC timestamp):

```markdown
# Smoke Report -- final post-fixes autonomous-sdlc sanity

**Branch:** smoke/post-fixes-final
**Commit:** <git rev-parse HEAD output>
**Run date (UTC):** <date -u +%Y-%m-%dT%H:%M:%SZ>
**Prior smoke:** smoke/post-auth-merge @ fae690cc -- PASS (step 5 SKIP, MISSING_PREREQS)

## Results

| # | Step | Status | Duration | Evidence / notes |
|---|------|--------|----------|------------------|
```

Fill `Status` with `PASS`, `FAIL`, or `SKIP`. `Evidence / notes` is one
line: log path, exit code, count of passing tests, etc. Keep entries
short; full logs go in `.workflow/logs/<step>.log` (create the dir).

```bash
mkdir -p .workflow/logs
git rev-parse HEAD
date -u +%Y-%m-%dT%H:%M:%SZ
```

### Step 1 -- `bun install`

```bash
bun install 2>&1 | tee .workflow/logs/01-install.log
```

PASS if exit 0. FAIL otherwise -- abort the rest of the plan; if install
breaks, nothing else is meaningful.

### Step 2 -- `make format && make lint`

```bash
make format 2>&1 | tee .workflow/logs/02-format.log
make lint   2>&1 | tee .workflow/logs/02-lint.log
git diff --quiet || echo "FORMAT_DIFF"  # MUST print nothing
```

PASS if both exit 0 with no diff produced by `make format`
(`git diff --quiet` after format must succeed). CLAUDE.md: "MUST pass;
CI rejects otherwise."

### Step 3 -- Targeted regression surface (carry-over from prior smoke + new deltas)

These directly cover the files PRs #534 / #549 / #546 / #550 changed.
Run each via `make test-file` and capture in
`.workflow/logs/03-<basename>.log`.

**Auth Phase 1 surface (carry-over -- already PASS on prior smoke; re-run
to confirm no rebase regressions):**

```bash
make test-file F=packages/core/services/dispatch/__tests__/runtime-override.test.ts
make test-file F=packages/conductor/__tests__/list-handlers.test.ts
make test-file F=packages/conductor/__tests__/auth-routes.test.ts
make test-file F=packages/conductor/handlers/__tests__/apikey.test.ts
make test-file F=packages/conductor/handlers/__tests__/auth-whoami.test.ts
make test-file F=packages/core/auth/__tests__/sessions.test.ts
make test-file F=packages/core/auth/__tests__/login.test.ts
make test-file F=packages/core/auth/__tests__/context.test.ts
make test-file F=packages/core/auth/__tests__/cookies.test.ts
make test-file F=packages/core/auth/__tests__/csrf.test.ts
make test-file F=packages/core/auth/__tests__/origin.test.ts
make test-file F=packages/core/auth/__tests__/google-oidc.test.ts
make test-file F=packages/core/repositories/__tests__/sessions-auth.test.ts
make test-file F=packages/core/repositories/__tests__/scoping-overrides.test.ts
make test-file F=packages/core/scoping/__tests__/resolver.test.ts
make test-file F=packages/core/scoping/__tests__/team-chain.test.ts
```

**Post-fixes delta (NEW -- direct coverage of #549, #546, #550):**

```bash
# #549 migration 018 -- runner ordering + scoping_overrides shape
make test-file F=packages/core/migrations/__tests__/runner.test.ts
make test-file F=packages/core/migrations/__tests__/runner-hardening.test.ts
make test-file F=packages/core/__tests__/tenant-scoping.test.ts
make test-file F=packages/conductor/handlers/__tests__/tenant-scoping.test.ts
# #546 bare-auto flow -- DAG flow loader sees the new builtin
make test-file F=packages/core/__tests__/dag-flow-load.test.ts
make test-file F=packages/core/__tests__/dag-flow.test.ts
make test-file F=packages/core/__tests__/flow.test.ts
```

Capture per-file pass/fail in the report -- do not collapse into a single
row; if any subset fails the granular row tells the verifier which area
regressed. PASS only if every file exits 0.

### Step 4 -- Full unit test suite

```bash
make test 2>&1 | tee .workflow/logs/04-test.log
```

PASS if exit 0. CLAUDE.md target: "run all tests (parallel)". Excludes
compute E2E + integration suites; those are step 5. The prior smoke
flaked once at `hosted-web-auth.test.ts` under `--concurrency 4` and
passed clean on retry; if that recurs, retry once via the same command
into `.workflow/logs/04-test-retry.log` and record both runs in the
evidence column.

### Step 5 -- Control-plane E2E (the canonical dispatch-chain smoke)

```bash
command -v docker >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1 && \
  docker info >/dev/null 2>&1 || echo "MISSING_PREREQS"
```

Pre-flight check first. If `docker info` fails (the prior smoke failed
exactly here -- `colima is not running`), mark step 5 SKIP with
`MISSING_PREREQS` and the colima/docker-daemon detail; do NOT attempt
to start colima or install anything. Then:

```bash
make test-e2e-control-plane 2>&1 | tee .workflow/logs/05-e2e.log
```

This is the most important step when prereqs are present. It exercises:

- migration runner against fresh Postgres -- this run also covers
  **migration 018** (#549) end-to-end on Postgres for the first time.
  Watch for `ark_schema_migrations` showing both `017` and `018`
  applied; either ordering issue or shape drift would surface here.
- hosted DI wiring (forTenant memoization, dispatcher registration).
- the `e2e-docs` flow (plan -> implement -> close) end-to-end through
  `CoreDispatcher -> stub-runner executor -> Bun.spawn -> stub-agent.sh
  -> POST /api/channel/:id -> applyReport -> StageAdvancer.advance`.
- the `e2e-noop` action-only flow (proves `maybeHandleActionStage`
  short-circuit still works post-merge).

PASS if exit 0 and the test log shows both
`action-only flow (e2e-noop) reaches completed` and
`docs flow with stub agent reaches completed through plan -> implement
-> close` both pass. SKIP only with `MISSING_PREREQS` rationale. FAIL
on any other outcome.

### Step 6 -- autonomous-sdlc + bare-auto flow YAMLs load + agent references resolve

The flow's `requires_repo: true` is enforced server-side at
`session/start` (`packages/conductor/handlers/session.ts`); each named
stage agent (`planner`, `implementer`, `verifier`, `reviewer`) and the
new `bare-auto`'s `worker` agent must resolve via the agent store.
Verify statically (one combined static check, two flows):

```bash
bun --print '
  const yaml = require("yaml");
  const fs = require("fs");
  function checkFlow(flowPath, expectedAgents) {
    const flow = yaml.parse(fs.readFileSync(flowPath, "utf-8"));
    const named = flow.stages.filter(s => typeof s.agent === "string").map(s => s.agent);
    if (JSON.stringify(named) !== JSON.stringify(expectedAgents)) {
      throw new Error(`flow ${flowPath}: agents [${named}] != expected [${expectedAgents}]`);
    }
    for (const name of named) {
      const agentPath = `agents/${name}.yaml`;
      if (!fs.existsSync(agentPath)) throw new Error(`missing agent yaml: ${agentPath}`);
      const agent = yaml.parse(fs.readFileSync(agentPath, "utf-8"));
      if (!agent.runtime) throw new Error(`agent ${name}: no runtime`);
      if (!agent.system_prompt) throw new Error(`agent ${name}: no system_prompt`);
    }
    return named;
  }
  const a = checkFlow("flows/definitions/autonomous-sdlc.yaml",
                      ["planner","implementer","verifier","reviewer"]);
  const b = checkFlow("flows/definitions/bare-auto.yaml", ["worker"]);
  console.log("OK autonomous-sdlc:", a.join(","), "| bare-auto:", b.join(","));
' 2>&1 | tee .workflow/logs/06-flow-resolve.log
```

PASS if stdout starts with
`OK autonomous-sdlc: planner,implementer,verifier,reviewer | bare-auto: worker`
and exit 0. FAIL otherwise -- record which flow or agent yaml is missing
or malformed.

### Step 7 -- Post-fixes invariants check

Three static greps confirming the post-fixes patches landed at the right
sites and didn't lose ordering:

```bash
# 7a -- dispatch surface invariants (carry-over from prior smoke).
# Lines must appear in order: applyScopingRuntimeHint -> applyScopingModelHint -> applyStageModelAndResolveSlug
grep -nE "applyScopingRuntimeHint|applyScopingModelHint|applyStageModelAndResolveSlug" \
  packages/core/services/dispatch/dispatch-core.ts \
  | tee .workflow/logs/07a-dispatch-order.log

# 7b -- migration 018 registered with version 18 in monotonic order
grep -nE 'import \* as m018|VERSION = 18|m018\.VERSION' \
  packages/core/migrations/registry.ts \
  packages/core/migrations/018_scoping_overrides.ts \
  | tee .workflow/logs/07b-migration-018.log

# 7c -- bare-auto YAML lives where the FlowStore reads it
test -f flows/definitions/bare-auto.yaml \
  && grep -E '^name: bare-auto$' flows/definitions/bare-auto.yaml \
  | tee .workflow/logs/07c-bare-auto.log

# 7d -- bootstrap-key Makefile target exists, refuses on running daemon, nothing more
grep -nE '^bootstrap-key:|already running on :19400|--name "\$\(NAME\)"' Makefile \
  | tee .workflow/logs/07d-bootstrap-key.log
```

PASS if:
- 7a output shows `applyScopingRuntimeHint` line < `applyScopingModelHint`
  line < `applyStageModelAndResolveSlug` line in `dispatch-core.ts`
  (matches the assertion `runtime-override.test.ts` makes at runtime).
- 7b output shows both `import * as m018 from "./018_scoping_overrides.js"`
  in `registry.ts` AND `VERSION = 18` in `018_scoping_overrides.ts`.
- 7c output shows the file exists and `name: bare-auto` is the YAML name
  field.
- 7d output shows the `bootstrap-key:` target line, the
  `already running on :19400` guard string, and the
  `--name "$(NAME)"` argument-passing line.

FAIL otherwise -- this is the human-readable affirmation in the report
that #549 / #546 / #550 actually landed in the expected places.

**Do NOT run `make bootstrap-key`.** It boots a daemon and is
side-effecting; the static grep is sufficient.

### Step 8 -- Optional builtin-flows install regression

This script (`scripts/tests/install/test-installed-builtin-flows.sh`)
asserts that compiled-binary `storeBaseDir` resolution surfaces the
builtin flows including `autonomous-sdlc`. The script greps for
`autonomous`, `autonomous-sdlc`, `quick`, `bare` (it does NOT yet grep
for `bare-auto` -- updating the list is out of scope for this smoke).
Run if `make build-cli` is fast on this host:

```bash
# Skip if `make build-cli` would rebuild the CLI from scratch (>2min);
# this step is informational, not a gate. Mark SKIP with rationale.
bash scripts/tests/install/test-installed-builtin-flows.sh \
  2>&1 | tee .workflow/logs/08-builtin-flows.log || echo "STEP8_NONZERO"
```

PASS if the script exits 0 and the `OUTPUT` it grep-prints contains
`autonomous-sdlc`. SKIP if `make build-cli` is unavailable or slow
(>2 min) -- record rationale. FAIL only on a non-zero exit that has a
reason other than build-cli prereqs.

### Step 9 -- Finalize the report

After all steps, append a `## Summary` section to `smoke-report.md`:

```markdown
## Summary

- Total steps: 9
- PASS: <n>
- FAIL: <n>  (list step numbers)
- SKIP: <n>  (list step numbers + reasons)

**Verdict:** <PASS | FAIL>  (FAIL if any required step failed; SKIP on
step 5 due to MISSING_PREREQS is acceptable and does NOT downgrade
verdict but the report MUST call it out so the reviewer can decide;
SKIP on step 8 is acceptable and informational.)

## Findings

<bullet list of any anomalies worth surfacing to verifier/reviewer.
empty list is fine -- write "None.">
```

Then commit:

```bash
git add smoke-report.md .workflow/
git commit -m "smoke: final post-fixes autonomous-sdlc sanity report"
```

Then `report(completed)` with the verdict in the summary.

## 4. Testing strategy

This task IS the test. There is no new product code to write tests for.
The "tests" for this PLAN are the nine verification steps above.

Coverage map (which steps catch what kind of regression):

| Risk | Caught by |
|------|-----------|
| Dispatch path broken (scoping hint precedence wrong) | Step 3 (`runtime-override.test.ts`), Step 7a |
| Auth middleware regression on `materializeContext` | Step 3 (`auth-routes.test.ts`, `context.test.ts`) |
| Migration 017 + 018 don't apply on fresh Postgres | Step 5 (control-plane e2e bootstraps fresh DB) |
| Migration 017 + 018 don't apply on fresh sqlite | Step 4 (`make test` runs migration runner tests against ephemeral sqlite via `AppContext.forTestAsync()`) |
| Migration 018 not registered or registered out of order | Step 3 (runner tests), Step 7b |
| `scoping_overrides` shape drift between 017 and 018 bodies | Step 3 (`scoping-overrides.test.ts`, `resolver.test.ts`); manual byte-for-byte comparison is documented in the migration files themselves |
| `requires_repo` gate skipped or over-applied | Step 6 (static) + Step 5 (e2e-docs has no `requires_repo`, must still complete) |
| Stage chain advance broken (StageAdvancer regression) | Step 5 (`e2e-docs` plan -> implement -> close depends entirely on advance) |
| Action-stage short-circuit broken | Step 5 (`e2e-noop`) |
| `bare-auto` flow YAML missing or unreadable from FlowStore | Step 6, Step 7c |
| `bare-auto` agent (`worker`) missing | Step 6 |
| `bootstrap-key` target removed or guard string drifted | Step 7d |
| Lint / format drift introduced | Step 2 |

Acceptance criteria for the verifier stage:

- `smoke-report.md` exists at repo root, is committed, and has a
  populated table.
- Verdict is `PASS`, OR verdict is `FAIL` with concrete reproduction
  evidence in `Findings`.
- Step 5 is `PASS` -- this is the load-bearing dispatch-chain signal.
  A `SKIP` here MUST include `MISSING_PREREQS` rationale. Anything
  else as `SKIP` for step 5 is a verifier-stage rejection.
- Steps 3 and 4 are `PASS` -- no exceptions; these are the unit-level
  signals.
- Step 6 is `PASS` -- if the autonomous-sdlc flow doesn't even resolve
  its agents, downstream stages of *this very task* would have failed.

## 5. Risk assessment

**The autonomous-sdlc flow itself is what's running this task.** That
makes this a self-referential smoke. Two implications:

1. If the autonomous-sdlc flow is fundamentally broken on this branch,
   we may not even reach the implement stage. The fact that the
   implement stage is reading this PLAN.md is itself partial evidence:
   at minimum plan completion + handoff to implement works.

2. The verify and review stages will run AFTER the implementer commits
   `smoke-report.md`. If a regression broke `git diff main...HEAD`
   parsing, commit handling, or `report(completed)` propagation, those
   stages will fail -- which is also a useful signal, even if it makes
   the task "fail". A failure on a *later* stage (verify/review/pr/
   merge) should be captured as a Finding rather than treated as a
   blocker by the implementer.

**Edge cases:**

- **PLAN.md is gitignored.** `.gitignore:1` lists `PLAN.md`. The
  planner committed via `git add -f PLAN.md`. The implementer must
  NOT remove this file or `git rm` it. If `git status` looks clean
  (because gitignore hides PLAN.md), the file is still on disk and
  in git history -- read it directly.
- **Docker / tmux / docker daemon missing in compute target.** Step 5
  SKIPs gracefully with `MISSING_PREREQS`. Document loudly; do not
  attempt installs. The reviewer decides whether SKIP is acceptable.
  This is the expected outcome on the previous smoke host (no colima);
  if this run is on a fresh host with colima up, step 5 should
  actually execute and PASS -- which is the upgrade we want to see
  on this final smoke.
- **Migration runner sees `017_auth_phase1` already applied** (warm
  arkDir). Step 5 uses a temp `arkDir` per-run (see
  `e2e/control-plane.test.ts`), so this is not a concern. Step 4's
  unit migration tests use ephemeral DBs via
  `AppContext.forTestAsync()`. Safe.
- **Migration 018 idempotency.** 018 is `CREATE TABLE IF NOT EXISTS`
  + `CREATE INDEX IF NOT EXISTS`; on fresh installs (017 already
  created the table) it is a no-op. Both step 4 (sqlite via tests)
  and step 5 (postgres via e2e) cover this.
- **Lint introduces a diff.** `make format && make lint` is idempotent;
  if it tries to rewrite files, that's a real issue -- record it as
  FAIL in step 2 with `git diff --stat` evidence.
- **Test suite has a flake.** The prior smoke flaked once on
  `hosted-web-auth.test.ts` and passed clean on retry. Re-run that
  one file once via `make test-file F=...` and note both runs in
  evidence. If both flake, FAIL.
- **`bun install` produces a `bun.lock` diff.** Record but don't
  commit the diff -- this branch is meant to be read-only against
  product code.
- **Step 8 `make build-cli` is slow.** Marking it SKIP is fine;
  step 8 is informational, not a gate. The previous smoke didn't
  run it at all.

**Breaking changes:** none introduced by this task.

**Migration concerns:** none introduced by this task. Migrations 017
and 018 are already on `main` via #534 and #549; we are observing
them, not modifying them.

## 6. Open questions

1. **Should we also dispatch a real autonomous-sdlc session in this
   smoke** (not just verify the chain via stubs)? A real run requires
   LLM credentials, takes 15-45 minutes, and may cost real money. The
   current plan covers the dispatch wiring (step 5 via stubs) and the
   flow YAML resolution (step 6) but NOT a live LLM round-trip through
   plan + implement + verify + review + pr + merge. **Recommendation:
   no -- keep this task hermetic and cheap. Live coverage belongs in
   nightly CI, not a per-merge smoke.**  This open-question is
   explicitly carried over from the previous smoke; the answer has
   not changed.

2. **Should we update
   `scripts/tests/install/test-installed-builtin-flows.sh:89,128,144`
   to also assert `bare-auto` is shipped as a builtin?** It would
   close the gap created by #546 (the script greps a hard-coded list
   that no longer matches the full builtin set). **Recommendation:
   out of scope for this smoke -- file as a small follow-up PR
   touching only that script. This smoke is read-only against product
   code.**  Surface in `Findings` regardless so the reviewer can pick
   it up.

3. **Should we also exercise `--flow bare-auto` end-to-end via the
   stub-runner?** It would prove the new flow doesn't sit pending
   forever after the agent reports completed (the bug #546 fixes).
   **Recommendation: a thin extension to the e2e suite (mirror the
   existing `e2e-noop` test) is the right home for this, but adding
   it requires editing `e2e/control-plane.test.ts` -- that's a code
   change and out of scope for this read-only smoke. File as a
   follow-up.**

4. **What if step 4 (full unit suite) reveals failing tests unrelated
   to the post-fixes?** Pre-existing flakes are not this task's job
   to fix. Record as Findings, mark step 4 FAIL, set verdict FAIL,
   and let the reviewer triage. Do not silently skip.
