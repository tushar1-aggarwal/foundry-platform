/**
 * Shared callback shapes that wrap the free functions in `services/flow.ts`.
 *
 * Three deps interfaces (DispatchDeps, SessionHooksDeps, StageAdvanceDeps)
 * each used to declare these locally and the DI layer wired the same
 * `(name, stage) => flow.getStage(app, name, stage)` lambda three times.
 * Lifting the callback types here gives one source of truth; lifting the
 * factory below lets the DI registrations spread one record instead of
 * repeating four lambdas per service.
 */

import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import type { StageDefinition, StageAction } from "./flow.js";
import * as flow from "./flow.js";
import { depsFromApp } from "./deps.js";

export interface GetStageCb {
  (flowName: string, stageName: string): StageDefinition | null;
}

export interface GetStageActionCb {
  (flowName: string, stageName: string): StageAction;
}

export interface ResolveNextStageCb {
  (flowName: string, stage: string, outcome?: string): string | null;
}

export interface EvaluateGateCb {
  (flowName: string, stage: string, session: Session): { canProceed: boolean; reason: string };
}

/**
 * Build the four flow-lookup callbacks bound to a specific AppContext.
 * Spread the relevant subset into each deps registration; consumers that
 * only need `getStage` / `getStageAction` pick those two fields.
 */
export function buildFlowCallbacks(app: AppContext): {
  getStage: GetStageCb;
  getStageAction: GetStageActionCb;
  resolveNextStage: ResolveNextStageCb;
  evaluateGate: EvaluateGateCb;
} {
  const deps = depsFromApp(app);
  return {
    getStage: (flowName, stageName) => flow.getStage(deps, flowName, stageName),
    getStageAction: (flowName, stageName) => flow.getStageAction(deps, flowName, stageName),
    resolveNextStage: (flowName, stage, outcome) => flow.resolveNextStage(deps, flowName, stage, outcome),
    evaluateGate: (flowName, stage, session) => flow.evaluateGate(deps, flowName, stage, session),
  };
}
