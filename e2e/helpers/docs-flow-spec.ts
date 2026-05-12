/**
 * Shared test bodies for the docs-flow e2e tests. Mode-agnostic: drives the
 * server entirely via the HTTP RPC client, so both local and hosted modes
 * call the same assertions.
 *
 * See docs/superpowers/specs/2026-05-12-docs-flow-e2e-design.md for the full
 * spec including assertion rationale.
 */

import { expect } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { RpcClient, waitFor } from "./rpc-client.js";

export interface CompoundSpecOpts {
  rpc: RpcClient;
  repoUrl: string;          // git URL Ark clones (e.g., http://localhost:54321/repo.git)
  bareRepoPath: string;     // path of the bare repo on disk (for post-push verification)
  arkDir: string;           // ark data dir (for inspecting agent-env logs + workdir)
  expectedToken: string;    // seeded BITBUCKET_ACCESS_TOKEN
  isHosted: boolean;        // hosted → assert orchestrator=temporal + workflow_id
}

interface SessionRead {
  session: {
    id: string;
    flow: string | null;
    stage: string | null;
    status: string;
    workdir: string | null;
    branch: string | null;
    pr_url: string | null;
    error: string | null;
    orchestrator?: string | null;
    workflow_id?: string | null;
  };
  events?: Array<{ type: string; data?: Record<string, unknown>; stage?: string | null }>;
}

/**
 * Compound test body: happy path + manual review gate + stop/resume.
 *
 * Maps to spec Test 1: covers user-spec scenarios a (happy path), c (manual
 * gate approval), d (stop + resume at gate).
 */
export async function compoundDocsFlowSpec(opts: CompoundSpecOpts): Promise<void> {
  const { rpc, repoUrl, bareRepoPath, arkDir, expectedToken, isHosted } = opts;

  // ── 1. Seed BITBUCKET_ACCESS_TOKEN secret ─────────────────────────────
  await rpc.call("secret/set", {
    tenant: "default",
    name: "BITBUCKET_ACCESS_TOKEN",
    value: expectedToken,
    type: "env-var",
  });

  // ── 2. session/start ──────────────────────────────────────────────────
  const startResp = await rpc.call<{ session: SessionRead["session"] }>("session/start", {
    flow: "e2e-docs-review",
    summary: "docs-flow e2e: compound test",
    repo: repoUrl,
  });
  expect(startResp.session.id).toMatch(/^s-/);
  expect(startResp.session.flow).toBe("e2e-docs-review");
  expect(["ready", "running"]).toContain(startResp.session.status);

  if (isHosted) {
    expect(startResp.session.orchestrator).toBe("temporal");
    expect(startResp.session.workflow_id).toMatch(/^session-/);
  }

  const sessionId = startResp.session.id;

  // ── 3. Poll until parked at review_gate ───────────────────────────────
  const parked = await waitFor<SessionRead>(
    () => rpc.call<SessionRead>("session/read", { sessionId, include: ["events"] }),
    (v) => v.session.status === "ready" && v.session.stage === "review",
    { timeoutMs: 30_000, description: `session ${sessionId} parked at review` },
  );

  // ── 4. Assert workspace prepare + clone ran ───────────────────────────
  const workdir = parked.session.workdir;
  if (!workdir) throw new Error("expected session.workdir to be populated after plan");
  expect(existsSync(join(workdir, ".git"))).toBe(true);

  const cloneLog = execFileSync("git", ["-C", workdir, "log", "--oneline"]).toString();
  expect(cloneLog).toContain("initial");   // the seeded commit

  // ── 5. Assert implement stage commit landed ───────────────────────────
  const notes = readFileSync(join(workdir, "NOTES.md"), "utf-8");
  expect(notes).toContain("stub commit at");

  // ── 6. Assert no dispatch_failed leak (regression guard) ──────────────
  const dispatchFailures = (parked.events ?? []).filter((e) => e.type === "dispatch_failed");
  if (dispatchFailures.length > 0) {
    throw new Error(`unexpected dispatch_failed events: ${JSON.stringify(dispatchFailures)}`);
  }

  // ── 7. Stop + resume at the gate ──────────────────────────────────────
  await rpc.call("session/stop", { sessionId });
  await waitFor<SessionRead>(
    () => rpc.call<SessionRead>("session/read", { sessionId }),
    (v) => v.session.status === "stopped",
    { timeoutMs: 10_000, description: "session reaches stopped" },
  );

  await rpc.call("session/resume", { sessionId });
  await waitFor<SessionRead>(
    () => rpc.call<SessionRead>("session/read", { sessionId }),
    (v) => v.session.status === "ready" && v.session.stage === "review",
    { timeoutMs: 10_000, description: "session resumes parked at review" },
  );

  // ── 8. Approve the gate ───────────────────────────────────────────────
  await rpc.call("gate/approve", { sessionId, decision: "approve" });

  // ── 9. Poll until completed ───────────────────────────────────────────
  const final = await waitFor<SessionRead>(
    () => rpc.call<SessionRead>("session/read", { sessionId, include: ["events"] }),
    (v) => ["completed", "failed", "stopped"].includes(v.session.status),
    { timeoutMs: 30_000, description: "session reaches terminal status" },
  );

  // ── 10. Final state assertions ────────────────────────────────────────
  if (final.session.status !== "completed") {
    throw new Error(`expected completed, got ${final.session.status} (stage=${final.session.stage}, error=${final.session.error})`);
  }
  expect(final.session.error).toBeNull();
  expect(final.session.pr_url).toBeTruthy();
  expect(final.session.stage).toBe("pr");

  // ── 11. Verify push reached the bare repo ─────────────────────────────
  const branch = final.session.branch;
  if (!branch) throw new Error("expected session.branch to be set after push");
  const bareLog = execFileSync("git", ["--git-dir", bareRepoPath, "log", branch, "--oneline"]).toString();
  expect(bareLog).toContain("stub-implementer");

  // ── 12. Assert create_pr action ran the real path (not short-circuit) ─
  const createPrEvents = (final.events ?? []).filter(
    (e) => e.type === "action_executed" && (e.data as { action?: string } | undefined)?.action === "create_pr",
  );
  if (createPrEvents.length === 0) {
    throw new Error(`expected at least one action_executed event for create_pr; got events: ${JSON.stringify(final.events?.map(e => e.type))}`);
  }
  for (const e of createPrEvents) {
    const data = e.data as { skipped?: string } | undefined;
    if (data?.skipped === "pr_already_exists") {
      throw new Error("create_pr was short-circuited via pr_already_exists; the real push path must run");
    }
  }

  // ── 13. Verify credential resolution log (debug aid) ──────────────────
  const envLogPath = join(arkDir, "agent-envs", "plan.log");
  if (existsSync(envLogPath)) {
    const env = readFileSync(envLogPath, "utf-8");
    if (!env.includes(expectedToken)) {
      console.warn(`agent-env log did not contain the expected token; verify it was a hidden var`);
    }
  }
}

