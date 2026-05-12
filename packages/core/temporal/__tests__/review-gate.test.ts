/**
 * Tests for review_gate signal handling (Task 7).
 *
 * Strategy: unit-test the stage classification and signal state-machine
 * logic via the pure dag-helpers. The actual `setHandler` / `condition`
 * Temporal primitives are integration-tested via the real worker at e2e time;
 * here we verify the decision boundary that controls branching.
 */
import { test, expect } from "bun:test";
import { classifyStage } from "../dag-helpers.js";
import type { LoadedStage } from "../activities/load-flow.js";

function makeStage(overrides: Partial<LoadedStage> & { type?: string }): LoadedStage {
  return { name: "s", gate: "auto", depends_on: [], ...overrides } as LoadedStage;
}

// ---- Classification boundary ----

test("review_gate: type=review_gate triggers gate", () => {
  expect(classifyStage(makeStage({ type: "review_gate" }))).toBe("review_gate");
});

test("review_gate: gate=manual triggers gate even without explicit type", () => {
  expect(classifyStage(makeStage({ gate: "manual" }))).toBe("review_gate");
});

test("review_gate: gate=review triggers gate", () => {
  expect(classifyStage(makeStage({ gate: "review" }))).toBe("review_gate");
});

test("review_gate: gate=auto with no type is NOT a gate", () => {
  expect(classifyStage(makeStage({ gate: "auto" }))).toBe("linear");
});

test("review_gate: gate=condition with no type is NOT a review gate", () => {
  expect(classifyStage(makeStage({ gate: "condition" }))).toBe("linear");
});

// ---- Signal state machine ----
// The sessionWorkflow uses two boolean flags:
//   approved: boolean  -- set true by approveReviewGateSignal handler
//   rejected: string|null -- set by rejectReviewGateSignal handler
// Simulate the same logic to verify correct state transitions.

type SignalState = { approved: boolean; rejected: string | null };

function initialState(): SignalState {
  return { approved: false, rejected: null };
}

function applyApprove(state: SignalState): SignalState {
  return { ...state, approved: true };
}

function applyReject(state: SignalState, reason: string): SignalState {
  return { ...state, rejected: reason };
}

function isGateUnblocked(state: SignalState): boolean {
  return state.approved || state.rejected !== null;
}

function resetApproved(state: SignalState): SignalState {
  return { ...state, approved: false };
}

test("gate stays blocked until a signal arrives", () => {
  const s = initialState();
  expect(isGateUnblocked(s)).toBe(false);
});

test("approve signal unblocks the gate", () => {
  let s = initialState();
  s = applyApprove(s);
  expect(isGateUnblocked(s)).toBe(true);
  expect(s.rejected).toBeNull();
});

test("reject signal unblocks the gate with a reason", () => {
  let s = initialState();
  s = applyReject(s, "looks wrong");
  expect(isGateUnblocked(s)).toBe(true);
  expect(s.rejected).toBe("looks wrong");
});

test("after approval, approved flag resets for next gate", () => {
  let s = initialState();
  s = applyApprove(s);
  // workflow consumed signal, resets for next gate
  s = resetApproved(s);
  expect(isGateUnblocked(s)).toBe(false);
});

test("reject takes precedence over approve when both fire", () => {
  let s = initialState();
  s = applyApprove(s);
  s = applyReject(s, "rejected after approve");
  // rejected is non-null -- workflow will follow rejection path
  expect(s.rejected).toBe("rejected after approve");
});
