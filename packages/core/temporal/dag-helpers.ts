import type { LoadedFlow, LoadedStage } from "./activities/load-flow.js";

/**
 * Returns the list of stage indices in topological order from the loaded flow.
 * This is a pure function -- no Temporal SDK dependency -- so it can be unit-tested
 * without a Temporal test server.
 */
export function dagWalkOrder(flow: LoadedFlow): number[] {
  return flow.topoOrder;
}

/**
 * Classifies a stage's routing behaviour.
 * - "review_gate": must park on a human-approval signal before proceeding
 * - "fan_out": must spawn parallel child workflows
 * - "linear": default dispatch-and-await path
 */
export type StageKind = "review_gate" | "fan_out" | "linear";

export function classifyStage(stage: LoadedStage): StageKind {
  // Explicit type fields take priority.
  if ((stage as any).type === "review_gate") return "review_gate";
  if ((stage as any).type === "fan_out" || (stage as any).type === "fork") return "fan_out";
  // Gate-level fallback: manual or review gate triggers the approval signal path.
  if (stage.gate === "manual" || stage.gate === "review") return "review_gate";
  return "linear";
}
