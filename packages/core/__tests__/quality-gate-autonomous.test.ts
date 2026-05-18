/**
 * Tests for quality gate enforcement in autonomous flows.
 *
 * Validates that the autonomous-sdlc flow enforces quality gates via:
 * 1. The verify stage exists and is wired into the DAG correctly
 * 2. Repo config verify scripts surface failures through runVerification
 * 3. The autonomous flow (single stage) has no verify stage
 *
 * Stage-handoff mediation is owned by the Temporal sessionWorkflow now;
 * the bespoke mediateStageHandoff-driven cases were removed with it.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AppContext } from "../app.js";
import * as flow from "../services/flow.js";
import { depsFromApp } from "../services/deps.js";

let app: AppContext;

beforeEach(async () => {
  if (app) {
    await app.shutdown();
  }
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  // no-op -- beforeEach handles cleanup
});

// ── Helper: create a workdir with .ark.yaml verify scripts ──

function createWorkdirWithVerify(scripts: string[]): string {
  const dir = join(app.arkDir, `workdir-qg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const yaml = ["verify:", ...scripts.map((s) => `  - "${s}"`)].join("\n");
  writeFileSync(join(dir, ".ark.yaml"), yaml);
  return dir;
}

// ── 1. Flow structure: verify stage exists in autonomous-sdlc ──────────

describe("autonomous-sdlc flow structure", () => {
  it("has a verify stage", async () => {
    const stages = await flow.getStages(depsFromApp(app), "autonomous-sdlc");
    const verifyStage = stages.find((s) => s.name === "verify");
    expect(verifyStage).toBeTruthy();
  });

  it("verify stage uses the verifier agent", async () => {
    const stage = await flow.getStage(depsFromApp(app), "autonomous-sdlc", "verify");
    expect(stage).toBeTruthy();
    expect(stage!.agent).toBe("verifier");
  });

  it("verify stage has auto gate", async () => {
    const stage = await flow.getStage(depsFromApp(app), "autonomous-sdlc", "verify");
    expect(stage!.gate).toBe("auto");
  });

  it("verify stage depends on implement", async () => {
    const stage = await flow.getStage(depsFromApp(app), "autonomous-sdlc", "verify");
    expect(stage!.depends_on).toEqual(["implement"]);
  });

  it("review stage depends on verify (not implement)", async () => {
    const stage = await flow.getStage(depsFromApp(app), "autonomous-sdlc", "review");
    expect(stage!.depends_on).toEqual(["verify"]);
  });

  it("stages are ordered: plan -> implement -> verify -> review -> pr -> merge", async () => {
    const stages = await flow.getStages(depsFromApp(app), "autonomous-sdlc");
    const names = stages.map((s) => s.name);
    expect(names).toEqual(["plan", "implement", "verify", "review", "pr", "merge"]);
  });

  it("verify stage has on_failure retry", async () => {
    const stage = await flow.getStage(depsFromApp(app), "autonomous-sdlc", "verify");
    expect(stage!.on_failure).toBe("retry(2)");
  });

  it("verify stage has a task prompt", async () => {
    const stage = await flow.getStage(depsFromApp(app), "autonomous-sdlc", "verify");
    expect(stage!.task).toBeTruthy();
    expect(stage!.task).toContain("verification");
  });
});

// ── 2. DAG correctness ─────────────────────────────────────────────────

describe("autonomous-sdlc DAG validation", () => {
  it("DAG is valid (no cycles, all refs exist)", async () => {
    const stages = await flow.getStages(depsFromApp(app), "autonomous-sdlc");
    expect(() => flow.validateDAG(stages)).not.toThrow();
  });

  it("implement is ready after plan completes", async () => {
    const stages = await flow.getStages(depsFromApp(app), "autonomous-sdlc");
    const ready = flow.getReadyStages(stages, ["plan"]);
    const readyNames = ready.map((s) => s.name);
    expect(readyNames).toContain("implement");
    expect(readyNames).not.toContain("verify");
  });

  it("verify is ready after implement completes", async () => {
    const stages = await flow.getStages(depsFromApp(app), "autonomous-sdlc");
    const ready = flow.getReadyStages(stages, ["plan", "implement"]);
    const readyNames = ready.map((s) => s.name);
    expect(readyNames).toContain("verify");
    expect(readyNames).not.toContain("review");
  });

  it("review is ready after verify completes", async () => {
    const stages = await flow.getStages(depsFromApp(app), "autonomous-sdlc");
    const ready = flow.getReadyStages(stages, ["plan", "implement", "verify"]);
    const readyNames = ready.map((s) => s.name);
    expect(readyNames).toContain("review");
  });

  it("review is NOT ready if only implement completes (verify missing)", async () => {
    const stages = await flow.getStages(depsFromApp(app), "autonomous-sdlc");
    const ready = flow.getReadyStages(stages, ["plan", "implement"]);
    const readyNames = ready.map((s) => s.name);
    expect(readyNames).not.toContain("review");
  });
});

// ── 3. Verify stage handoff with repo config scripts ───────────────────

describe("verify stage quality gate enforcement", async () => {
  it("captures verify script output on failure", async () => {
    const workdir = createWorkdirWithVerify(["echo quality-gate-failed >&2 && exit 1"]);
    const session = await app.sessions.create({ summary: "qg output test", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "verify", workdir });

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(false);
    expect(result.scriptResults).toHaveLength(1);
    expect(result.scriptResults[0].passed).toBe(false);
    expect(result.scriptResults[0].output).toContain("quality-gate-failed");
  });

  it("runs multiple verify scripts and blocks on partial failure", async () => {
    const workdir = createWorkdirWithVerify(["true", "exit 1", "true"]);
    const session = await app.sessions.create({ summary: "qg partial fail", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "verify", workdir });

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(false);
    expect(result.scriptResults).toHaveLength(3);
    expect(result.scriptResults[0].passed).toBe(true);
    expect(result.scriptResults[1].passed).toBe(false);
    expect(result.scriptResults[2].passed).toBe(true);
  });
});

// ── 4. Comparison: autonomous flow (no verify stage) ───────────────────

describe("autonomous flow (single stage, no verify)", async () => {
  it("autonomous flow has no verify stage", async () => {
    const stages = await flow.getStages(depsFromApp(app), "autonomous");
    const verifyStage = stages.find((s) => s.name === "verify");
    expect(verifyStage).toBeFalsy();
  });
});
