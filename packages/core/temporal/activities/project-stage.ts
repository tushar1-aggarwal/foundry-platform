import type { ProjectionInput } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";
import { projectLifecycle } from "./project-lifecycle.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("projectStageActivity: deps not injected");
  return _deps;
}

/**
 * Project a per-stage lifecycle transition. Thin delegation to the single
 * projection seam (project-lifecycle.ts), which applies the row change AND
 * emits the lifecycle event the transition implies (stage_ready on entry,
 * stage_completed on completion) so row and event can't diverge.
 */
export async function projectStageActivity(input: ProjectionInput): Promise<void> {
  await projectLifecycle(deps(), {
    sessionId: input.sessionId,
    scope: "stage",
    stageIdx: input.stageIdx,
    patch: input.patch,
  });
}
