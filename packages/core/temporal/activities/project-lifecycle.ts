import type { OrchestrationDeps } from "../../services/deps.js";

/**
 * The single lifecycle-projection seam.
 *
 * The bespoke StageAdvanceService owned BOTH halves of a lifecycle
 * transition cohesively: the row mutation and the event that records it
 * (`stage_ready` / `stage_completed` / `session_completed` /
 * `session_failed`). The Temporal port split projection into two thin
 * "apply a row patch" activities and dropped the event half -- so the row
 * could reach `completed` while the event stream (and every UI/observer
 * that reads it) never saw the stage or session finish.
 *
 * This module restores the cohesion in ONE place: a transition is applied
 * to the row AND its implied lifecycle event is emitted here, derived from
 * the same transition, so the two can never diverge again. `projectStage`
 * and `projectSession` activities are thin delegations to this seam.
 */

export type LifecycleScope = "stage" | "session";

export interface LifecycleProjection {
  sessionId: string;
  scope: LifecycleScope;
  /** Flow stage index -- resolves the stage name for `stage` scope. */
  stageIdx?: number;
  patch: Record<string, unknown>;
}

function stageAgentLabel(stageDef: { agent?: unknown } | undefined): string | null {
  const a = stageDef?.agent;
  if (typeof a === "string") return a;
  if (a && typeof a === "object") return (a as { name?: string }).name ?? null;
  return null;
}

export async function projectLifecycle(d: OrchestrationDeps, input: LifecycleProjection): Promise<void> {
  const updates: Record<string, unknown> = { ...input.patch };
  const session = await d.sessions.get(input.sessionId);
  const prevStage = (session?.stage as string | undefined) ?? undefined;
  const status = input.patch.status as string | undefined;

  // Resolve the stage this projection refers to (stage scope only).
  let stageDef: { name?: string; agent?: unknown; action?: unknown } | undefined;
  let stageName: string | undefined;
  if (input.scope === "stage" && input.stageIdx !== undefined && session) {
    const flowDef = await d.flows.get(session.flow);
    stageDef = flowDef?.stages?.[input.stageIdx];
    stageName = stageDef?.name;
    if (stageName && updates.stage === undefined) updates.stage = stageName;
  }

  // Invariant guard: SessionRepository rejects status="running" when
  // session_id would be null (running implies a live handle). Action
  // stages launch no executor, so the workflow's post-dispatch
  // running projection has no session_id -- drop the transition; the
  // action already completed synchronously.
  if (updates.status === "running" && updates.session_id === undefined && !session?.session_id) {
    delete updates.status;
  }

  if (Object.keys(updates).length > 0) {
    await d.sessions.update(input.sessionId, updates as never);
  }

  // The transition's implied lifecycle event, in one mapping. The row
  // update above and this emission are the two halves of one transition.
  if (input.scope === "stage") {
    const isTerminalStatus = status === "completed" || status === "failed";
    const enteringNewStage = !!stageName && stageName !== prevStage && !isTerminalStatus;
    if (enteringNewStage) {
      await d.events.log(input.sessionId, "stage_ready", {
        stage: stageName,
        actor: "system",
        data: {
          from_stage: prevStage ?? null,
          to_stage: stageName,
          stage_type: stageDef?.action ? "action" : "agent",
          stage_agent: stageAgentLabel(stageDef),
        },
      });
    } else if (status === "completed") {
      const completed = stageName ?? prevStage;
      if (completed) {
        await d.events.log(input.sessionId, "stage_completed", {
          stage: completed,
          actor: "system",
          data: { stage: completed, stage_idx: input.stageIdx },
        });
      }
    }
    return;
  }

  // Session scope: terminal transition -> terminal lifecycle event.
  if (status === "completed" || status === "failed") {
    await d.events.log(input.sessionId, status === "completed" ? "session_completed" : "session_failed", {
      stage: prevStage,
      actor: "system",
      data: {
        final_stage: prevStage,
        flow: session?.flow,
        ...(input.patch.error ? { error: input.patch.error } : {}),
      },
    });
  }
}
