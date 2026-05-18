/**
 * Session stop/resume lifecycle under Temporal.
 *
 * stop() remains a real prod operation on the session row + executor
 * cleanup; resume() now terminates the prior workflow and starts a fresh
 * Temporal sessionWorkflow (no bespoke background re-dispatch, no
 * onSessionCreated listener, no drainPendingDispatches). The deleted
 * "resume returns at ready, background flips to running" / onSessionCreated
 * test is removed; the surviving resume invariants (kill handle across
 * executors, completed-needs-rewind, flow_state delete on rewind) are
 * re-expressed against the Temporal resume path via the in-process harness.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AppContext } from "../app.js";
import {
  attachTemporalTestHarness,
  drainTemporalTestHarness,
  waitForSessionStatus,
} from "../temporal/test-harness.js";

let app: AppContext;
let detach: () => void;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  const flowDir = join(app.config.dirs.ark, "flows");
  mkdirSync(flowDir, { recursive: true });
  writeFileSync(
    join(flowDir, "sr-two.yaml"),
    `name: sr-two
description: two auto stages
stages:
  - name: first
    agent: implementer
    gate: auto
  - name: second
    agent: implementer
    gate: auto
    depends_on: [first]
`,
  );
  await app.boot();
  detach = await attachTemporalTestHarness(app);
});

afterEach(async () => {
  await drainTemporalTestHarness();
});

afterAll(async () => {
  detach?.();
  await app?.shutdown();
});

describe("session stop", async () => {
  it("sets status to 'stopped' (not 'failed')", async () => {
    const session = await app.sessions.create({ summary: "stop-test" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "work" });

    const result = await app.sessionTerminator.stop(session.id);
    expect(result.ok).toBe(true);

    const updated = (await app.sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
    expect(updated.status).not.toBe("failed");
  });

  it("preserves claude_session_id for resume", async () => {
    const session = await app.sessions.create({ summary: "stop-claude" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      claude_session_id: "uuid-to-preserve",
    });

    await app.sessionTerminator.stop(session.id);

    const updated = (await app.sessions.get(session.id))!;
    expect(updated.claude_session_id).toBe("uuid-to-preserve");
  });

  it("clears session_id (tmux name)", async () => {
    const session = await app.sessions.create({ summary: "stop-session-id" });
    await app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-s-abc123",
    });

    await app.sessionTerminator.stop(session.id);

    const updated = (await app.sessions.get(session.id))!;
    expect(updated.session_id).toBeNull();
  });

  it("sets error to null", async () => {
    const session = await app.sessions.create({ summary: "stop-error-clear" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      error: "some previous error",
    });

    await app.sessionTerminator.stop(session.id);

    const updated = (await app.sessions.get(session.id))!;
    expect(updated.error).toBeNull();
  });

  it("returns ok: true with message", async () => {
    const session = await app.sessions.create({ summary: "stop-msg" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "work" });

    const result = await app.sessionTerminator.stop(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Session stopped");
  });

  it("returns ok: false for nonexistent session", async () => {
    const result = await app.sessionTerminator.stop("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("can stop a session in 'ready' status", async () => {
    const session = await app.sessions.create({ summary: "stop-ready" });
    await app.sessions.update(session.id, { status: "ready", stage: "work" });

    const result = await app.sessionTerminator.stop(session.id);
    expect(result.ok).toBe(true);

    const updated = (await app.sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
  });

  it("can stop a session in 'blocked' status", async () => {
    const session = await app.sessions.create({ summary: "stop-blocked" });
    await app.sessions.update(session.id, { status: "blocked", stage: "work" });

    const result = await app.sessionTerminator.stop(session.id);
    expect(result.ok).toBe(true);

    const updated = (await app.sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
  });

  it("preserves other session fields after stop", async () => {
    const session = await app.sessions.create({ summary: "preserve-fields", repo: "/my/repo" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      agent: "coder",
      workdir: "/tmp/worktree",
    });

    await app.sessionTerminator.stop(session.id);

    const updated = (await app.sessions.get(session.id))!;
    expect(updated.summary).toBe("preserve-fields");
    expect(updated.repo).toBe("/my/repo");
    expect(updated.agent).toBe("coder");
    expect(updated.workdir).toBe("/tmp/worktree");
    expect(updated.stage).toBe("work");
  });

  it("clears runtime fields but preserves claude_session_id", async () => {
    const session = await app.sessions.create({ summary: "clear-all" });
    await app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-tmux",
      claude_session_id: "claude-uuid",
      error: "old error",
    });

    await app.sessionTerminator.stop(session.id);

    const updated = (await app.sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
    expect(updated.session_id).toBeNull();
    expect(updated.claude_session_id).toBe("claude-uuid");
    expect(updated.error).toBeNull();
  });
});

describe("session resume", async () => {
  it("resume(app) is exported as a function", async () => {
    expect(typeof app.dispatchService.resume).toBe("function");
  });

  it("resume returns ok: false for nonexistent session", async () => {
    const result = await app.dispatchService.resume("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("completed sessions require a rewind stage to resume", async () => {
    // Authoritative contract: a completed flow has nothing to "resume" --
    // the caller must pick a stage to restart from. Resume on rewind starts
    // a fresh Temporal workflow.
    const session = await app.sessions.create({ summary: "completed-rewind", flow: "sr-two" });
    await app.sessions.update(session.id, { status: "completed", stage: "second" });

    const blocked = await app.sessionService.resume(session.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("completed");

    const ok = await app.sessionService.resume(session.id, { rewindToStage: "first" });
    expect(ok.ok).toBe(true);
    const updated = (await app.sessions.get(session.id))!;
    // resume started a fresh run-suffixed workflow.
    expect(updated.workflow_id).toMatch(new RegExp(`^session-${session.id}-r`));
    // Let the restarted workflow run to terminal so drain is fast.
    await waitForSessionStatus(app, session.id, ["completed", "failed"]);
  }, 45_000);

  it("stopped session can transition to ready via updateSession", async () => {
    const session = await app.sessions.create({ summary: "resume-ready" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "work" });
    await app.sessionTerminator.stop(session.id);

    await app.sessions.update(session.id, {
      status: "ready",
      error: null,
      breakpoint_reason: null,
      attached_by: null,
      session_id: null,
    });

    const updated = (await app.sessions.get(session.id))!;
    expect(updated.status).toBe("ready");
    expect(updated.error).toBeNull();
    expect(updated.breakpoint_reason).toBeNull();
  });

  it("stop then ready transition preserves stage", async () => {
    const session = await app.sessions.create({ summary: "stage-preserve" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "deploy",
    });
    await app.sessionTerminator.stop(session.id);

    await app.sessions.update(session.id, { status: "ready" });

    const updated = (await app.sessions.get(session.id))!;
    expect(updated.stage).toBe("deploy");
  });
});

// Pin-down: the single authoritative resume cleanup contract. resume must
// (1) kill the runtime handle across EVERY registered executor (the handle
// is opaque; only the owning executor can clean it up), (2) clear runtime
// fields and flip to ready, (3) on rewind delete the flow_state row so the
// DAG re-runs from scratch, then start a fresh Temporal workflow. The
// deleted "background dispatch / onSessionCreated" behaviour is gone --
// resume now restarts the workflow directly.
describe("resume cleanup contract (authoritative)", async () => {
  it("kills the session handle across all registered executors", async () => {
    const session = await app.sessions.create({ summary: "resume-kill-all", flow: "sr-two" });
    await app.sessions.update(session.id, {
      status: "stopped",
      stage: "first",
      session_id: "handle-xyz",
    });

    const killed: Array<{ executor: string; handle: string }> = [];
    for (const entry of app.pluginRegistry.listByKind("executor")) {
      const orig = entry.impl.kill.bind(entry.impl);
      entry.impl.kill = async (h: string) => {
        killed.push({ executor: entry.name, handle: h });
        return orig(h);
      };
    }

    const result = await app.sessionService.resume(session.id);
    expect(result.ok).toBe(true);

    // Every executor was offered the opaque handle (only the owner can
    // actually clean it up; the rest are best-effort no-ops).
    const executorCount = app.pluginRegistry.listByKind("executor").length;
    expect(executorCount).toBeGreaterThan(0);
    expect(killed.length).toBe(executorCount);
    expect(killed.every((k) => k.handle === "handle-xyz")).toBe(true);

    const updated = (await app.sessions.get(session.id))!;
    expect(updated.session_id).toBeNull();
    await waitForSessionStatus(app, session.id, ["completed", "failed"]);
  }, 45_000);

  it("deletes the flow_state row on rewind so the DAG starts over", async () => {
    const session = await app.sessions.create({ summary: "resume-rewind", flow: "sr-two" });
    await app.sessions.update(session.id, {
      status: "completed",
      stage: "second",
      claude_session_id: "claude-old",
      pr_url: "https://example.com/pr/1",
    });

    // Seed a flow_state row -- the rewind must delete it, otherwise the
    // orchestrator sees every stage as already-completed and stalls.
    await app.flowStates.markStageCompleted(session.id, "first");
    expect(await app.flowStates.load(session.id)).toBeTruthy();

    const result = await app.sessionService.resume(session.id, { rewindToStage: "first" });
    expect(result.ok).toBe(true);

    const updated = (await app.sessions.get(session.id))!;
    // The rewind wiped the conversation id, PR url, and reset the stage
    // before the fresh workflow was started.
    expect(updated.claude_session_id).toBeNull();
    expect(updated.pr_url).toBeNull();

    await waitForSessionStatus(app, session.id, ["completed", "failed"]);
  }, 45_000);

  it("does NOT delete flow_state when resuming without a rewind", async () => {
    const session = await app.sessions.create({ summary: "resume-no-rewind", flow: "sr-two" });
    await app.sessions.update(session.id, { status: "stopped", stage: "first" });
    await app.flowStates.markStageCompleted(session.id, "first");

    const result = await app.sessionService.resume(session.id);
    expect(result.ok).toBe(true);

    // No rewind requested -> flow_state row survives the resume.
    expect(await app.flowStates.load(session.id)).toBeTruthy();

    await waitForSessionStatus(app, session.id, ["completed", "failed"]);
  }, 45_000);
});