/**
 * Restart-then-fail test body. Spec Test 2: covers scenarios b (failure path)
 * and g (server restart durability) by killing the server mid-flow and
 * verifying the resumed session surfaces the agent's AuthError.
 *
 * The caller is responsible for the kill+restart cycle (different boot paths
 * between local + hosted), so this body receives a `restart` callback.
 */
export async function restartThenFailSpec(opts: CompoundSpecOpts & {
  /** Kill the running server subprocess. */
  killServer: () => Promise<void>;
  /** Restart the server with same arkDir + same env (including FAIL flag). */
  restartServer: () => Promise<void>;
}): Promise<void> {
  const { rpc, repoUrl, isHosted, expectedToken } = opts;
  console.error("[probe] restartThenFailSpec: entered");

  await rpc.call("secret/set", {
    tenant: "default",
    name: "BITBUCKET_ACCESS_TOKEN",
    value: expectedToken,
    type: "env-var",
  });
  console.error("[probe] secret/set ok");

  const startResp = await rpc.call<{ session: SessionRead["session"] }>("session/start", {
    flow: "e2e-docs-review",
    summary: "docs-flow e2e: restart-then-fail",
    repo: repoUrl,
  });
  console.error(`[probe] session/start ok: id=${startResp.session.id} status=${startResp.session.status} stage=${startResp.session.stage}`);
  expect(startResp.session.id).toMatch(/^s-/);
  if (isHosted) {
    expect(startResp.session.orchestrator).toBe("temporal");
    expect(startResp.session.workflow_id).toMatch(/^session-/);
  }
  const sessionId = startResp.session.id;
  const initialWorkflowId = startResp.session.workflow_id;

  // Wait until plan finishes (stage advances to implement)
  await waitFor<SessionRead>(
    () => rpc.call<SessionRead>("session/read", { sessionId }),
    (v) => v.session.stage === "implement",
    { timeoutMs: 20_000, description: "plan completes, stage advances to implement" },
  );
  console.error("[probe] plan->implement transition ok");

  // Kill the server.
  await opts.killServer();
  console.error("[probe] killServer ok");

  // Restart with same env (FAIL flag still set).
  await opts.restartServer();
  console.error("[probe] restartServer ok");

  // For hosted: workflow_id must be unchanged (workflow continues, not a new one).
  if (isHosted) {
    const afterRestart = await rpc.call<SessionRead>("session/read", { sessionId });
    expect(afterRestart.session.workflow_id).toBe(initialWorkflowId);
  }

  // Poll until terminal.
  const final = await waitFor<SessionRead>(
    () => rpc.call<SessionRead>("session/read", { sessionId, include: ["events"] }),
    (v) => ["completed", "failed", "stopped"].includes(v.session.status),
    { timeoutMs: 60_000, description: "session reaches terminal status after restart" },
  );

  // Final state: failed with AuthError, no pr_url, no cold-cache leak.
  expect(final.session.status).toBe("failed");
  expect(final.session.pr_url).toBeNull();
  expect(final.session.stage).toBe("implement");
  expect(final.session.error ?? "").toMatch(/AuthError|401|Unauthorized/);

  // Regression guard: failure must NOT be the cold-cache leak.
  const events = final.events ?? [];
  for (const e of events) {
    const data = e.data as { reason?: string; message?: string } | undefined;
    const haystack = `${data?.reason ?? ""} ${data?.message ?? ""}`;
    if (/No runtime resolvable/.test(haystack)) {
      throw new Error(`unexpected cold-cache leak event: ${JSON.stringify(e)}`);
    }
  }
}
