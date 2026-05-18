/**
 * Action-stage execution under Temporal.
 *
 * Original intent: an action stage (e.g. a `close`/`merge_pr`) must run via
 * the orchestrator and the flow must advance after it succeeds (or fail
 * loudly when it errors) -- NOT sit stuck at `ready` requiring a manual
 * advance. The bespoke `kickActionStage`/`resume`/`drainPendingDispatches`
 * re-dispatch path is deleted; the surviving concern is re-expressed
 * against the real Temporal `executeActionActivity`: start a flow whose
 * single stage is an action and assert the workflow drives it to a
 * terminal state.
 *
 * Uses the bundled `close` action (no `gh`, no network) for the success
 * path and `merge_pr` (fails without a PR/worktree) for the failure path.
 */

import { afterAll, beforeAll, afterEach, describe, expect, it } from "bun:test";
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
  // Inline flow objects are NOT supported by the Temporal start path
  // (flowName is a string looked up via flows.get); write YAML instead.
  writeFileSync(
    join(flowDir, "ra-close.yaml"),
    `name: ra-close
description: single close-action stage
stages:
  - name: finalize
    action: close
    gate: auto
`,
  );
  writeFileSync(
    join(flowDir, "ra-merge.yaml"),
    `name: ra-merge
description: single merge_pr-action stage (fails without a PR)
stages:
  - name: finalize
    action: merge_pr
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
  await app?.shutdown();
  detach?.();
});

describe("action stage marks failed when the action errors", () => {
  it("flips status to `failed` (not stuck at ready) when the action returns ok:false", async () => {
    const session = await app.sessionService.start({
      summary: "action fail",
      flow: "ra-merge",
    });

    const final = await waitForSessionStatus(app, session.id, ["failed", "completed"]);
    // merge_pr without a worktree/PR fails -- the workflow must surface that
    // as a terminal `failed`, not leave the session stuck.
    expect(final.status).toBe("failed");
    expect(final.error).toBeTruthy();
  }, 45_000);
});

describe("action stage auto-advances on success", () => {
  it("completes the flow after the action runs (no manual advance needed)", async () => {
    const session = await app.sessionService.start({
      summary: "action advance",
      flow: "ra-close",
    });

    const final = await waitForSessionStatus(app, session.id, ["completed", "failed"]);
    expect(final.status).toBe("completed");

    // The action's event must have fired -- proves the action actually ran
    // (not just a status flip elsewhere).
    const events = await app.events.list(session.id);
    const actionEv = events.find(
      (e) => e.type === "action_executed" && (e.data as any)?.action === "close",
    );
    expect(actionEv).toBeDefined();
  }, 45_000);
});
