/**
 * Tests for fan_out / fork stage handling (Task 12).
 *
 * Strategy: unit-test stage classification and child-ID generation logic
 * (pure functions). The actual `startChild` / `Promise.all` Temporal
 * primitives are verified at e2e time; here we confirm the decision boundary
 * and the child workflow ID derivation scheme.
 */
import { test, expect } from "bun:test";
import { classifyStage } from "../dag-helpers.js";
import type { LoadedStage } from "../activities/load-flow.js";

function makeStage(overrides: Partial<LoadedStage> & { type?: string }): LoadedStage {
  return { name: "s", gate: "auto", depends_on: [], ...overrides } as LoadedStage;
}

// ---- Classification ----

test("fan_out: explicit type=fan_out is classified correctly", () => {
  expect(classifyStage(makeStage({ type: "fan_out" }))).toBe("fan_out");
});

test("fan_out: type=fork also maps to fan_out", () => {
  expect(classifyStage(makeStage({ type: "fork" }))).toBe("fan_out");
});

test("fan_out: agent stage is NOT a fan_out", () => {
  expect(classifyStage(makeStage({ name: "implement", gate: "auto" }))).toBe("linear");
});

// ---- Child workflow ID derivation ----
// Mirrors the logic in sessionWorkflow:
//   workflowId: `${input.sessionId}-${stage.name}-${j}`
// where j is the index of the subtask.

function childWorkflowId(parentSessionId: string, stageName: string, idx: number): string {
  return `${parentSessionId}-${stageName}-${idx}`;
}

test("child workflow IDs are unique per subtask index", () => {
  const parent = "sess-abc123";
  const stageName = "gen-docs";
  const ids = [0, 1, 2].map((j) => childWorkflowId(parent, stageName, j));
  // All distinct
  expect(new Set(ids).size).toBe(3);
  // Contain parent session id and stage name
  for (const id of ids) {
    expect(id).toContain(parent);
    expect(id).toContain(stageName);
  }
});

test("child workflow IDs are stable (deterministic) for the same inputs", () => {
  expect(childWorkflowId("s1", "fork-stage", 0)).toBe("s1-fork-stage-0");
  expect(childWorkflowId("s1", "fork-stage", 1)).toBe("s1-fork-stage-1");
});

// ---- Fan-out result aggregation ----
// Mirrors the logic in sessionWorkflow:
//   const failed = results.find((r) => r.status !== "completed");

type ChildResult = { status: string };

function aggregateFanOut(results: ChildResult[]): { failed: boolean } {
  const failed = results.find((r) => r.status !== "completed");
  return { failed: Boolean(failed) };
}

test("fan_out: all completed -> not failed", () => {
  const results: ChildResult[] = [{ status: "completed" }, { status: "completed" }];
  expect(aggregateFanOut(results).failed).toBe(false);
});

test("fan_out: any failed child -> failed", () => {
  const results: ChildResult[] = [{ status: "completed" }, { status: "failed" }];
  expect(aggregateFanOut(results).failed).toBe(true);
});

test("fan_out: stopped child is treated as failure", () => {
  const results: ChildResult[] = [{ status: "stopped" }, { status: "completed" }];
  expect(aggregateFanOut(results).failed).toBe(true);
});

test("fan_out: empty subtasks list is trivially successful", () => {
  expect(aggregateFanOut([]).failed).toBe(false);
});
