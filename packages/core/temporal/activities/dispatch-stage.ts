import type { DispatchStageResult } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";
import { buildDispatchDeps } from "./dispatch-deps.js";
import { DispatchService } from "../../services/dispatch/index.js";
import { dispatchValidationError } from "../errors.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("dispatchStageActivity: deps not injected");
  return _deps;
}

/**
 * Dispatch the current stage of a session: resolve agent, build task, launch executor.
 *
 * Phase 3: self-contained activity. Constructs its own DispatchDeps from the
 * injected OrchestrationDeps via buildDispatchDeps -- no AppContext back-reference
 * and no optional dispatch callback required.
 */
export async function dispatchStageActivity(input: {
  sessionId: string;
  stageIdx: number;
}): Promise<DispatchStageResult> {
  const d = deps();

  // Synchronise session.stage with the workflow's stageIdx before dispatching.
  // The dispatch chain reads `session.stage` (set at session create from
  // flow.stages[0].name) -- without this update, every workflow iteration
  // dispatches the same first stage and never advances. The bespoke engine's
  // StageAdvanceService keeps these in sync; under Temporal the workflow
  // tracks stageIdx and is responsible for projecting it onto the row.
  //
  // Retry-recovery: when a prior attempt failed (action raised, the bespoke
  // path in `maybeHandleActionStage` wrote status="failed" directly to the
  // session row), Temporal silently retries the activity. Without resetting
  // the row here, the retry can succeed but `awaitStageCompletionActivity`
  // still reads the stale "failed" status and the workflow gives up. Clearing
  // the failed flag at the top of every dispatch attempt makes the activity
  // idempotent w.r.t. retry state.
  const session = await d.sessions.get(input.sessionId);
  if (session) {
    const flowDef = await d.flows.get(session.flow);
    const targetStage = flowDef?.stages?.[input.stageIdx]?.name;
    if (targetStage && session.stage !== targetStage) {
      await d.sessions.update(input.sessionId, { stage: targetStage, status: "ready", error: null });
    } else if (session.status === "failed" || session.status === "dispatching") {
      // "dispatching" is set by the workflow's projectStageActivity right
      // before this activity. Reset to "ready" so the dispatch guard
      // (which only accepts status=ready) doesn't reject the launch.
      await d.sessions.update(input.sessionId, { status: "ready", error: null });
    }
  }

  const dispatchDeps = buildDispatchDeps(d);
  const svc = new DispatchService(dispatchDeps);

  try {
    const result = await svc.dispatch(input.sessionId);

    if (result.ok === false) {
      throw dispatchValidationError(result.message);
    }

    return {
      launchPid: (result as any)?.pid ?? undefined,
      launchId: (result as any)?.handle ?? undefined,
    };
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    if (/validation|not found|not ready/i.test(msg)) {
      throw dispatchValidationError(msg);
    }
    throw e;
  }
}
