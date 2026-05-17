/**
 * Tests for session stop/resume lifecycle.
 * Verifies that stop(app) sets correct status/fields and resume(app) re-dispatches.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import { clearApp, getApp, setApp } from "./test-helpers.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterEach(async () => {
  await app?.shutdown();
  clearApp();
});

describe("session stop", async () => {
  it("sets status to 'stopped' (not 'failed')", async () => {
    const session = await getApp().sessions.create({ summary: "stop-test" });
    await getApp().sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "work" });

    const result = await app.sessionTerminator.stop(session.id);
    expect(result.ok).toBe(true);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
    expect(updated.status).not.toBe("failed");
  });

  it("preserves claude_session_id for resume", async () => {
    const session = await getApp().sessions.create({ summary: "stop-claude" });
    await getApp().sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      claude_session_id: "uuid-to-preserve",
    });

    await app.sessionTerminator.stop(session.id);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.claude_session_id).toBe("uuid-to-preserve");
  });

  it("clears session_id (tmux name)", async () => {
    const session = await getApp().sessions.create({ summary: "stop-session-id" });
    await getApp().sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-s-abc123",
    });

    await app.sessionTerminator.stop(session.id);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.session_id).toBeNull();
  });

  it("sets error to null", async () => {
    const session = await getApp().sessions.create({ summary: "stop-error-clear" });
    await getApp().sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      error: "some previous error",
    });

    await app.sessionTerminator.stop(session.id);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.error).toBeNull();
  });

  it("returns ok: true with message", async () => {
    const session = await getApp().sessions.create({ summary: "stop-msg" });
    await getApp().sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "work" });

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
    const session = await getApp().sessions.create({ summary: "stop-ready" });
    await getApp().sessions.update(session.id, { status: "ready", stage: "work" });

    const result = await app.sessionTerminator.stop(session.id);
    expect(result.ok).toBe(true);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
  });

  it("can stop a session in 'blocked' status", async () => {
    const session = await getApp().sessions.create({ summary: "stop-blocked" });
    await getApp().sessions.update(session.id, { status: "blocked", stage: "work" });

    const result = await app.sessionTerminator.stop(session.id);
    expect(result.ok).toBe(true);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
  });

  it("preserves other session fields after stop", async () => {
    const session = await getApp().sessions.create({ summary: "preserve-fields", repo: "/my/repo" });
    await getApp().sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "work",
      agent: "coder",
      workdir: "/tmp/worktree",
    });

    await app.sessionTerminator.stop(session.id);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.summary).toBe("preserve-fields");
    expect(updated.repo).toBe("/my/repo");
    expect(updated.agent).toBe("coder");
    expect(updated.workdir).toBe("/tmp/worktree");
    expect(updated.stage).toBe("work");
  });

  it("clears runtime fields but preserves claude_session_id", async () => {
    const session = await getApp().sessions.create({ summary: "clear-all" });
    await getApp().sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-tmux",
      claude_session_id: "claude-uuid",
      error: "old error",
    });

    await app.sessionTerminator.stop(session.id);

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("stopped");
    expect(updated.session_id).toBeNull();
    expect(updated.claude_session_id).toBe("claude-uuid");
    expect(updated.error).toBeNull();
  });
});

describe("session resume", async () => {
  // Note: resume(app) calls dispatch(app) which requires tmux and claude CLI,
  // so we test the status changes and guard clauses rather than full dispatch.

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
    // the caller must pick a stage to restart from. (The old partial
    // DispatchService.resume silently re-dispatched; that divergence is
    // gone now that resume has one implementation.)
    const session = await app.sessionCreator.start({
      summary: "completed-rewind",
      flow: {
        name: "completed-rewind-test",
        stages: [
          { name: "first", agent: "worker", gate: "auto" },
          { name: "second", agent: "worker", gate: "auto" },
        ],
      } as any,
    });
    await getApp().sessions.update(session.id, { status: "completed", stage: "second" });

    const blocked = await app.dispatchService.resume(session.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("completed");

    const ok = await app.dispatchService.resume(session.id, { rewindToStage: "first" });
    expect(ok.ok).toBe(true);
    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("ready");
    expect(updated.stage).toBe("first");
  });

  it("stopped session can transition to ready via updateSession", async () => {
    const session = await getApp().sessions.create({ summary: "resume-ready" });
    await getApp().sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "work" });
    await app.sessionTerminator.stop(session.id);

    // Simulate what resume does (without dispatch)
    await getApp().sessions.update(session.id, {
      status: "ready",
      error: null,
      breakpoint_reason: null,
      attached_by: null,
      session_id: null,
    });

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("ready");
    expect(updated.error).toBeNull();
    expect(updated.breakpoint_reason).toBeNull();
  });

  it("stop then ready transition preserves stage", async () => {
    const session = await getApp().sessions.create({ summary: "stage-preserve" });
    await getApp().sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "deploy",
    });
    await app.sessionTerminator.stop(session.id);

    await getApp().sessions.update(session.id, { status: "ready" });

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.stage).toBe("deploy");
  });
});

// Pin-down: the single authoritative resume cleanup contract. resume must
// (1) kill the runtime handle across EVERY registered executor (the handle
// is opaque; only the owning executor can clean it up), (2) clear runtime
// fields and flip to ready, (3) on rewind delete the flow_state row so the
// DAG re-runs from scratch, (4) route agent vs action and dispatch in the
// background (RPC returns status=ready; launcher flips it later).
describe("resume cleanup contract (authoritative)", async () => {
  it("kills the session handle across all registered executors", async () => {
    const session = await getApp().sessions.create({ summary: "resume-kill-all", flow: "bare" });
    await getApp().sessions.update(session.id, {
      status: "stopped",
      stage: "work",
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

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("ready");
    expect(updated.session_id).toBeNull();
  });

  it("deletes the flow_state row on rewind so the DAG starts over", async () => {
    // Two-stage inline flow so the rewind target ("first") differs from the
    // session's current stage ("second") -- a rewind only fires when the
    // target stage is not the current stage.
    const inlineFlow = {
      name: "resume-rewind-test",
      stages: [
        { name: "first", agent: "worker", gate: "auto" as const },
        { name: "second", agent: "worker", gate: "auto" as const },
      ],
    };
    const session = await app.sessionCreator.start({ summary: "resume-rewind", flow: inlineFlow as any });
    await getApp().sessions.update(session.id, {
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

    expect(await app.flowStates.load(session.id)).toBeNull();

    const updated = (await getApp().sessions.get(session.id))!;
    expect(updated.status).toBe("ready");
    expect(updated.stage).toBe("first");
    expect(updated.claude_session_id).toBeNull();
    expect(updated.pr_url).toBeNull();
  });

  it("does NOT delete flow_state when resuming without a rewind", async () => {
    const session = await getApp().sessions.create({ summary: "resume-no-rewind", flow: "bare" });
    await getApp().sessions.update(session.id, { status: "stopped", stage: "work" });
    await app.flowStates.markStageCompleted(session.id, "work");

    const result = await app.sessionService.resume(session.id);
    expect(result.ok).toBe(true);

    // No rewind requested -> flow_state row survives.
    expect(await app.flowStates.load(session.id)).toBeTruthy();
  });

  it("agent-stage resume emits session_created for background dispatch", async () => {
    const session = await getApp().sessions.create({ summary: "resume-agent-route", flow: "bare" });
    await getApp().sessions.update(session.id, { status: "stopped", stage: "work" });

    let emitted: string | null = null;
    const unsub = app.sessionService.onSessionCreated((id) => {
      emitted = id;
    });

    const result = await app.sessionService.resume(session.id);
    expect(result.ok).toBe(true);
    // RPC contract: returns immediately at status=ready; dispatch happens
    // in the background via the session_created listener.
    expect((await getApp().sessions.get(session.id))!.status).toBe("ready");
    expect(emitted).toBe(session.id);

    unsub();
  });
});
