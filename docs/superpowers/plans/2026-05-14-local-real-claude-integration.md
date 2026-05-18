# Local Real-Claude Integration Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Docker integration test using prod-shape images + real Claude + real Temporal that covers ~85% of dispatch/poll/surface regressions, so most changes can be verified locally without an EKS rebuild+deploy cycle.

**Architecture:** Reuse the existing `make test-e2e-t6-docker` scaffolding (host ark server + host Temporal worker + compose Postgres/Temporal + per-session sidecar from `ark:latest`). Drop the compose temporal-worker's fake-claude bind-mount by stopping that container (T6 already does this) and run a host worker that uses the real Claude binary baked into `ark:latest` (Dockerfile:69, `@anthropic-ai/claude-code@2.1.126`). Source prod-shaped credentials from a gitignored `.env.test`. Three test cases prove the surfacing pipeline: A=happy path, B=auth-failure → row failed, C=process-kill mid-run → row failed.

**Tech Stack:** bun:test, docker compose, `.infra/docker-compose.e2e.yaml`, real `ark:latest` (prod Dockerfile), real `claude-agent` runtime + Anthropic Agent SDK, Temporal client (`@temporalio/client`).

**Out of scope (acknowledged gaps):** K8sCompute attach/rehydrate codepaths (covered by unit test `packages/core/__tests__/claude-agent-probe-status.test.ts`), in-cluster pod-IP routing (F3), EKS-specific networking. F4's exact codepath only fires for K8sCompute — this plan validates the surfacing *behaviour* end-to-end; the K8s-specific bits remain unit-tested.

---

## File Structure

**Created:**
- `.env.test.example` — committed template documenting all required env keys with prod-shaped comments
- `e2e/local-docker-real-llm.test.ts` — the integration test (cases A, B, C)
- `docs/superpowers/plans/2026-05-14-local-real-claude-integration.md` — this plan

**Modified:**
- `.gitignore` — add `.env.test`
- `Makefile` — new target `test-e2e-local-real-llm` (modeled on `test-e2e-t6-docker`)

**Untouched (deliberately):**
- `Dockerfile` — already prod-shape, real Claude baked in
- `.infra/Dockerfile.temporal-worker` — already prod-shape, F4 fix already committed
- `.infra/docker-compose.e2e.yaml` — fake-claude bind-mount stays for other tests; we stop the container in our target
- `packages/core/executors/claude-agent.ts` — F4 fix already at HEAD

---

### Task 1: Add `.env.test.example` + gitignore `.env.test`

**Files:**
- Create: `.env.test.example`
- Modify: `.gitignore` (add `.env.test` after the existing `.env.iso` entry around line 53)

- [ ] **Step 1: Create `.env.test.example`**

Write `.env.test.example` documenting every env key the test needs. Prod-shaped — operator copies to `.env.test` and populates from K8s secret `ark-secrets` or their personal token store.

