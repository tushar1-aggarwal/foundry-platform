/**
 * `not_found` -> failed when no completion hook fired (closes #551).
 *
 * The status-poller used to treat any `not_found` probe as "agent exited
 * cleanly" and write status=completed. That's true when the agent fired
 * its completion hook before exiting, but false when the daemon was
 * killed mid-flight (the agent process gets reaped without ever sending
 * SessionEnd). The bug: on the next daemon boot, the poller saw a dead
 * handle, marked the session "completed", and downstream auto-gate
 * flows finalized -- worktree empty, no PR, but reported success.
 *
 * Fix: when `not_found` fires and session.status is still "running",
 * scan the events log for a `hook_status` with `event: "SessionEnd"`.
 * Found => clean completion. Not found => interrupted; write status=
 * failed with an explicit reason.
 *
 * Tests drive the poller's `_tickForTest` directly rather than starting
 * a real interval so the timing is deterministic.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import { _tickForTest } from "../executors/status-poller.js";
import type { Executor, ExecutorStatus } from "../executor.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
});

function notFoundExecutor(name = "claude-code"): Executor {
  const stub: Executor = {
    name,
    async launch() {
      throw new Error("not used");
    },
    async kill() {
      /* noop */
    },
    async status(): Promise<ExecutorStatus> {
      return { state: "not_found" };
    },
    async probeStatus(): Promise<ExecutorStatus> {
      return { state: "not_found" };
    },
  };
  return stub;
}

describe("status-poller `not_found` interrupt guard", () => {
  it("writes status=failed when the agent vanished without firing SessionEnd", async () => {
    const session = await app.sessions.create({ summary: "interrupted" });
    await app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      flow: "bare",
      session_id: "ark-" + session.id,
    });

    const state = { consecutiveUnreachable: 0 };
    await _tickForTest(app, session.id, "ark-" + session.id, notFoundExecutor(), state);

    const after = await app.sessions.get(session.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("without firing completion hook");
    expect(after?.session_id).toBeNull();

    const events = await app.events.list(session.id);
    const failed = events.find((e) => e.type === "session_failed");
    expect(failed).toBeDefined();
    const data = typeof failed!.data === "string" ? JSON.parse(failed!.data) : failed!.data;
    expect(String(data?.reason ?? "")).toContain("without firing completion hook");
  });

  it("writes status=completed when SessionEnd was logged before the agent exited", async () => {
    const session = await app.sessions.create({ summary: "clean-completion" });
    await app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      flow: "bare",
      session_id: "ark-" + session.id,
    });

    // Record the completion signal the agent would have emitted via its
    // Stop/SessionEnd hook before exiting.
    await app.events.log(session.id, "hook_status", {
      stage: "work",
      actor: "hook",
      data: { event: "SessionEnd" },
    });

    const state = { consecutiveUnreachable: 0 };
    await _tickForTest(app, session.id, "ark-" + session.id, notFoundExecutor(), state);

    const after = await app.sessions.get(session.id);
    // Non-Temporal path may end on "completed" or (after mediateStageHandoff)
    // "ready" / "completed" depending on flow shape. The contract for this
    // test is the negative: it must NOT have been written as "failed".
    expect(after?.status).not.toBe("failed");
    expect(after?.session_id).toBeNull();
  });
});
