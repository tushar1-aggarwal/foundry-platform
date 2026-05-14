/**
 * Local real-Claude integration (T1-T5 surfacing pipeline).
 *
 * Verifies the dispatch -> spawn -> probeStatus -> row-update -> workflow
 * chain end-to-end using prod-shape images, real Claude Agent SDK, real
 * Temporal, and real arkd. Excludes K8sCompute-specific behaviour (those
 * codepaths are unit-tested at
 * packages/core/__tests__/claude-agent-probe-status.test.ts).
 *
 * Gated by ARK_REAL_LLM_E2E=1 because it consumes real LLM tokens. Run via:
 *   make test-e2e-local-real-llm
 *
 * The "docs" flow dispatches against the `documenter` agent which uses
 * runtime: claude-agent (agents/documenter.yaml:3). That is the prod
 * runtime the F4 bug surfaced in -- so this test exercises the same
 * runtime codepath as prod, just with LocalCompute+DockerIsolation
 * instead of K8sCompute.
 *
 * Three cases:
 *   A. Happy path -- real Claude completes prompt, session row reaches
 *      "completed", workflow Completed.
 *   B. Auth-failure surfacing -- override ANTHROPIC_API_KEY=sk-invalid
 *      via secret/set, dispatch, real Claude Agent SDK hits 401, process
 *      exits non-zero, row flips to "failed" within ~90s.
 *   C. Process-kill mid-run -- after dispatch + sidecar up, docker kill
 *      ark-rt-local. arkd dies, probeStatus HTTP fails. F2 retry budget
 *      kicks in, row flips to "failed" within ~90s.
 *
 * Pre-flight (run by the Makefile target before this test):
 *   - .env.test populated from prod secrets
 *   - make test-e2e-control-plane-up has booted the compose stack
 *   - ark:latest built from current source via build-ark-image
 *   - Host ark server on :8422 + host Temporal worker registered on :7234
 *   - compute=local + isolation=docker seeded with image=ark:latest
 *   - Compose temporal-worker stopped so it doesn't shadow with fake-claude
 *   - ANTHROPIC_* + CLAUDE_CODE_OAUTH_TOKEN secrets seeded into tenant store
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";

const ENABLED = process.env.ARK_REAL_LLM_E2E === "1";
const WEB_URL = process.env.T6_WEB_URL ?? "http://localhost:8422";
const ARKD_URL = process.env.T6_ARKD_URL ?? "http://localhost:19302";
const TASK_SUMMARY = process.env.ARK_TEST_PROMPT ?? "Add one paragraph to architecture.md describing the repo layout";
const TARGET_REPO = process.env.T6_REPO_URL ?? "git@bitbucket.org:paytmteam/foundry-test-repo.git";
const SIDECAR_NAME = "ark-rt-local";

interface RpcOk<T> {
  result: T;
}
interface RpcErr {
  error: { message: string; code: number };
}

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
  orchestrator: string | null;
}

async function readSession(sessionId: string): Promise<Session> {
  const { session } = await rpc<{ session: Session }>("session/read", { sessionId });
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
  let lastStage = last.stage ?? "";
  let lastStatus = last.status;
  // Log initial state so the operator sees activity at t=0.
  console.log(`  · t=0s  stage=${last.stage}  status=${last.status}`);
  while (!pred(last)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timeout waiting for ${label}. Last state: status=${last.status} stage=${last.stage} error=${last.error}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1500));
    last = await readSession(id);
    // Print on any state transition so 10-min waits aren't silent.
    if ((last.stage ?? "") !== lastStage || last.status !== lastStatus) {
      const ts = Math.round((Date.now() - start) / 1000);
      const errSnip = last.error ? `  err=${last.error.slice(0, 80)}` : "";
      console.log(`  · t=${ts}s  stage=${last.stage}  status=${last.status}${errSnip}`);
      lastStage = last.stage ?? "";
      lastStatus = last.status;
    }
  }
  return last;
}

async function probe(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

function safeDockerRm(name: string): void {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {
    // already gone
  }
}

async function setSecret(name: string, value: string): Promise<void> {
  await rpc("secret/set", { name, value, type: "env-var" });
}

async function startDocsSession(): Promise<Session> {
  const { session } = await rpc<{ session: Session }>("session/start", {
    flow: "docs",
    summary: TASK_SUMMARY,
    repo: TARGET_REPO,
    compute_name: "local",
  });
  return session;
}

describe.skipIf(!ENABLED)("local-docker real-Claude integration", () => {
  beforeAll(async () => {
    // Pre-flight: server, arkd, compute=local present, ANTHROPIC_API_KEY
    // populated. Empty key would silently 10-min-timeout in Case A.
    expect(await probe(`${WEB_URL}/api/health`)).toBe(true);
    expect(await probe(`${ARKD_URL}/health`)).toBe(true);
    const { targets } = await rpc<{ targets: Array<{ name: string }> }>("compute/list", {});
    expect((targets ?? []).some((c) => c.name === "local")).toBe(true);
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    if (apiKey.length === 0) {
      throw new Error(
        "ANTHROPIC_API_KEY is empty. Populate .env.test from prod K8s secret ark-secrets " +
          "before running this test.",
      );
    }
  }, 60_000);

  afterAll(async () => {
    // Stop any leftover sidecar so the next run starts clean. Host ark
    // server + temporal worker are torn down by the Makefile trap.
    safeDockerRm(SIDECAR_NAME);
  }, 30_000);

  test(
    "Case A: real Claude completes prompt -> session row 'completed'",
    async () => {
      safeDockerRm(SIDECAR_NAME);
      const created = await startDocsSession();
      console.log(`\n  >> Case A session ${created.id}  workflow=${created.workflow_id}`);
      expect(created.id).toMatch(/^s-/);
      expect(created.orchestrator).toBe("temporal");
      expect(created.workflow_id).toMatch(/^session-/);

      // 10 min budget for two LLM stages (plan + implement) on a tiny prompt.
      const final = await waitForSessionState(
        created.id,
        (s) => ["completed", "failed", "stopped"].includes(s.status),
        10 * 60_000,
        "session to reach terminal state",
      );

      if (final.status !== "completed") {
        throw new Error(
          `Expected completed, got status=${final.status} stage=${final.stage} error=${final.error}`,
        );
      }
      expect(final.status).toBe("completed");
    },
    720_000,
  );

  test(
    "Case B: invalid ANTHROPIC_API_KEY -> session row 'failed' after spawn",
    async () => {
      safeDockerRm(SIDECAR_NAME);
      // Snapshot current key so we can restore (Case C needs valid auth).
      const originalKey = process.env.ANTHROPIC_API_KEY ?? "";
      await setSecret("ANTHROPIC_API_KEY", "sk-invalid-on-purpose-for-test");

      try {
        const created = await startDocsSession();
        console.log(`\n  >> Case B session ${created.id} (invalid key seeded)`);

        // Wait for failure surface. Sidecar spawn takes ~10-30s, then SDK
        // hits the auth wall and exits non-zero; probeStatus must observe
        // the non-zero exit and write status=failed within the next poll
        // interval. Budget generously to absorb spawn variance.
        const failed = await waitForSessionState(
          created.id,
          (s) => s.status === "failed",
          180_000,
          "session to flip to failed after auth error",
        );

        expect(failed.status).toBe("failed");
        // The exact error string depends on which error surface produced it
        // (SDK 401, Bedrock proxy reject, or arkd process exit). All of
        // these are valid -- we just need the failure to surface to the row.
        expect(failed.error).toBeTruthy();
        expect((failed.error ?? "").length).toBeGreaterThan(0);
      } finally {
        if (originalKey.length > 0) {
          await setSecret("ANTHROPIC_API_KEY", originalKey);
        }
      }
    },
    240_000,
  );

  test(
    "Case C: docker kill sidecar mid-run -> session row 'failed'",
    async () => {
      safeDockerRm(SIDECAR_NAME);
      const created = await startDocsSession();
      console.log(`\n  >> Case C session ${created.id} (will docker-kill mid-run)`);

      // Wait for the sidecar to be up before killing it. Status goes
      // running once dispatch hands off to claude-agent; that's when the
      // sidecar container has been created and arkd has spawned the agent
      // PID.
      await waitForSessionState(
        created.id,
        (s) => s.status === "running",
        120_000,
        "session to spawn into running",
      );

      // Confirm sidecar is up before we kill it. A name mismatch here
      // means LocalCompute renamed the container -- update SIDECAR_NAME.
      const ps = execFileSync("docker", ["ps", "--filter", `name=${SIDECAR_NAME}`, "--format", "{{.Names}}"], {
        encoding: "utf-8",
      });
      expect(ps.trim()).toBe(SIDECAR_NAME);

      // Hard-kill the sidecar. arkd inside dies with it. probeStatus's
      // next HTTP call to arkd /process/status will fail (ECONNREFUSED).
      // F2's retry budget (5 consecutive failures) flips the row to failed.
      execFileSync("docker", ["kill", SIDECAR_NAME], { encoding: "utf-8" });

      const failed = await waitForSessionState(
        created.id,
        (s) => s.status === "failed",
        180_000,
        "session to flip to failed after sidecar kill",
      );

      expect(failed.status).toBe("failed");
      expect(failed.error).toBeTruthy();
    },
    300_000,
  );
});