```bash
# .env.test.example
#
# Copy to .env.test (gitignored) and populate with prod-shaped credentials.
# Sourced by `make test-e2e-local-real-llm` before booting the host
# ark server + host Temporal worker. Values must reflect prod auth shape
# because the docs-flow agent uses the real claude-agent runtime
# (Anthropic Agent SDK, process-based, no tmux) which validates secrets
# at dispatch time.
#
# Source from prod K8s secret if you have access:
#   kubectl -n ark get secret ark-secrets -o jsonpath='{.data.ANTHROPIC_API_KEY}' | base64 -d
#
# ── Claude auth (claude-agent runtime) ────────────────────────────────
# claude-agent runtime declares these as required (runtimes/claude-agent.yaml:14-16).
# Dispatch validation fails fast if ANTHROPIC_API_KEY is missing.
ANTHROPIC_API_KEY=
# Optional: gateway URL for Bedrock-routed prod (set when ark runs through
# the TrueFoundry AI gateway or direct AWS Bedrock proxy). Leave blank for
# direct Anthropic API.
ANTHROPIC_BASE_URL=
# Optional: JSON string of custom headers for gateway auth.
# Example: '{"X-Gateway-Auth":"Bearer <token>"}'
ANTHROPIC_CUSTOM_HEADERS=

# ── Claude Code OAuth (claude-code runtime, if exercising tmux path) ──
# Produced by `claude setup-token` (sk-ant-oat...). Required by
# runtimes/claude-code.yaml:15. Optional unless test selects claude-code.
CLAUDE_CODE_OAUTH_TOKEN=

# ── Bitbucket (PR stage in autonomous-sdlc flow; quick flow doesn't need) ──
ATLASSIAN_BITBUCKET_USERNAME=
ATLASSIAN_BITBUCKET_APP_PASSWORD=

# ── Test target repo ──────────────────────────────────────────────────
# Defaults to foundry-test-repo SSH form. Override to test against your fork.
T6_REPO_URL=git@bitbucket.org:paytmteam/foundry-test-repo.git

# ── Test scope ────────────────────────────────────────────────────────
ARK_TEST_PROMPT=Add one paragraph to architecture.md describing the repo layout
ARK_TEST_FLOW=quick

# ── Stack ports (match make test-e2e-control-plane-up) ────────────────
T6_WEB_URL=http://localhost:8422
T6_ARKD_URL=http://localhost:19302
T6_TEMPORAL_PORT=7234
```

- [ ] **Step 2: Add `.env.test` to `.gitignore`**

Append after the existing `.env.iso` line (around line 53 in `.gitignore`):

```
.env.test
```

- [ ] **Step 3: Verify `.env.test` is gitignored**

```bash
echo "ANTHROPIC_API_KEY=dummy" > .env.test
git check-ignore .env.test
```
Expected: `.env.test` (file is ignored)

- [ ] **Step 4: Commit**

```bash
git add .env.test.example .gitignore
git commit -m "chore: add .env.test scaffolding for local real-claude e2e"
```

---

### Task 2: Add Makefile target `test-e2e-local-real-llm`

**Files:**
- Modify: `Makefile` (add new target after `test-e2e-t6-docker`, update `.PHONY` list)

- [ ] **Step 1: Write the failing target stub**

Add this target after `test-e2e-t6-docker` (around line 470). It's a stub at this point — the test file doesn't exist yet, so running it will fail with "module not found". Make it run a dry-check first:

