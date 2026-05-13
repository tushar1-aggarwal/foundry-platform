# Docs Flow E2E Design — Local + Hosted Modes

**Date:** 2026-05-12
**Branch:** `control-plane-enhacement` (PR #566 already merged) → new branch off `main`
**Owner:** zineng

## Goal

Prove that the docs-style flow (`plan → implement → manual review → pr`) works end-to-end in both Ark deployment modes:

- **Local mode** — single-user laptop simulation: SQLite, file blobs, bespoke orchestrator, direct isolation, single tenant. The shape a developer uses on their machine.
- **Hosted mode** — production simulation: Postgres + Redis + Temporal orchestrator, docker isolation (agent runs in its own sidecar container), multi-tenant routing. The shape we ship to k8s.

Both modes must run the same flow end-to-end, exercise real credential resolution, real git clone, real git push, and the real `create_pr` action. The only thing simulated is the agent / LLM response — everything else (executor, isolation, env propagation, secrets, transport, channel HTTP, stage advance) is real.

## Non-goals

- Real Bitbucket / GitHub / GitLab connectivity (covered by T6 `e2e/laptop-docs-real-llm.test.ts`).
- Real Claude / Codex / Gemini LLM calls (T6).
- Web UI testing (`packages/e2e/web/*.spec.ts` is a separate concern, currently broken for unrelated reasons).
- Fan-out / fork / for_each scenarios (autonomous-sdlc, not docs flow).
- Multi-tenant routing tests beyond the implicit "hosted mode runs with multi-tenant routing active."

## Test inventory

Two test bodies, parameterized by deployment mode. **4 test cases total** + existing T6 manual-only:

| # | Test body | Mode | Test file | Approx. runtime |
|---|---|---|---|---|
| 1 | Compound: happy path + manual gate + stop/resume (a+c+d) | local | `e2e/local-bespoke.test.ts` | ~5 sec |
| 2 | Restart-then-fail: durable persistence + non-retryable failure (b+g) | local | `e2e/local-bespoke.test.ts` | ~8 sec |
| 3 | Compound (same body via RPC) | hosted (Temporal + docker sidecar) | `e2e/temporal-control-plane.test.ts` | ~30 sec |
| 4 | Restart-then-fail (same body via RPC) | hosted | `e2e/temporal-control-plane.test.ts` | ~40 sec |
| — | T6: real-LLM docs flow against Bitbucket | hosted real | `e2e/laptop-docs-real-llm.test.ts` (unchanged) | ~15 min manual |

The test bodies are shared via `e2e/helpers/docs-flow-spec.ts` and parameterized only by the boot path. The RPC sequence and assertions are identical between modes.

## Flow definition — `e2e-docs-review`

A new test fixture flow that merges the docs and review patterns so a single compound test exercises plan, implement, manual gate, stop/resume, and the `create_pr` action.

```yaml
# e2e/fixtures/flows/e2e-docs-review.yaml
name: e2e-docs-review
description: "Combined docs + review test flow: plan -> implement -> review_gate -> pr.
              requires_repo: true so the workspace prepare + clone + push paths run
              for real against a local git-http-backend server with basic auth. The
              create_pr action runs through the graceful (non-GitHub) host path."
requires_repo: true
stages:
  - name: plan
    agent: stub-planner
    gate: auto
  - name: implement
    agent: stub-implementer
    gate: auto
    depends_on: [plan]
  - name: review
    type: review_gate
    gate: manual
    depends_on: [implement]
  - name: pr
    action: create_pr
    gate: auto
    depends_on: [review]
```

## LLM simulation — fake `claude` binary

The real `claude-code` executor is used in both modes. Only the `claude` binary itself is replaced with a small bash script that:

1. Logs its received env to `${ARK_DIR}/agent-env-${ARK_STAGE}.log` (for credential-resolution debugging).
2. On `implement` stage, makes a real local commit so `git push` has something to push.
3. POSTs a real `CompletionReport` to the conductor channel HTTP endpoint and exits 0.
4. On `ARK_FAKE_CLAUDE_FAIL_STAGE=<stage>` match, POSTs an error report instead.

```bash
#!/usr/bin/env bash
# e2e/fixtures/fake-claude.sh
set -euo pipefail

SESSION_ID="${ARK_SESSION_ID:?required}"
STAGE="${ARK_STAGE:?required}"
WORKDIR="${ARK_WORKDIR:-}"

# 1. Audit trail for credential-resolution verification
mkdir -p "${ARK_DIR}/agent-envs"
printenv > "${ARK_DIR}/agent-envs/${STAGE}.log"

# 2. Failure injection (restart-then-fail test)
if [[ "${ARK_FAKE_CLAUDE_FAIL_STAGE:-}" == "${STAGE}" ]]; then
  curl -fsS -X POST "${ARK_CONDUCTOR_URL}/api/channel/${SESSION_ID}" \
    -H "Content-Type: application/json" \
    -d '{"ok": false, "error": {"type":"AuthError","message":"401 Unauthorized"}}'
  exit 0
fi

# 3. On implement, make a real commit so the pr stage has something to push
if [[ "${STAGE}" == "implement" ]] && [[ -n "${WORKDIR}" ]] && [[ -d "${WORKDIR}/.git" ]]; then
  cd "${WORKDIR}"
  echo "stub commit at $(date -u +%FT%TZ)" >> NOTES.md
  git -c user.email=stub@ark.local -c user.name=stub-implementer add NOTES.md
  git -c user.email=stub@ark.local -c user.name=stub-implementer commit -m "stub-implementer: ${SESSION_ID}"
fi

# 4. Success report
curl -fsS -X POST "${ARK_CONDUCTOR_URL}/api/channel/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -d "{\"ok\": true, \"summary\": \"stub completed ${STAGE}\"}"
```

The fake binary is invoked through the real `claude-code` executor. The agents (`stub-planner.yaml`, `stub-implementer.yaml`) declare `runtime: claude-code`. PATH is overridden so the fake binary takes priority over any real `claude` install (local mode via env, hosted mode via docker compose bind-mount).

## Fake git server — `e2e/helpers/git-http-server.ts`

A ~100-line helper that runs a real git server backed by `git-http-backend` (the standard CGI helper shipped with git) behind a Bun HTTP layer that enforces basic auth.

```
┌────────────────────────────────────────────────────────────────┐
│ Test (beforeAll)                                               │
│   const server = await startGitHttpServer({                    │
│     repoPath: $TMP/fake-bitbucket.git,                         │
│     expectedToken: "test-fake-token-XYZ",                      │
│     logFile: $ARK_DIR/git-auth-log.txt,                        │
│   })                                                           │
│   // → server.url === "http://localhost:54321/repo.git"        │
└────────────────────────────────────────────────────────────────┘
                            │
                            ▼ git HTTP from Ark's clone/push
┌────────────────────────────────────────────────────────────────┐
│ Bun.serve (ours)                                               │
│   1. Log Authorization header                                  │
│   2. Decode "Basic <b64>" → reject if not "user:<token>"       │
│   3. On accept, exec git-http-backend (CGI) with:              │
│        GIT_PROJECT_ROOT=$TMP                                   │
│        PATH_INFO=/repo.git/...                                 │
│        REQUEST_METHOD, QUERY_STRING, CONTENT_TYPE, ...         │
│      Pipe req.body to stdin; stream stdout back as response    │
└────────────────────────────────────────────────────────────────┘
                            │
                            ▼ spawn per request
┌────────────────────────────────────────────────────────────────┐
│ git-http-backend (standard git binary)                         │
│   Implements full git smart-HTTP: info/refs, upload-pack,      │
│   receive-pack. Reads/writes the bare repo under repoPath.     │
└────────────────────────────────────────────────────────────────┘
```

**Authentication contract:**

| Authorization header | Server response | Test outcome |
|---|---|---|
| `Basic <b64 of "user:test-fake-token-XYZ">` | 200 + git protocol | clone/push succeed |
| `Basic <b64 of anything else>` | 401 | clone/push fail; test fails (catches wrong-cred regression) |
| missing | 401 | clone/push fail; test fails (catches no-cred-lookup regression) |

The success of clone/push is itself the assertion — if the wrong secret was selected, the server returns 401 and clone fails. The auth log is kept as a debug aid for diagnosing failures, not as the load-bearing assertion.

**Helper API:**

```ts
export async function startGitHttpServer(opts: {
  repoPath: string;          // path to a bare repo on disk
  expectedToken: string;     // basic-auth token value to accept
  logFile?: string;          // optional: log every Authorization header here
  bindAddr?: string;         // "127.0.0.1" (local) or "0.0.0.0" (hosted, reachable from docker)
}): Promise<{ url: string; port: number; kill: () => Promise<void> }>;
```

**Hosted-mode (docker isolation) wrinkle:**

When the agent runs inside a docker sidecar container, `localhost` doesn't refer to the host. Two options:

- (a) bind the server to `0.0.0.0` and reach it from the container as `http://host.docker.internal:PORT/repo.git` (Docker Desktop default).
- (b) put the server on the same compose network as the sidecar via a small wrapper service.

We use (a) — bind `0.0.0.0`, return `host.docker.internal` in the URL for hosted-mode test. Simpler, no compose changes.

## Test assertions

### Test 1: Compound (a + c + d) — happy path + manual gate + stop/resume

User journey: "I start a docs session. The agent plans and implements (with a real commit). I review the implementation in the UI. I stop the session, then resume. I approve. The PR action runs and pushes the branch. The session is done."

| Step | Action | Assertion |
|---|---|---|
| Pre | Create `${TMP}/fake-bitbucket.git`, `git init --bare`, seed one commit on `main` | Repo exists, has one commit |
| Pre | `startGitHttpServer({ repoPath, expectedToken: "test-fake-token-XYZ" })` | Server reachable on its port |
| Pre | `secret/set { name: "BITBUCKET_ACCESS_TOKEN", value: "test-fake-token-XYZ", tenant: "default" }` | Cred seeded |
| 1 | `session/start { flow: "e2e-docs-review", summary, repo: <server.url> }` | response: `session.id` matches `/^s-/`, `flow === "e2e-docs-review"`, `status ∈ {ready, running}` |
| 1a | (hosted only) | `session.orchestrator === "temporal"`, `session.workflow_id` matches `/^session-/` |
| 2 | Poll `session/read` until `status === "ready" && stage === "review"` (30 s budget) | Session reaches parked-at-gate state |
| 3 | Inspect `session.workdir` on disk | `${workdir}/.git` exists (clone ran) |
| 4 | `git --git-dir=${workdir}/.git log --oneline` | Shows the seeded initial commit (clone fetched main correctly) |
| 5 | `${workdir}/NOTES.md` contents | Contains `"stub commit at"` (implement stage commit succeeded) |
| 6 | `session/stop { sessionId }` | response `{ ok: true }` |
| 7 | Poll `status === "stopped"` (10 s budget) | Stop transition completed |
| 8 | `session/resume { sessionId }` | response `{ ok: true }` |
| 9 | Poll `status === "ready" && stage === "review"` | Resume restored gate-parked state; `pr_url` field still null at this point (set later by pr stage) |
| 10 | `gate/approve { sessionId, decision: "approve" }` | response `{ ok: true }` |
| 11 | Poll until `status === "completed"` (30 s budget) | Full flow finished |
| 12 | Final session state | `status === "completed"`, `stage === "pr"`, `error === null`, `pr_url` non-null |
| 13 | `git --git-dir=${TMP}/fake-bitbucket.git log <session.branch> --oneline` | Shows the stub-implementer commit (push ran for real against the fake server) |
| 14 | Event log (`session/read { include: ["events"] }`) | Contains `action_executed` with `data.action === "create_pr"`, NO `data.skipped` field (action ran the graceful push path, not the pr_already_exists short-circuit) |
| 15 | Event log | Contains exactly zero `dispatch_failed` events (regression guard for the DbResourceStore cold-cache bug fixed in PR #566) |
| 16 | Auth log (`${ARK_DIR}/git-auth-log.txt`) | Contains at least one `Authorization: Basic ...` entry decoding to `:test-fake-token-XYZ` (debug aid — if test fails, inspect this to see what cred was sent) |

### Test 2: Restart-then-fail (b + g) — durable persistence + non-retryable failure

User journey: "I start a docs session. The agent plans successfully. The server crashes mid-flow. I bring it back up. The agent retries implement but fails with a clear authentication error. The session is marked failed; nothing is silently swallowed."

| Step | Action | Assertion |
|---|---|---|
| Pre | Same bare repo + auth server + seeded cred as Test 1 | — |
| Pre | Spawn server with `ARK_FAKE_CLAUDE_FAIL_STAGE=implement` in env | Fake claude will succeed on plan, fail on implement |
| 1 | `session/start { flow: "e2e-docs-review", summary, repo: <server.url> }` | `session.id` matches `/^s-/` |
| 1a | (hosted only) | `session.orchestrator === "temporal"`, `workflow_id` set |
| 2 | Poll until plan completes; reach `stage === "implement"` (20 s budget) | Plan ran successfully despite FAIL_STAGE flag (only `implement` is targeted) |
| 3 | Inspect `${workdir}/.git` | Exists (clone ran pre-crash) |
| 4 | `proc.kill("SIGKILL")` on the server subprocess | No RPC response — kill is from outside |
| 5 | Verify port `:8420` (local) or `:8422` (hosted) is free | `lsof -ti :<port>` returns nothing |
| 6 | Restart server with same `ARK_DIR` + same env (FAIL flag still set) | Poll `/api/health` until 200 |
| 7 | (Hosted only) | Verify same Temporal workflow continued: `session/read.workflow_id` unchanged from pre-crash value |
| 8 | Poll `session/read` until terminal status (60 s budget) | Reach `status === "failed"` |
| 9 | Final session state | `status === "failed"`, `stage === "implement"`, `error` matches `/AuthError\|401\|Unauthorized/` |
| 10 | Final session state | `pr_url === null` (failure short-circuits pr stage) |
| 11 | Event log | Contains either `agent_failed` or `dispatch_failed` event matching `/AuthError\|401\|Unauthorized/` |
| 12 | Event log (regression guard) | NO event has reason matching `/No runtime resolvable/` — the failure must be the agent's AuthError, never the framework's cold-cache leak |

## File-level changes

### Delete

| File | Reason |
|---|---|
| `e2e/control-plane.test.ts` | Tests hosted+bespoke; real prod = Temporal+docker, so this scenario doesn't match production |
| `e2e/fixtures/flows/e2e-review.yaml` | Subsumed by `e2e-docs-review` (adds implement + pr stages) |
| `flows/definitions/e2e-docs.yaml` | Only referenced by the deleted `control-plane.test.ts` |
| `flows/definitions/e2e-noop.yaml` | Only referenced by the deleted `control-plane.test.ts` |
| `e2e/fixtures/stub-runner-executor.mjs` | Replaced by the real `claude-code` executor + fake binary |
| `e2e/fixtures/stub-agent.sh` | Replaced by `e2e/fixtures/fake-claude.sh` |
| All 8 tests inside `temporal-control-plane.test.ts` (T0, T1, T1.5, T2, T3, T4, T5a, T5b) | 6 are currently skipped, 2 active (T1, T5b); coverage subsumed by the new compound + restart-fail tests, which assert orchestrator=temporal + AuthError surfacing inline |

### Modify

| File | Change |
|---|---|
| `e2e/temporal-control-plane.test.ts` | 488 lines → ~120 lines; 8 tests → 2 (compound + restart-fail); calls shared body from `e2e/helpers/docs-flow-spec.ts` |
| `e2e/helpers/server-process.ts` | Add `startLocalServer()` next to existing `startHostedServer()` — no `--hosted`, no Postgres dep, single-tenant, port 8420 |
| `e2e/fixtures/agents/stub-planner.yaml` | `runtime: stub-runner` → `runtime: claude-code` |
| `e2e/fixtures/agents/stub-implementer.yaml` | `runtime: stub-runner` → `runtime: claude-code` |
| `.infra/docker-compose.e2e.yaml` | Bind-mount `e2e/fixtures/fake-claude.sh` into the sidecar service at `/usr/local/bin/claude` (overrides any image-baked claude inside the container) |
| `Makefile` | Add `test-e2e-local-bespoke` target; consolidate hosted target to drive the new file shape |

### Add

| File | Purpose |
|---|---|
| `e2e/local-bespoke.test.ts` | 2 tests (compound + restart-fail) — local mode boot via `startLocalServer()` |
| `e2e/helpers/docs-flow-spec.ts` | Shared test bodies. Two exported functions: `compoundDocsFlowSpec(rpcClient, opts)` and `restartThenFailSpec(rpcClient, opts, restartFn)`. RPC-only — mode-agnostic. |
| `e2e/helpers/git-http-server.ts` | Fake-bitbucket helper using `git-http-backend` + basic auth (~100 lines) |
| `e2e/fixtures/flows/e2e-docs-review.yaml` | New merged flow definition |
| `e2e/fixtures/fake-claude.sh` | Fake claude binary (see "LLM simulation" section above) |

### Keep as-is

| File | Reason |
|---|---|
| `e2e/laptop-docs-real-llm.test.ts` | T6 still owns real-LLM, real-Bitbucket coverage |
| `e2e/helpers/docker-stack.ts` | Unchanged |
| `e2e/helpers/rpc-client.ts` | Unchanged |
| `e2e/fixtures/agents/stub-closer.yaml` (if used by the deleted tests) | Reassess during implementation — delete if orphaned |

## Boot paths

### Local mode (`e2e/local-bespoke.test.ts`)

```
1. mkdir $TMPDIR/ark-local-<rand>                              # ARK_DIR
2. Install fake-claude.sh in $ARK_DIR/bin/                     # PATH override
3. Spawn server:
     Bun.spawn(["bun", "packages/cli/index.ts", "server", "start"],
       env: {
         PATH:                       "$ARK_DIR/bin:$PATH",
         ARK_PROFILE:                "local",
         ARK_DIR:                    "$ARK_DIR",
         ARK_AUTH_REQUIRE_TOKEN:     "false",
         ARK_DEV_FORCE_DIRECT:       "1",
         ARK_FAKE_CLAUDE_FAIL_STAGE: "<set only for restart-fail test>",
       })
4. Poll /api/health (200) + /api/rpc { method: "session/list" } until ready
5. Tests use rpc-client against http://localhost:8420
6. Teardown: proc.kill("SIGTERM") then SIGKILL after 2 sec; rm -rf $ARK_DIR
```

Cold-start: ~3 sec. No Docker, no Postgres, no Redis, no Temporal.

### Hosted mode (`e2e/temporal-control-plane.test.ts`)

```
1. docker-stack.up()
     # postgres :15434, redis :6380, temporal stack (server/ui/worker/postgres),
     # arkd, temporal-worker, all on the ark-e2e compose network
2. Spawn server:
     Bun.spawn(["bun", "packages/cli/index.ts", "server", "start", "--hosted"],
       env: {
         PATH:                       "$ARK_DIR/bin:$PATH",
         ARK_PROFILE:                "control-plane",
         DATABASE_URL:               "postgres://ark:ark@localhost:15434/ark",
         REDIS_URL:                  "redis://localhost:6380",
         ARK_TEMPORAL_SERVER_URL:    "localhost:7234",
         ARK_TEMPORAL_NAMESPACE:     "default",
         ARK_FEATURE_TEMPORAL_ORCHESTRATION: "true",
         ARK_DEV_FORCE_DIRECT:       "1",
         ARK_FAKE_CLAUDE_FAIL_STAGE: "<set only for restart-fail test>",
       })
3. fake-claude.sh bind-mounted into sidecar at /usr/local/bin/claude
   via .infra/docker-compose.e2e.yaml volume entry
4. Poll /api/health + /api/rpc { session/list } on http://localhost:8422 until ready
5. Tests use rpc-client against http://localhost:8422
6. Teardown: proc.kill() + docker-stack.down() -v
```

Cold-start: ~30 sec. Full prod-shaped stack.

## Failure injection mechanism

`ARK_FAKE_CLAUDE_FAIL_STAGE=<stage>` env var, set on the spawned server BEFORE start. Propagated through Ark's launch env to the spawned agent process. The fake claude script reads this env and, if it matches its own `ARK_STAGE`, posts a `CompletionReport` with `ok: false, error: { type: "AuthError", message: "401 Unauthorized" }` instead of success.

This single env var drives the failure path. The compound test does not set it (all stages succeed). The restart-then-fail test sets it to `implement` so plan succeeds but implement fails after restart.

## Cross-cutting invariants

| Invariant | How asserted |
|---|---|
| No silent failures | Every RPC must return `{ ok: true }` or expected payload; tests fail on `undefined` or unexpected error |
| Test isolation | Each test creates its own `ARK_DIR` (temp); no shared state |
| Mode-specific orchestrator | Local → `session.orchestrator === "custom"`; Hosted → `=== "temporal"` |
| Mode-specific ports | Local → `:8420`; Hosted → `:8422` (so they can run side-by-side) |
| Teardown is complete | `docker ps \| grep ark-e2e` empty after hosted test; temp dirs removed |
| No assertion relaxation | If a test fails during implementation, fix the production code or the helper. Do NOT weaken any assertion in this spec. If an assertion proves incorrect, return to spec amendment, not silent edit. |

## Implementation order

The implementation plan (separate doc, generated by writing-plans) will sequence these steps. Sketch:

1. Add `e2e/fixtures/flows/e2e-docs-review.yaml` (+ delete the obsolete flow YAMLs).
2. Add `e2e/fixtures/fake-claude.sh`.
3. Update `e2e/fixtures/agents/stub-{planner,implementer}.yaml` to `runtime: claude-code`.
4. Add `e2e/helpers/git-http-server.ts` + unit-level smoke test.
5. Extend `e2e/helpers/server-process.ts` with `startLocalServer()`.
6. Add `e2e/helpers/docs-flow-spec.ts` with the two shared spec bodies.
7. Write `e2e/local-bespoke.test.ts` — wire up boot + call shared bodies.
8. Run local tests, verify pass.
9. Update `.infra/docker-compose.e2e.yaml` to bind-mount `fake-claude.sh` into the sidecar.
10. Rewrite `e2e/temporal-control-plane.test.ts` from 488 lines / 8 tests to ~120 lines / 2 tests, calling the shared bodies.
11. Run hosted tests, verify pass.
12. Delete dead files: `e2e/control-plane.test.ts`, `e2e/fixtures/stub-runner-executor.mjs`, `e2e/fixtures/stub-agent.sh`, `flows/definitions/e2e-docs.yaml`, `flows/definitions/e2e-noop.yaml`, `e2e/fixtures/flows/e2e-review.yaml`.
13. Update `Makefile` targets.
14. Run both targets again from a clean state; ensure CI-equivalent green.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Real `claude-code` executor expects specific CLI args or stdout format | The fake binary supports stdin/argv parsing best-effort; if executor crashes, expand the script. The conductor channel HTTP completion is what advances stages, not stdout parsing. |
| Sidecar image has its own `claude` baked in | Compose bind-mount overlays at `/usr/local/bin/claude`; any image-baked binary is unreachable. |
| `git-http-backend` not on PATH | Pre-flight check in the helper: `which git-http-backend` (or fall back to `git --exec-path`/`git-http-backend`). Ships with git; should be present everywhere. |
| `host.docker.internal` unreachable on Linux CI | Use `--add-host=host.docker.internal:host-gateway` in compose (already a documented Docker pattern); fall back to bridge gateway IP if needed. |
| Credential resolution code path differs between local and hosted (different secret store backends) | Both code paths converge on the same DispatchService and the same `buildLaunchEnv` helper. Differences surface as a 401 from the auth server — the test catches them. |
| The DbResourceStore cold-cache leak resurfaces in a new spot | Test 1 step 15 + Test 2 step 12 explicitly assert no `dispatch_failed` / `No runtime resolvable` events. Regression guard active. |
| Restart-test race: server killed before plan completes its first commit | Restart-then-fail test polls for `stage === "implement"` BEFORE killing, so plan is durably persisted in the session row. |
| Stub-closer agent fixture remains as orphan | Audit during step 7 of implementation; delete if not referenced anywhere. |

## Out of scope (future work)

- Adding a local-mode T6 variant (real claude, real bitbucket, but with local profile).
- Re-enabling the disabled `e2e (control-plane + temporal)` CI job — but the new tests should be added to the CI workflow under a separate, working job.
- Web UI test consolidation (`packages/e2e/web/*.spec.ts`).
- Per-tenant tests in hosted mode.

## References

- `docs/superpowers/specs/2026-05-07-temporal-integration-design.md` — the Temporal architecture this spec depends on
- `e2e/laptop-docs-real-llm.test.ts` — T6, the real-LLM equivalent
- `packages/core/services/worktree/pr.ts:14-21` — confirms Bitbucket PR creation uses the graceful (push-and-parse-stderr) path, not a REST API
- `packages/core/services/actions/create-pr.ts:22-29` — the `pr_url`-already-set short-circuit we intentionally bypass by using `requires_repo: true`
- PR #566 (merged) — fixes the DbResourceStore cold-cache leak this spec asserts against
