/**
 * Tests for DAG-driven walker logic (Tasks 7, 11, 12).
 *
 * Strategy: extract pure helpers into dag-helpers.ts and unit-test those
 * directly without needing a Temporal test server. This gives high-confidence
 * coverage that the loop walks topoOrder correctly and classifies stages.
 */
import { test, expect } from "bun:test";
import { dagWalkOrder, classifyStage } from "../dag-helpers.js";
import type { LoadedFlow } from "../activities/load-flow.js";

// ---- dagWalkOrder ----

test("dagWalkOrder returns topoOrder as-is for a simple 3-stage linear flow", () => {
  const flow: LoadedFlow = {
    name: "e2e-docs",
    stages: [
      { name: "plan", gate: "auto", depends_on: [] },
      { name: "implement", gate: "auto", depends_on: ["plan"] },
      { name: "close", gate: "auto", depends_on: ["implement"] },
    ],
    topoOrder: [0, 1, 2],
  };
  expect(dagWalkOrder(flow)).toEqual([0, 1, 2]);
});

test("dagWalkOrder respects non-trivial topoOrder from loadFlowActivity", () => {
  // If stages 1 and 2 both depend only on stage 0, they can come in either
  // order; the helper just returns whatever topoOrder the activity computed.
  const flow: LoadedFlow = {
    name: "diamond",
    stages: [
      { name: "a", gate: "auto", depends_on: [] },
      { name: "b", gate: "auto", depends_on: ["a"] },
      { name: "c", gate: "auto", depends_on: ["a"] },
      { name: "d", gate: "auto", depends_on: ["b", "c"] },
    ],
    topoOrder: [0, 1, 2, 3],
  };
  const order = dagWalkOrder(flow);
  // "a" must come before "b" and "c"; "b" and "c" before "d".
  expect(order.indexOf(0)).toBeLessThan(order.indexOf(1));
  expect(order.indexOf(0)).toBeLessThan(order.indexOf(2));
  expect(order.indexOf(1)).toBeLessThan(order.indexOf(3));
  expect(order.indexOf(2)).toBeLessThan(order.indexOf(3));
});

test("dagWalkOrder on single-stage flow returns [0]", () => {
  const flow: LoadedFlow = {
    name: "solo",
    stages: [{ name: "only", gate: "auto", depends_on: [] }],
    topoOrder: [0],
  };
  expect(dagWalkOrder(flow)).toEqual([0]);
});

// ---- classifyStage ----

test("classifyStage: explicit type review_gate", () => {
  expect(classifyStage({ name: "approval", gate: "auto", depends_on: [], type: "review_gate" } as any)).toBe(
    "review_gate",
  );
});

test("classifyStage: explicit type fan_out", () => {
  expect(classifyStage({ name: "spread", gate: "auto", depends_on: [], type: "fan_out" } as any)).toBe("fan_out");
});

test("classifyStage: explicit type fork maps to fan_out", () => {
  expect(classifyStage({ name: "branching", gate: "auto", depends_on: [], type: "fork" } as any)).toBe("fan_out");
});

test("classifyStage: gate=manual maps to review_gate when no explicit type", () => {
  expect(classifyStage({ name: "checkpoint", gate: "manual", depends_on: [] })).toBe("review_gate");
});

test("classifyStage: gate=review maps to review_gate when no explicit type", () => {
  expect(classifyStage({ name: "checkpoint", gate: "review", depends_on: [] })).toBe("review_gate");
});

test("classifyStage: normal agent stage is linear", () => {
  expect(classifyStage({ name: "implement", gate: "auto", depends_on: ["plan"] })).toBe("linear");
});