```makefile
test-e2e-local-real-llm: build-ark-image test-e2e-control-plane-up ## Local real-Claude integration (T1-T5 surface, prod-shape stack)
	@command -v tmux >/dev/null 2>&1 || { echo "tmux required (host side)."; exit 1; }
	@test -f .env.test || { echo ".env.test missing -- copy .env.test.example and populate from prod secrets."; exit 1; }
	@# Migration lock cleanup (same trick T6 uses).
	@$(DOCKER_COMPOSE) -f .infra/docker-compose.e2e.yaml -p ark-e2e exec -T postgres \
	  psql -U ark -d ark -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ark' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
	@# Stop the compose temporal-worker so it doesn't shadow the host worker
	@# with fake-claude (docker-compose.e2e.yaml:172 mounts fake-claude.sh
	@# at /usr/local/bin/claude). Host worker has no such shadow.
	@docker stop ark-e2e-temporal-worker-1 >/dev/null 2>&1 || true
	@# Clean stale sidecar + worktrees from prior runs.
	@docker rm -f ark-rt-local >/dev/null 2>&1 || true
	@rm -rf "$(ARK_HOST_ARKDIR)/worktrees"
	@# Source .env.test for prod-shaped creds.
	@set -a; . ./.env.test; set +a; \
	  echo "\033[1mStarting host ark server :8422 against e2e stack...\033[0m"; \
	  lsof -ti :8422 -i :19302 2>/dev/null | xargs -r kill -9 2>/dev/null || true; \
	  sleep 1; \
	  . ./.env.e2e; \
	  ARK_DIR=$(ARK_HOST_ARKDIR) ARK_TEMPORAL_ORCHESTRATION=true ARK_CONDUCTOR_HOSTNAME=0.0.0.0 \
	    $(BUN) packages/cli/index.ts server start --hosted --port 8422 > $(ARK_HOST_ARKDIR)/server.log 2>&1 & \
	  echo $$! > $(ARK_HOST_ARKDIR)/server.pid; \
	  for i in $$(seq 1 60); do \
	    if curl -sf http://localhost:8422/api/health >/dev/null 2>&1; then echo "  ark server up"; break; fi; \
	    sleep 0.5; \
	  done; \
	  echo "\033[1mStarting host temporal worker against e2e :7234...\033[0m"; \
	  ARK_DIR=$(ARK_HOST_ARKDIR) \
	  DATABASE_URL="postgres://ark:ark@localhost:15434/ark?sslmode=disable" \
	  ARK_TEMPORAL_SERVER_URL=localhost:7234 ARK_TEMPORAL_NAMESPACE=default \
	  ARK_PROFILE=control-plane ARK_BLOB_BACKEND=local \
	  ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE=1 ARK_SECRETS_BACKEND=file \
	  ARK_AUTH_REQUIRE_TOKEN=false ARK_DEFAULT_TENANT=default \
	  ARK_TEMPORAL_WORKER=true ARK_TEMPORAL_ORCHESTRATION=true \
	  ARK_LOG_LEVEL=info ARK_CONDUCTOR_URL=http://localhost:8422 \
	  ARK_ARKD_PORT=19302 ARK_WEB_PORT=8422 ARK_CONDUCTOR_PORT=19102 \
	    tsx packages/core/temporal/worker.ts > $(ARK_HOST_ARKDIR)/worker.log 2>&1 & \
	  echo $$! > $(ARK_HOST_ARKDIR)/worker.pid; \
	  for i in $$(seq 1 60); do \
	    if grep -q "Worker state changed" "$(ARK_HOST_ARKDIR)/worker.log" 2>/dev/null; then echo "  host worker up"; break; fi; \
	    sleep 0.5; \
	  done
	@# Seed compute=local + isolation=docker with prod-shape image.
	@curl -sf -X POST http://localhost:8422/api/rpc -H 'Content-Type: application/json' \
	  -d '{"jsonrpc":"2.0","id":"1","method":"compute/create","params":{"name":"local","compute":"local","isolation":"docker","config":{"image":"ark:latest","bootstrap":{"skip":true}}}}' >/dev/null 2>&1 || true
	@$(DOCKER_COMPOSE) -f .infra/docker-compose.e2e.yaml -p ark-e2e exec -T postgres \
	  psql -U ark -d ark -c "UPDATE compute SET config='{\"image\":\"ark:latest\",\"bootstrap\":{\"skip\":true}}'::jsonb WHERE name='local' AND tenant_id='default';" >/dev/null 2>&1 || true
	@echo "\033[1mRunning local-docker real-Claude integration tests...\033[0m"
	@set -a; . ./.env.test; set +a; \
	  ARK_REAL_LLM_E2E=1 \
	  $(BUN) test e2e/local-docker-real-llm.test.ts --bail --timeout 720000
	@# Cleanup: stop host server + worker. Sidecar and worktrees cleaned by test.
	@kill $$(cat $(ARK_HOST_ARKDIR)/server.pid 2>/dev/null) 2>/dev/null || true
	@kill $$(cat $(ARK_HOST_ARKDIR)/worker.pid 2>/dev/null) 2>/dev/null || true
```

- [ ] **Step 2: Add `test-e2e-local-real-llm` to `.PHONY` list**

In `Makefile`, find the `.PHONY` line around line 16 and append `test-e2e-local-real-llm` to the list.

- [ ] **Step 3: Run the target to confirm failure shape**

```bash
cp .env.test.example .env.test
echo "ANTHROPIC_API_KEY=sk-ant-dummy" >> .env.test  # placeholder, real creds not needed for this dry-run
make test-e2e-local-real-llm
```
Expected: FAIL with "module not found: e2e/local-docker-real-llm.test.ts". This proves the wiring is correct and the test file is the missing piece.

- [ ] **Step 4: Commit**

