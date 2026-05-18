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
  // `bare` is gate:manual (parks indefinitely); a single auto stage is the
  // self-terminating flow the harness can drive to `completed`.
  writeFileSync(
    join(flowDir, "sc-auto.yaml"),
    `name: sc-auto
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
});

afterAll(async () => {
  detach?.();
  await app?.shutdown();
});

describe("session compute dispatch", async () => {
  it("dispatch resolves with ok: false for nonexistent session", async () => {
    const result = await app.dispatchService.dispatch("nonexistent-id");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("dispatch resolves with ok: false when session has no stage", async () => {
    // A session created directly (no flow stage) cannot be dispatched.
    const session = await app.sessions.create({ summary: "test-no-stage" });
    const result = await app.dispatchService.dispatch(session.id);
    expect(result.ok).toBe(false);
  });

  // #472: sessions dispatched without an explicit `compute` arg used to land
  // with NULL compute_name in the DB. The compute panel's predicate then
  // treated NULL as "match every compute" and surfaced one session under
  // every panel. Backfill the default at create time so the row has the
  // compute attribution every downstream view expects. Under Temporal,
  // sessionService.start also kicks the workflow, so drive it to a terminal
  // state and assert the persisted compute_name.
  it("sessionService.start defaults compute_name to 'local' when not specified", async () => {
    const session = await app.sessionService.start({ summary: "no-compute-arg", flow: "sc-auto" });
    await waitForSessionStatus(app, session.id, ["completed", "failed"]);
    const stored = await app.sessions.get(session.id);
    expect(stored?.compute_name).toBe("local");
  });

  it("sessionService.start respects an explicit compute_name", async () => {
    const session = await app.sessionService.start({
      summary: "explicit-compute",
      flow: "sc-auto",
      compute_name: "local",
    });
    await waitForSessionStatus(app, session.id, ["completed", "failed"]);
    const stored = await app.sessions.get(session.id);
    expect(stored?.compute_name).toBe("local");
  });
});
