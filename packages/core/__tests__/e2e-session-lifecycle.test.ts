/**
 * End-to-end tests for the core session lifecycle under Temporal.
 *
 * Temporal is the sole orchestrator: `sessionService.start` creates the row
 * AND starts the real sessionWorkflow (driven in-process by the test
 * harness). The bespoke synchronous `dispatch()->status:running`,
 * `getOutput` tmux semantics, "rejects dispatch on non-ready", and the
 * "resume returns at ready, background flips to running" contracts are
 * deleted; the lifecycle is now: start -> workflow drives stages ->
 * terminal status. Stop/delete remain real prod operations.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from "bun:test";
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
const sessionIds: string[] = [];

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  const flowDir = join(app.config.dirs.ark, "flows");
  mkdirSync(flowDir, { recursive: true });
  // `bare` is gate:manual and never self-terminates; a single auto stage is
  // the deterministic self-terminating flow the harness can drive.
  writeFileSync(
    join(flowDir, "lc-auto.yaml"),
    `name: lc-auto
description: single auto stage
stages:
  - name: work
    agent: implementer
    gate: auto
`,
  );
  await app.boot();
  detach = await attachTemporalTestHarness(app);
});

afterEach(async () => {
  await drainTemporalTestHarness();
  for (const id of sessionIds) {
    try {
      await app.sessions.delete(id);
    } catch {
      /* already gone */
    }
  }
  sessionIds.length = 0;
});

afterAll(async () => {
  detach?.();
  await app?.shutdown();
});

// ── startSession ───────────────────────────────────────────────────────────

describe("core lifecycle: startSession", async () => {
  it("returns a valid session with correct defaults and is workflow-stamped", async () => {
    const session = await app.sessionService.start({
      repo: process.cwd(),
      summary: "lifecycle-start-test",
      flow: "lc-auto",
    });
    sessionIds.push(session.id);

    expect(session.id).toMatch(/^s-[0-9a-z]+$/);
    expect(session.flow).toBe("lc-auto");
    expect(session.repo).toBe(process.cwd());
    expect(session.summary).toBe("lifecycle-start-test");
    // SessionService.start stamps workflow_id/run_id from the starter.
    expect(session.workflow_id).toBe(`session-${session.id}`);
    expect(session.workflow_run_id).toBe(`run-${session.id}`);
  });

  it("logs a session_created event on creation and stage_completed on advance", async () => {
    const session = await app.sessionService.start({
      repo: process.cwd(),
      summary: "lifecycle-event-test",
      flow: "lc-auto",
    });
    sessionIds.push(session.id);

    const ready = await waitForSessionStatus(app, session.id, ["completed", "failed"]);
    expect(ready.status).toBe("completed");
    const types = (await app.events.list(session.id)).map((e) => e.type);
    // `stage_ready` was a bespoke-pump event; the Temporal path projects
    // `session_created` at creation, `stage_started` per stage, and
    // `session_completed` at the terminal projection.
    expect(types).toContain("session_created");
    expect(types).toContain("stage_started");
    expect(types).toContain("session_completed");
  });
});

// ── dispatch (nonexistent guard still valid) ───────────────────────────────

describe("core lifecycle: dispatch guard", async () => {
  it("returns error for nonexistent session", async () => {
    const result = await app.dispatchService.dispatch("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });
});

// ── stop ───────────────────────────────────────────────────────────────────

describe("core lifecycle: stop", async () => {
  it("a started session can be stopped to a terminal stopped state", async () => {
    const session = await app.sessionService.start({
      repo: process.cwd(),
      summary: "lifecycle-stop-test",
      flow: "lc-auto",
    });
    sessionIds.push(session.id);

    const result = await app.sessionService.stop(session.id);
    expect(result.ok).toBe(true);

    const stopped = await app.sessions.get(session.id);
    expect(["stopped", "completed"]).toContain(stopped!.status);
  }, 30_000);
});

// ── complete (workflow drives to completed) ────────────────────────────────

describe("core lifecycle: complete", async () => {
  it("the workflow advances the single-stage flow to completed", async () => {
    const session = await app.sessionService.start({
      repo: process.cwd(),
      summary: "lifecycle-complete-test",
      flow: "lc-auto",
    });
    sessionIds.push(session.id);

    const completed = await waitForSessionStatus(app, session.id, ["completed"]);
    expect(completed.status).toBe("completed");

    const events = await app.events.list(session.id);
    expect(events.map((e) => e.type)).toContain("session_completed");
  }, 30_000);
});

// ── deleteSession ──────────────────────────────────────────────────────────

describe("core lifecycle: deleteSession", async () => {
  it("removes session and its events from the database", async () => {
    const session = await app.sessionService.start({
      repo: process.cwd(),
      summary: "lifecycle-delete-test",
      flow: "lc-auto",
    });
    await waitForSessionStatus(app, session.id, ["completed", "failed"]);

    expect(await app.sessions.get(session.id)).not.toBeNull();
    expect((await app.events.list(session.id)).length).toBeGreaterThan(0);

    const deleted = await app.sessions.delete(session.id);
    expect(deleted).toBe(true);

    expect(await app.sessions.get(session.id)).toBeNull();
    expect((await app.events.list(session.id)).length).toBe(0);
  }, 30_000);

  it("returns false for nonexistent session", async () => {
    const deleted = await app.sessions.delete("s-nonexistent");
    expect(deleted).toBe(false);
  });
});

// ── Full round-trip (Temporal lifecycle) ───────────────────────────────────

describe("core lifecycle: full round-trip", async () => {
  it("start -> workflow drives to completed -> delete", async () => {
    const session = await app.sessionService.start({
      repo: process.cwd(),
      summary: "lifecycle-roundtrip",
      flow: "lc-auto",
    });

    const final = await waitForSessionStatus(app, session.id, ["completed"]);
    expect(final.status).toBe("completed");

    const deleted = await app.sessions.delete(session.id);
    expect(deleted).toBe(true);
    expect(await app.sessions.get(session.id)).toBeNull();
  }, 45_000);
});