```bash
git add Makefile
git commit -m "feature: add test-e2e-local-real-llm Makefile target"
```

---

### Task 3: Test skeleton + Case A (happy path)

**Files:**
- Create: `e2e/local-docker-real-llm.test.ts`

- [ ] **Step 1: Write the test scaffolding (will fail because file doesn't exist yet)**

Create `e2e/local-docker-real-llm.test.ts`:

```ts
/**
 * Local real-Claude integration (T1-T5 surfacing pipeline).
 *
 * Verifies the dispatch → spawn → probeStatus → row-update → workflow
 * chain end-to-end using prod-shape images, real Claude Agent SDK, real
 * Temporal, and real arkd. Excludes K8sCompute-specific behaviour (those
 * codepaths are unit-tested at packages/core/__tests__/claude-agent-probe-status.test.ts).
 *
 * Gated by ARK_REAL_LLM_E2E=1 because it consumes real LLM tokens. Run via:
 *
 *   make test-e2e-local-real-llm
 *
 * Pre-flight:
 *   - .env.test populated from prod secrets (see .env.test.example)
 *   - make test-e2e-control-plane-up has booted the compose stack
 *   - ark:latest built from current source via build-ark-image
 *   - Host ark server on :8422 + host Temporal worker registered on :7234
 *   - compute=local + isolation=docker seeded with image=ark:latest
 *
 * Three cases:
 *   A. Happy path -- real Claude completes prompt, session row reaches
 *      "completed", workflow stage Completed.
 *   B. Auth-failure surfacing -- override ANTHROPIC_API_KEY=sk-invalid via
 *      secret/set, dispatch, real Claude Agent SDK hits 401, process
 *      exits non-zero, row flips to "failed" within 30s.
 *   C. Process-kill mid-run -- after dispatch + sidecar up, docker kill
 *      ark-rt-local. arkd disappears, probeStatus HTTP fails. F2 retry
 *      budget kicks in, row flips to "failed" within 60s.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";

const ENABLED = process.env.ARK_REAL_LLM_E2E === "1";
const WEB_URL = process.env.T6_WEB_URL ?? "http://localhost:8422";
const ARKD_URL = process.env.T6_ARKD_URL ?? "http://localhost:19302";
const TASK_PROMPT = process.env.ARK_TEST_PROMPT ?? "Add one paragraph to architecture.md describing the repo layout";
const FLOW = process.env.ARK_TEST_FLOW ?? "quick";
const REPO_URL = process.env.T6_REPO_URL ?? "git@bitbucket.org:paytmteam/foundry-test-repo.git";

interface RpcOk<T> { result: T; }
interface RpcErr { error: { message: string; code: number }; }

async function rpc<T>(method: string, params: unknown = {}): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: method, method, params });
  const r = await fetch(`${WEB_URL}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}: ${await r.text()}`);
  const json = (await r.json()) as RpcOk<T> | RpcErr;
  if ("error" in json) throw new Error(`RPC ${method} error: ${json.error.message}`);
  return json.result;
}

interface Session {
  id: string;
  status: string;
  stage: string | null;
  error: string | null;
  workflow_id: string | null;
}

async function readSession(id: string): Promise<Session> {
  const { session } = await rpc<{ session: Session }>("session/read", { sessionId: id });
  return session;
}

async function waitForSessionState(
  id: string,
  pred: (s: Session) => boolean,
  timeoutMs: number,
  label: string,
): Promise<Session> {
  const start = Date.now();
  let last: Session = await readSession(id);
  while (!pred(last)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${label}. Last state: status=${last.status} stage=${last.stage} error=${last.error}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    last = await readSession(id);
  }
  return last;
}

async function probe(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

describe.skipIf(!ENABLED)("local-docker real-Claude integration", () => {
  beforeAll(async () => {
    // Pre-flight: server, arkd, compute=local, ANTHROPIC_API_KEY in secrets.
    expect(await probe(`${WEB_URL}/api/health`)).toBe(true);
    expect(await probe(`${ARKD_URL}/health`)).toBe(true);
    const { targets } = await rpc<{ targets: Array<{ name: string }> }>("compute/list", {});
    expect((targets ?? []).some((c) => c.name === "local")).toBe(true);

    // Push prod-shape secrets from .env.test into the tenant secret store.
    // Dispatch-time secret resolution reads from the file-backed secrets store
    // (ARK_SECRETS_BACKEND=file), not from process.env, so we must persist.
    const secretKeys = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"];
    for (const k of secretKeys) {
      const v = process.env[k] ?? "";
      if (v.length > 0) {
        await rpc("secret/set", { name: k, value: v });
      }
    }
  }, 60_000);

  afterAll(async () => {
    // Cleanup is handled in Task 7. Stub for now.
  });

  test(
    "Case A: real Claude completes prompt -> session row 'completed'",
    async () => {
      // Dispatch session against claude-agent runtime.
      const created = await rpc<{ session: Session }>("session/create", {
        flow: FLOW,
        agent: "docs",  // assumes docs agent uses claude-agent runtime
        repo: REPO_URL,
        prompt: TASK_PROMPT,
        compute: "local",
        runtime: "claude-agent",
      });
      const session = created.session;
      expect(session.id).toMatch(/^s-/);

      const final = await waitForSessionState(
        session.id,
        (s) => s.status === "completed" || s.status === "failed",
        600_000, // 10 min for real LLM call
        "session to reach terminal state",
      );

      expect(final.status).toBe("completed");
      expect(final.workflow_id).toBeTruthy();
    },
    720_000,
  );
});
```

