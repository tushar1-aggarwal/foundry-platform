import type { ProjectionInput } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("projectStageActivity: deps not injected");
  return _deps;
}

/**
 * Apply the workflow's per-stage row projection. For non-dispatch stages
 * (review_gate in particular) the workflow needs to flip the row's stage
 * name + status so external readers see the current workflow position.
 * The legacy bespoke handoff did this automatically via StageAdvanceService;
 * the Temporal port replicates it here.
 *
 * The patch fields land directly on the sessions row. When stageIdx is set
 * we also resolve the flow's stage name and project it as `stage`, so a
 * caller passing { patch: { status: "ready" } } at the review_gate iteration
 * gets both the right stage name and the new status in one round-trip.
 */
export async function projectStageActivity(input: ProjectionInput): Promise<void> {
  const d = deps();
  const updates: Record<string, unknown> = { ...input.patch };

  let session: Awaited<ReturnType<typeof d.sessions.get>> | undefined;
  if (input.stageIdx !== undefined && updates.stage === undefined) {
    session = await d.sessions.get(input.sessionId);
    if (session) {
      const flowDef = await d.flows.get(session.flow);
      const stageName = flowDef?.stages?.[input.stageIdx]?.name;
      if (stageName) updates.stage = stageName;
    }
  }

  // Invariant guard: SessionRepository rejects status="running" updates when
  // session_id would end up null (running implies a live handle). Action
  // stages (e.g. `create_pr`) don't launch an executor, so the workflow's
  // post-dispatch projectStage({ status: "running", ...launch }) call has
  // no session_id to set and would trip the invariant. Drop the running
  // transition in that case -- the action already completed synchronously
  // when dispatchStageActivity returned.
  if (updates.status === "running" && updates.session_id === undefined) {
    if (!session) session = await d.sessions.get(input.sessionId);
    if (!session?.session_id) {
      delete updates.status;
    }
  }

  if (Object.keys(updates).length > 0) {
    await d.sessions.update(input.sessionId, updates as never);
  }
}
