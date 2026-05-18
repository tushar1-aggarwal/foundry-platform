/**
 * Action stage chaining under Temporal.
 *
 * Original intent: consecutive action stages must chain-execute and the flow
 * must advance after each action succeeds (or fail loudly on error) -- never
 * sit stuck at `ready`. The bespoke `mediateStageHandoff()` recursive
 * re-dispatch path is deleted; the surviving concern is re-expressed against
 * the real Temporal sessionWorkflow + executeActionActivity loop. We start a
 * YAML flow whose stages are actions (chained / mixed with an agent stage)
 * and assert the workflow drives every stage to a terminal state, emitting
 * the expected `action_executed` events.
 *
 * `close` is the bundled no-network success action. `create_pr` / `auto_merge`
 * fail without a worktree/PR, which exercises the chain-stops-on-failure path.
 *
 * Deleted tests (asserted the removed bespoke contract, no Temporal
 * equivalent at this layer):
 *  - the direct `app.sessionHooks.mediateStageHandoff(...)` driver calls --
 *    the method no longer exists; stage handoff is owned by the workflow.
 */

import { afterAll, beforeAll, afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AppContext } from "../app.js";
import { executeAction } from "../services/actions/index.js";
import { depsFromApp } from "../services/deps.js";
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

  // agent -> action:close (last stage)
  writeFileSync(
    join(flowDir, "asc-single.yaml"),
    `name: asc-single
stages:
  - name: work
    agent: implementer
    gate: auto
  - name: finish
    action: close
    gate: auto
    depends_on: [work]
`,
  );

  // agent -> action:close -> action:close (two consecutive actions)
  writeFileSync(
    join(flowDir, "asc-chain.yaml"),
    `name: asc-chain
stages:
  - name: work
    agent: implementer
    gate: auto
  - name: step1
    action: close
    gate: auto
    depends_on: [work]
  - name: step2
    action: close
    gate: auto
    depends_on: [step1]
`,
  );

  // agent -> action:close (succeeds) -> action:auto_merge (fails, no pr_url)
  writeFileSync(
    join(flowDir, "asc-second-fails.yaml"),
    `name: asc-second-fails
stages:
  - name: work
    agent: implementer
    gate: auto
  - name: first
    action: close
    gate: auto
    depends_on: [work]
  - name: second
    action: auto_merge
    gate: auto
    depends_on: [first]
`,
  );

  // agent -> action:create_pr (fails, no workdir) -> action:auto_merge
  writeFileSync(
    join(flowDir, "asc-fail-chain.yaml"),
    `name: asc-fail-chain
stages:
  - name: work
    agent: implementer
    gate: auto
  - name: pr
    action: create_pr
    gate: auto
    depends_on: [work]
  - name: merge
    action: auto_merge
    gate: auto
    depends_on: [pr]
`,
  );

  // agent -> action:close -> agent (action followed by an agent stage)
  writeFileSync(
    join(flowDir, "asc-action-then-agent.yaml"),
    `name: asc-action-then-agent
stages:
  - name: work1
    agent: implementer
    gate: auto
  - name: middle
    action: close
    gate: auto
    depends_on: [work1]
  - name: work2
    agent: implementer
    gate: auto
    depends_on: [middle]
`,
  );

  // single first-stage action (no preceding agent stage)
  writeFileSync(
    join(flowDir, "asc-action-first.yaml"),
    `name: asc-action-first
stages:
  - name: only
    action: close
    gate: auto
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

describe("action stage chaining", () => {
  it("single action stage chains to completion", async () => {
    const session = await app.sessionService.start({
      summary: "single action test",
      flow: "asc-single",
    });

    const final = await waitForSessionStatus(app, session.id, ["completed", "failed"]);
    expect(final.status).toBe("completed");

    const events = await app.events.list(session.id);
    const actionEvents = events.filter((e) => e.type === "action_executed");
    expect(actionEvents.some((e) => (e.data as any)?.action === "close")).toBe(true);
  }, 45_000);

  it("consecutive action stages chain-execute", async () => {
    const session = await app.sessionService.start({
      summary: "chain test",
      flow: "asc-chain",
    });

    const final = await waitForSessionStatus(app, session.id, ["completed", "failed"]);
    expect(final.status).toBe("completed");

    const events = await app.events.list(session.id);
    const actionEvents = events.filter(
      (e) => e.type === "action_executed" && (e.data as any)?.action === "close",
    );
    expect(actionEvents.length).toBeGreaterThanOrEqual(2);
  }, 45_000);

  it("SECOND action failing after first succeeds still marks session failed (#435)", async () => {
    // #435: a chain where the FIRST action succeeds and the SECOND fails must
    // surface as a terminal `failed` -- not a status-machine inconsistency
    // (ready badge alongside a failed errors tab). The Temporal workflow owns
    // this now: a failed action stage closes the workflow as failed.
    const session = await app.sessionService.start({
      summary: "second-action-fails repro",
      flow: "asc-second-fails",
    });

    const final = await waitForSessionStatus(app, session.id, ["failed", "completed"]);
    expect(final.status).toBe("failed");
    expect(final.error).toBeTruthy();
    expect(String(final.error ?? "").toLowerCase()).toContain("auto_merge");

    // first (close) DID run before the chain failed on second (auto_merge).
    const events = await app.events.list(session.id);
    const actionExecuted = events
      .filter((e) => e.type === "action_executed")
      .map((e) => (e.data as any)?.action);
    expect(actionExecuted).toContain("close");
  }, 45_000);

  it("action failure stops chain and sets failed status", async () => {
    // create_pr fails (no workdir/repo); auto_merge must never run.
    const session = await app.sessionService.start({
      summary: "fail chain test",
      flow: "asc-fail-chain",
    });

    const final = await waitForSessionStatus(app, session.id, ["failed", "completed"]);
    expect(final.status).toBe("failed");
    expect(final.error).toBeTruthy();
    // The chain stopped at the create_pr stage -- it never reached merge.
    expect(final.stage).toBe("pr");

    const events = await app.events.list(session.id);
    const mergeEvents = events.filter(
      (e) => e.type === "action_executed" && (e.data as any)?.action === "auto_merge",
    );
    expect(mergeEvents.length).toBe(0);
  }, 45_000);

  it("action stage followed by agent stage dispatches agent and completes", async () => {
    const session = await app.sessionService.start({
      summary: "action then agent test",
      flow: "asc-action-then-agent",
    });

    const final = await waitForSessionStatus(app, session.id, ["completed", "failed"]);
    expect(final.status).toBe("completed");

    // The close action ran between the two agent stages.
    const events = await app.events.list(session.id);
    const actionEvents = events.filter(
      (e) => e.type === "action_executed" && (e.data as any)?.action === "close",
    );
    expect(actionEvents.length).toBe(1);
  }, 45_000);

  it("workflow auto-executes a first-stage action and drives flow to completed", async () => {
    const session = await app.sessionService.start({
      summary: "action-first test",
      flow: "asc-action-first",
    });

    const final = await waitForSessionStatus(app, session.id, ["completed", "failed"]);
    expect(final.status).toBe("completed");

    const events = await app.events.list(session.id);
    const actionEvents = events.filter(
      (e) => e.type === "action_executed" && (e.data as any)?.action === "close",
    );
    expect(actionEvents.length).toBe(1);
  }, 45_000);

  it("executeAction does not advance the session stage internally", async () => {
    // Activity-level contract (still real under Temporal): executeAction runs
    // the action against the session row but never advances the stage --
    // stage advancement is the workflow loop's job, not the action's.
    const session = await app.sessions.create({ summary: "no advance test", flow: "asc-single" });
    await app.sessions.update(session.id, { status: "ready", stage: "finish" });

    const result = await executeAction(depsFromApp(app), session.id, "close");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("close");

    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("finish");
  });
});