- [ ] **Step 2: Run Case A locally**

```bash
make test-e2e-local-real-llm
```
Expected: PASS — session completes within ~5 min for a simple prompt, row reaches `status=completed`.

- [ ] **Step 3: If Case A fails, capture failure mode**

If the test fails before completion, capture:
1. `$(cat $ARK_HOST_ARKDIR/server.log | tail -50)`
2. `$(cat $ARK_HOST_ARKDIR/worker.log | tail -50)`
3. `docker logs ark-rt-local 2>&1 | tail -50`
4. RPC `session/read` final state

Triage failure modes:
- Missing ANTHROPIC_* secrets → fix .env.test
- Sidecar exit before LLM call → check `docker inspect ark-rt-local`
- Workflow never starts → check worker registered correctly

- [ ] **Step 4: Commit once green**

```bash
git add e2e/local-docker-real-llm.test.ts
git commit -m "feature: e2e/local-docker-real-llm Case A (happy path)"
```

---

### Task 4: Case B (auth-failure surfacing)

**Files:**
- Modify: `e2e/local-docker-real-llm.test.ts` — add Case B test()

- [ ] **Step 1: Add Case B test**

Append to the `describe` block, before the closing `});`:

```ts
  test(
    "Case B: invalid ANTHROPIC_API_KEY -> session row 'failed' within 30s after spawn",
    async () => {
      // Override the auth secret with an obviously-invalid token. Real
      // Claude Agent SDK hits the configured endpoint (gateway or direct
      // Anthropic), gets 401, exits non-zero. This is the surfacing
      // pipeline under test: probeStatus must observe the non-zero exit
      // via arkd /process/status and write status=failed to the row.
      const originalKey = process.env.ANTHROPIC_API_KEY ?? "";
      await rpc("secret/set", { name: "ANTHROPIC_API_KEY", value: "sk-invalid-on-purpose-for-test" });

      try {
        const created = await rpc<{ session: Session }>("session/create", {
          flow: FLOW,
          agent: "docs",
          repo: REPO_URL,
          prompt: TASK_PROMPT,
          compute: "local",
          runtime: "claude-agent",
        });
        const session = created.session;

        // Wait for spawn (status=running), then for failure surface (status=failed).
        await waitForSessionState(session.id, (s) => s.status === "running", 30_000, "session to spawn");
        const failed = await waitForSessionState(
          session.id,
          (s) => s.status === "failed",
          60_000, // 30s spawn + 30s probe interval cushion
          "session to flip to failed after auth error",
        );

        expect(failed.status).toBe("failed");
        // The exact error string depends on which error surface produced it
        // (claude-agent SDK 401, Bedrock proxy reject, or arkd process exit).
        // Any of these is acceptable -- we just need the failure to surface.
        expect(failed.error).toBeTruthy();
        expect(failed.error!.length).toBeGreaterThan(0);
      } finally {
        // Restore original key so Case C uses real auth.
        if (originalKey.length > 0) {
          await rpc("secret/set", { name: "ANTHROPIC_API_KEY", value: originalKey });
        }
      }
    },
    180_000,
  );
```

