/**
 * End-to-end tests for stage validation: verify scripts + todos.
 *
 * Validates the full lifecycle of stage validation gates:
 * 1. Verify scripts (from flow stage definition and repo config) execute and block/pass
 * 2. Todos block stage completion until resolved
 * 3. Both verify scripts AND todos must pass for handoff to succeed
 * 4. The complete() function respects verification (and --force bypasses it)
 * 5. Conductor HTTP path enforces verification blocking
 * 6. Observability events are emitted correctly on block/pass
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AppContext } from "../app.js";

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

// ── Helper: create a workdir with a .ark.yaml containing verify scripts ──

function createWorkdirWithVerifyScripts(scripts: string[], opts?: { extraYaml?: string }): string {
  const dir = join(app.arkDir, `workdir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const yaml = ["verify:", ...scripts.map((s) => `  - "${s}"`), opts?.extraYaml ?? ""].join("\n");
  writeFileSync(join(dir, ".ark.yaml"), yaml);
  return dir;
}

// ── 1. Verify scripts from repo config ──────────────────────────────────

describe("verify scripts from repo config (.ark.yaml)", async () => {
  it("passing verify scripts allow handoff", async () => {
    const workdir = createWorkdirWithVerifyScripts(["true"]);
    const session = await app.sessions.create({ summary: "verify pass test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(true);
    expect(result.todosResolved).toBe(true);
    expect(result.scriptResults).toHaveLength(1);
    expect(result.scriptResults[0].passed).toBe(true);
    expect(result.message).toBe("Verification passed");
  });

  it("failing verify scripts block handoff", async () => {
    const workdir = createWorkdirWithVerifyScripts(["exit 1"]);
    const session = await app.sessions.create({ summary: "verify fail test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(false);
    expect(result.scriptResults).toHaveLength(1);
    expect(result.scriptResults[0].passed).toBe(false);
    expect(result.message).toContain("verify failed");
  });

  it("partial script failures block even if some pass", async () => {
    const workdir = createWorkdirWithVerifyScripts(["true", "exit 1", "true"]);
    const session = await app.sessions.create({ summary: "partial fail test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(false);
    expect(result.scriptResults).toHaveLength(3);
    expect(result.scriptResults[0].passed).toBe(true);
    expect(result.scriptResults[1].passed).toBe(false);
    expect(result.scriptResults[2].passed).toBe(true);
  });

  it("captures script output in results", async () => {
    const workdir = createWorkdirWithVerifyScripts(["echo hello-from-verify"]);
    const session = await app.sessions.create({ summary: "output capture test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(true);
    expect(result.scriptResults[0].output).toContain("hello-from-verify");
  });

  it("captures stderr from failing scripts", async () => {
    const workdir = createWorkdirWithVerifyScripts(["echo error-output >&2 && exit 1"]);
    const session = await app.sessions.create({ summary: "stderr capture test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(false);
    expect(result.scriptResults[0].output).toContain("error-output");
  });
});

// ── 2. Verify scripts from flow stage definition ────────────────────────

describe("verify scripts from flow stage definition", async () => {
  it("default flow verify stage has verify scripts", async () => {
    const stage = (await app.flows.get("default"))?.stages.find((s) => s.name === "verify");
    expect(stage).toBeTruthy();
    expect(stage!.verify).toBeDefined();
    expect(stage!.verify!.length).toBeGreaterThan(0);
  });

  it("stage verify scripts take precedence over repo config", async () => {
    // Create a workdir with repo config that has different verify scripts
    const workdir = createWorkdirWithVerifyScripts(["echo repo-config-script && exit 1"]);

    // Create a temporary flow with stage-level verify that passes
    const flowDir = join(app.arkDir, "flows");
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(
      join(flowDir, "test-stage-verify.yaml"),
      [
        "name: test-stage-verify",
        "stages:",
        "  - name: work",
        "    agent: implementer",
        "    gate: auto",
        '    verify: ["true"]',
      ].join("\n"),
    );

    const session = await app.sessions.create({
      summary: "stage verify precedence test",
      flow: "test-stage-verify",
    });
    await app.sessions.update(session.id, { status: "ready", stage: "work", workdir });

    const result = await app.sessionReviewer.runVerification(session.id);

    // Stage verify ("true") should take precedence over repo config ("exit 1")
    expect(result.ok).toBe(true);
    expect(result.scriptResults).toHaveLength(1);
    expect(result.scriptResults[0].script).toBe("true");
    expect(result.scriptResults[0].passed).toBe(true);
  });
});

// ── 3. Todo blocking ────────────────────────────────────────────────────

describe("todos block stage validation", async () => {
  it("single unresolved todo blocks verification", async () => {
    const session = await app.sessions.create({ summary: "todo block test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });
    await app.todos.add(session.id, "Fix the failing test");

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(false);
    expect(result.todosResolved).toBe(false);
    expect(result.pendingTodos).toEqual(["Fix the failing test"]);
  });

  it("multiple unresolved todos all appear in message", async () => {
    const session = await app.sessions.create({ summary: "multi-todo test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });
    await app.todos.add(session.id, "Add error handling");
    await app.todos.add(session.id, "Write unit tests");
    await app.todos.add(session.id, "Update documentation");

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(false);
    expect(result.pendingTodos).toHaveLength(3);
    expect(result.message).toContain("Add error handling");
    expect(result.message).toContain("Write unit tests");
    expect(result.message).toContain("Update documentation");
    expect(result.message).toContain("3 unresolved todo");
  });

  it("resolved todos do not block verification", async () => {
    const session = await app.sessions.create({ summary: "resolved todos test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });
    const t1 = await app.todos.add(session.id, "Already done task");
    await app.todos.toggle(t1.id);

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(true);
    expect(result.todosResolved).toBe(true);
    expect(result.pendingTodos).toHaveLength(0);
  });

  it("mix of resolved and unresolved todos: only unresolved block", async () => {
    const session = await app.sessions.create({ summary: "mixed todos test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });
    const t1 = await app.todos.add(session.id, "Done task");
    await app.todos.toggle(t1.id);
    await app.todos.add(session.id, "Still pending");

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(false);
    expect(result.pendingTodos).toEqual(["Still pending"]);
  });
});

// ── 4. Combined: todos AND verify scripts ───────────────────────────────

describe("combined todo + verify script validation", async () => {
  it("both passing todos and scripts result in ok=true", async () => {
    const workdir = createWorkdirWithVerifyScripts(["true"]);
    const session = await app.sessions.create({ summary: "both pass test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });
    const t = await app.todos.add(session.id, "Completed task");
    await app.todos.toggle(t.id);

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(true);
    expect(result.todosResolved).toBe(true);
    expect(result.scriptResults[0].passed).toBe(true);
  });

  it("passing scripts but pending todos: blocked", async () => {
    const workdir = createWorkdirWithVerifyScripts(["true"]);
    const session = await app.sessions.create({ summary: "scripts pass todos fail", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });
    await app.todos.add(session.id, "Not done yet");

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(false);
    expect(result.todosResolved).toBe(false);
    expect(result.scriptResults[0].passed).toBe(true);
    expect(result.message).toContain("unresolved todo");
  });

  it("failing scripts but resolved todos: blocked", async () => {
    const workdir = createWorkdirWithVerifyScripts(["exit 1"]);
    const session = await app.sessions.create({ summary: "scripts fail todos pass", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });
    const t = await app.todos.add(session.id, "All done");
    await app.todos.toggle(t.id);

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(false);
    expect(result.todosResolved).toBe(true);
    expect(result.scriptResults[0].passed).toBe(false);
    expect(result.message).toContain("verify failed");
  });

  it("both failing: message includes both todo and script failures", async () => {
    const workdir = createWorkdirWithVerifyScripts(["echo lint-error && exit 1"]);
    const session = await app.sessions.create({ summary: "both fail test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });
    await app.todos.add(session.id, "Unfinished work");

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(false);
    expect(result.todosResolved).toBe(false);
    expect(result.scriptResults[0].passed).toBe(false);
    expect(result.message).toContain("unresolved todo");
    expect(result.message).toContain("verify failed");
  });
});


// ── 6. complete() function verification ─────────────────────────────────

describe("complete() with verification", async () => {
  it("blocks completion when verify scripts fail", async () => {
    const workdir = createWorkdirWithVerifyScripts(["exit 1"]);
    const session = await app.sessions.create({ summary: "complete block test", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir,
    });

    const result = await app.stageAdvance.complete(session.id);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Verification failed");

    // Session should NOT have advanced
    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("implement");
  });

  it("blocks completion when todos are pending", async () => {
    const session = await app.sessions.create({ summary: "complete todo block", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "implement" });
    await app.todos.add(session.id, "Must complete this first");

    const result = await app.stageAdvance.complete(session.id);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Verification failed");
    expect(result.message).toContain("unresolved todo");
  });

  it("force flag bypasses verification", async () => {
    const workdir = createWorkdirWithVerifyScripts(["exit 1"]);
    const session = await app.sessions.create({ summary: "force complete test", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir,
    });
    await app.todos.add(session.id, "Pending todo");

    const result = await app.stageAdvance.complete(session.id, { force: true });

    expect(result.ok).toBe(true);

    // Session should have advanced past implement
    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).not.toBe("implement");
  });

  it("allows completion when verification passes", async () => {
    const workdir = createWorkdirWithVerifyScripts(["true"]);
    const session = await app.sessions.create({ summary: "complete pass test", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir,
    });

    const result = await app.stageAdvance.complete(session.id);

    expect(result.ok).toBe(true);

    // Session should have advanced
    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
  });

  it("logs stage_completed event on success", async () => {
    const session = await app.sessions.create({ summary: "complete event test", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "implement" });

    await app.stageAdvance.complete(session.id);

    const events = await app.events.list(session.id);
    const completed = events.find((e) => e.type === "stage_completed");
    expect(completed).toBeTruthy();
    expect(completed!.data?.note).toBe("Manually completed");
  });
});



// ── 9. Edge cases ───────────────────────────────────────────────────────

describe("stage validation edge cases", async () => {
  it("no verify scripts and no todos: verification passes trivially", async () => {
    const session = await app.sessions.create({ summary: "no gates test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(true);
    expect(result.scriptResults).toHaveLength(0);
    expect(result.pendingTodos).toHaveLength(0);
  });

  it("session with no workdir runs without scripts", async () => {
    const session = await app.sessions.create({ summary: "no workdir test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(true);
  });

  it("nonexistent session returns error from runVerification", async () => {
    const result = await app.sessionReviewer.runVerification("s-does-not-exist");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("verify scripts run in session workdir context", async () => {
    const dir = join(app.arkDir, `workdir-context-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "marker.txt"), "found-it");
    writeFileSync(join(dir, ".ark.yaml"), 'verify:\n  - "cat marker.txt"\n');

    const session = await app.sessions.create({ summary: "workdir context test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement", workdir: dir });

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(true);
    expect(result.scriptResults[0].output).toContain("found-it");
  });

  it("deleted todos do not block verification", async () => {
    const session = await app.sessions.create({ summary: "deleted todo test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });
    const t = await app.todos.add(session.id, "Will be deleted");
    await app.todos.delete(t.id);

    const result = await app.sessionReviewer.runVerification(session.id);

    expect(result.ok).toBe(true);
    expect(result.todosResolved).toBe(true);
  });

  it("deleteForSession clears all todos, unblocking verification", async () => {
    const session = await app.sessions.create({ summary: "clear todos test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });
    await app.todos.add(session.id, "Task 1");
    await app.todos.add(session.id, "Task 2");
    await app.todos.add(session.id, "Task 3");

    // Before clearing: blocked
    expect((await app.sessionReviewer.runVerification(session.id)).ok).toBe(false);

    // Clear all
    await app.todos.deleteForSession(session.id);

    // After clearing: passes
    expect((await app.sessionReviewer.runVerification(session.id)).ok).toBe(true);
  });
});
