// Import the harness FIRST so its top-level Temporal module substitutes are
// installed before any transitive import pulls in the real client; otherwise
// spawnSubagent's startWorkflowFor dials a non-existent Temporal server.
import { attachTemporalTestHarness, drainTemporalTestHarness, waitForSessionStatus } from "../temporal/test-harness.js";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AppContext } from "../app.js";
import { spawnSubagent } from "../services/subagents.js";
import { depsFromApp } from "../services/deps.js";

let app: AppContext;
let detach: (() => void) | undefined;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  const flowDir = join(app.config.dirs.ark, "flows");
  mkdirSync(flowDir, { recursive: true });
  // spawnSubagent hard-codes flow "quick"; provide a single-stage auto
  // definition under that name so the child's real sessionWorkflow can run
  // to completion in-process instead of parking or dialing Temporal.
  writeFileSync(
    join(flowDir, "quick.yaml"),
    `name: quick\nstages:\n  - name: work\n    agent: implementer\n    gate: auto\n`,
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

describe("spawnSubagent", () => {
  it("creates a child session with parent reference", async () => {
    const parent = await app.sessions.create({ summary: "parent" });
    await app.sessions.update(parent.id, { agent: "implementer" });

    const result = await spawnSubagent(depsFromApp(app), parent.id, { task: "subtask" });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeDefined();

    const child = await app.sessions.get(result.sessionId!);
    expect(child).not.toBeNull();
    expect(child!.summary).toBe("subtask");
    expect(child!.parent_id).toBe(parent.id);
    expect(child!.agent).toBe("implementer");

    await waitForSessionStatus(app, result.sessionId!, ["completed", "failed"]);
  }, 45_000);

  it("allows agent override", async () => {
    const parent = await app.sessions.create({ summary: "parent" });
    await app.sessions.update(parent.id, { agent: "implementer" });

    const result = await spawnSubagent(depsFromApp(app), parent.id, {
      task: "review task",
      agent: "reviewer",
    });
    const child = await app.sessions.get(result.sessionId!);
    expect(child!.agent).toBe("reviewer");

    await waitForSessionStatus(app, result.sessionId!, ["completed", "failed"]);
  }, 45_000);

  it("rejects non-existent parent", async () => {
    const result = await spawnSubagent(depsFromApp(app), "nope", { task: "orphan" });
    expect(result.ok).toBe(false);
  });

  it("sets subagent config flag", async () => {
    const parent = await app.sessions.create({ summary: "parent" });
    await app.sessions.update(parent.id, { agent: "worker" });

    const result = await spawnSubagent(depsFromApp(app), parent.id, { task: "sub" });
    const child = await app.sessions.get(result.sessionId!);
    expect(child!.config.subagent).toBe(true);
    expect(child!.config.parent_id).toBe(parent.id);

    await waitForSessionStatus(app, result.sessionId!, ["completed", "failed"]);
  }, 45_000);

  it("uses quick flow for subagents", async () => {
    const parent = await app.sessions.create({ summary: "parent" });
    await app.sessions.update(parent.id, { agent: "worker" });

    const result = await spawnSubagent(depsFromApp(app), parent.id, { task: "sub" });
    const child = await app.sessions.get(result.sessionId!);
    expect(child!.flow).toBe("quick");

    await waitForSessionStatus(app, result.sessionId!, ["completed", "failed"]);
  }, 45_000);
});