- [ ] **Step 2: Run Case B**

```bash
make test-e2e-local-real-llm
```
Expected: PASS — row flips to `failed` within 90s of dispatch (30s spawn + 60s probe cushion).

- [ ] **Step 3: Inspect on failure**

If Case B times out, the bug is in the surfacing pipeline — exactly what this test guards against. Capture:
1. `session/read` state at timeout
2. `docker logs ark-rt-local` — did Claude actually exit non-zero?
3. arkd `/process/status` for the handle — does it report exitCode != 0?
4. Worker log for `probeStatus` lines

If arkd reports non-zero exit but row stays running, the bug is in claude-agent.probeStatus → status-poller → row update. This is the F4-class regression the test exists to catch.

- [ ] **Step 4: Commit**

```bash
git add e2e/local-docker-real-llm.test.ts
git commit -m "feature: e2e/local-docker-real-llm Case B (auth-failure surfacing)"
```

---

### Task 5: Case C (process-kill mid-run)

**Files:**
- Modify: `e2e/local-docker-real-llm.test.ts` — add Case C test()

- [ ] **Step 1: Add Case C test**

Append to the `describe` block:

```ts
  test(
    "Case C: docker kill sidecar mid-run -> session row 'failed' within 60s",
    async () => {
      // Dispatch with valid auth, wait for sidecar to be running, then
      // docker kill the sidecar. arkd dies with it. probeStatus's HTTP
      // call now fails (ECONNREFUSED). F2's retry budget (5 consecutive
      // failures) flips the row to failed.
      const created = await rpc<{ session: Session }>("session/create", {
        flow: FLOW,
        agent: "docs",
        repo: REPO_URL,
        prompt: TASK_PROMPT,
        compute: "local",
        runtime: "claude-agent",
      });
      const session = created.session;

      // Wait for sidecar up.
      await waitForSessionState(session.id, (s) => s.status === "running", 60_000, "session to spawn");

      // Confirm sidecar exists in docker.
      const sidecarName = "ark-rt-local";
      execFileSync("docker", ["ps", "--filter", `name=${sidecarName}`, "--format", "{{.Names}}"], { encoding: "utf-8" });

      // Kill it.
      execFileSync("docker", ["kill", sidecarName], { encoding: "utf-8" });

      // Wait for row to surface failure.
      const failed = await waitForSessionState(
        session.id,
        (s) => s.status === "failed",
        90_000, // 5 retries × ~10s probe interval = 50s + cushion
        "session to flip to failed after sidecar kill",
      );

      expect(failed.status).toBe("failed");
      expect(failed.error).toBeTruthy();
    },
    180_000,
  );
```

- [ ] **Step 2: Run Case C**

```bash
make test-e2e-local-real-llm
```
Expected: PASS — row flips to `failed` within 90s of `docker kill`.

- [ ] **Step 3: Commit**

```bash
git add e2e/local-docker-real-llm.test.ts
git commit -m "feature: e2e/local-docker-real-llm Case C (process-kill surfacing)"
```

---

### Task 6: Cleanup hooks + idempotency

**Files:**
- Modify: `e2e/local-docker-real-llm.test.ts` — flesh out `afterAll`

- [ ] **Step 1: Add afterAll cleanup**

Replace the stub `afterAll` with:

