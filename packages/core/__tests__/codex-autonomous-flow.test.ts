/**
 * Tests for Codex runtime working with the autonomous flow.
 *
 * Validates:
 * 1. cli-agent executor returns "not_found" when the tmux session is gone
 * 2. Status poller treats "not_found" (tmux exited) as stage-done by writing
 *    `ready` -- the signal awaitStageCompletionActivity consumes. Stage
 *    advancement / single-stage completion is the Temporal workflow's job
 *    (the bespoke poller->advance() path is deleted), so the poller stops at
 *    `ready` and never writes `completed` itself.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { AppContext } from "../app.js";
import { startStatusPoller, stopStatusPoller, stopAllPollers } from "../executors/status-poller.js";
import { cliAgentExecutor } from "../executors/cli-agent.js";
import * as tmux from "../infra/tmux.js";

// ── App fixture ──────────────────────────────────────────────────────────────

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  if (app) stopAllPollers(app);
  await app?.shutdown();
});

// ── Helper ────────────────────────────────────────────────────────────────────

function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 25000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      try {
        if (await fn()) return resolve();
      } catch (e) {
        return reject(e as Error);
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(check, 100);
    };
    check();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Codex runtime + autonomous flow", async () => {
  it("cli-agent executor returns not_found when tmux session is gone", async () => {
    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);
    try {
      const status = await cliAgentExecutor.status("ark-s-fake");
      expect(status.state).toBe("not_found");
    } finally {
      spy.mockRestore();
    }
  });

  it("status poller writes `ready` (stage-done signal) when tmux exits (not_found)", async () => {
    // Create a session on the autonomous flow
    const session = await app.sessions.create({ summary: "codex test", flow: "autonomous" });
    await app.sessions.update(session.id, { status: "running", stage: "work", session_id: "ark-" + session.id });

    // Mock: tmux session is already gone (Codex finished)
    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);

    try {
      // Start the status poller for cli-agent executor
      startStatusPoller(app, session.id, "ark-" + session.id, "cli-agent");

      // The poller detects not_found and writes `ready` -- the stage-done
      // signal awaitStageCompletionActivity consumes. It does NOT write
      // `completed` (that is the Temporal workflow's terminal projection).
      await waitFor(async () => {
        const s = await app.sessions.get(session.id);
        return s?.status === "ready";
      });

      const updated = await app.sessions.get(session.id);
      expect(updated?.status).toBe("ready");
    } finally {
      spy.mockRestore();
    }
  });

  it("status poller flips a running session off `running` on not_found (no failed)", async () => {
    const session = await app.sessions.create({ summary: "codex fail test", flow: "autonomous" });
    await app.sessions.update(session.id, { status: "running", stage: "work", session_id: "ark-" + session.id });

    // cli-agent only ever reports running or not_found -- never "failed".
    // not_found maps to the clean stage-done signal `ready`, not `failed`.
    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);

    try {
      startStatusPoller(app, session.id, "ark-" + session.id, "cli-agent");

      await waitFor(async () => {
        const s = await app.sessions.get(session.id);
        return s?.status !== "running";
      });

      const updated = await app.sessions.get(session.id);
      // not_found -> ready (clean exit), never failed.
      expect(updated?.status).toBe("ready");
    } finally {
      spy.mockRestore();
    }
  });
});