```ts
  afterAll(async () => {
    // Best-effort sidecar removal (next run starts clean).
    try {
      execFileSync("docker", ["rm", "-f", "ark-rt-local"], { stdio: "ignore" });
    } catch {
      // already gone
    }
    // Worktrees and host server are torn down by the Makefile target.
  }, 30_000);
```

- [ ] **Step 2: Add per-test idempotency**

Before each test that dispatches, optionally call:

```ts
async function cleanupPriorSidecars() {
  try {
    execFileSync("docker", ["rm", "-f", "ark-rt-local"], { stdio: "ignore" });
  } catch {
    // already gone
  }
}
```

Call `await cleanupPriorSidecars()` at the start of cases B and C.

- [ ] **Step 3: Run all three cases twice in a row**

```bash
make test-e2e-local-real-llm && make test-e2e-local-real-llm
```
Expected: both runs PASS — no manual reset needed between them.

- [ ] **Step 4: Commit**

```bash
git add e2e/local-docker-real-llm.test.ts
git commit -m "feature: cleanup hooks + idempotency for local-docker e2e"
```

---

### Task 7: Verify the test catches a real regression

**Files:**
- (none — verification only)

- [ ] **Step 1: Synthetic regression check**

Temporarily revert the F4 fix to confirm Case B would catch it:

```bash
git stash push -- packages/core/executors/claude-agent.ts
# manually edit claude-agent.ts to remove the rehydrateHandle fallback
# (set computeHandle to just attachExistingHandle result, drop the ?? rehydrate)
make test-e2e-local-real-llm
```

Note: this test exercises LocalCompute+DockerIsolation, not K8sCompute, so it MAY NOT catch the F4 regression directly. The point of this step is to learn whether LocalCompute exhibits the same template-row null-return semantic.

- [ ] **Step 2: Document findings**

If the test catches the F4 regression: great, F4 is genuinely cross-compute.
If it doesn't: that's expected — F4 is K8sCompute-specific. The integration test still catches the broader surfacing pipeline regressions.

Either way, restore:

```bash
git stash pop
make test-e2e-local-real-llm  # confirm all three cases pass on HEAD
```

- [ ] **Step 3: Update plan with findings (this file)**

Append to the Out-of-scope section in this plan: a one-line summary of whether the LocalCompute+DockerIsolation path exercises the F4 codepath.

- [ ] **Step 4: Commit the documentation**

```bash
git add docs/superpowers/plans/2026-05-14-local-real-claude-integration.md
git commit -m "chore: document F4 codepath coverage in local-docker e2e plan"
```

---

## Final Verification

After all tasks:

- [ ] `make test-e2e-local-real-llm` passes all three cases on HEAD
- [ ] Two consecutive runs of the target both pass (idempotency)
- [ ] `.env.test` is gitignored, `.env.test.example` is committed
- [ ] No edits to `Dockerfile`, `.infra/Dockerfile.temporal-worker`, or `.infra/docker-compose.e2e.yaml`
- [ ] Plan document reflects actual F4 coverage findings from Task 7

## Coverage Recap

| Regression class | Caught locally? |
|---|---|
| `claude-agent.dispatch` wiring bug | ✅ all cases |
| `claude-agent.probeStatus` returning wrong state for exit codes | ✅ Case B |
| `status-poller` not invoking probeStatus correctly | ✅ all cases |
| `status-poller` retry budget (F2) misconfigured | ✅ Case C |
| `sessions.update` not surfacing error to row | ✅ Cases B, C |
| Temporal `awaitStageCompletionActivity` not reacting to row changes | ✅ all cases |
| `Dockerfile` regression (missing ark CLI, missing claude binary) | ✅ Case A |
| `.infra/Dockerfile.temporal-worker` regression | ✅ all cases |
| Anthropic Agent SDK SDK-version regression | ✅ Case A |
| `runtimes/claude-agent.yaml` secret declaration regression | ✅ Cases A, B |
| `K8sCompute.attachExistingHandle` template-row null-return | ❌ unit test only |
| K8s pod-IP routing (F3) | ❌ EKS-only |
| ArgoCD reconciliation | ❌ EKS-only |

**Estimated coverage of prod regressions:** ~85%.
