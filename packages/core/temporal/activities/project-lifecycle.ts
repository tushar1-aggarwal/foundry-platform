import type { OrchestrationDeps } from "../../services/deps.js";
import { capturePlanMdIfPresent } from "../../services/plan-artifact.js";
import { saveCheckpoint } from "../../session/checkpoint.js";
import { recordEvent } from "../../observability.js";
import { emitStageSpanStart, emitStageSpanEnd, emitSessionSpanEnd, flushSpans } from "../../observability/otlp.js";
import { logDebug } from "../../observability/structured-log.js";

/**
 * The single seam where a lifecycle transition's row change, its event, and
 * its side-effects happen together so they cannot diverge. Compute GC is
 * deliberately excluded -- template-lifecycle computes must survive
 * completion and there are no per-session clone rows to reap.
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

/** Side-effects are advisory: a failing span/parser must not block the row. */
async function bestEffort(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (e: any) {
    logDebug("session", `lifecycle ${label} (best-effort) failed: ${e?.message ?? e}`);
  }
}

export async function projectLifecycle(d: OrchestrationDeps, input: LifecycleProjection): Promise<void> {
  const updates: Record<string, unknown> = { ...input.patch };
  const session = await d.sessions.get(input.sessionId);
  const prevStage = (session?.stage as string | undefined) ?? undefined;
  const status = input.patch.status as string | undefined;

  // Resolve the stage this projection refers to (stage scope only).
  let stageDef: { name?: string; agent?: unknown; action?: unknown; gate?: unknown; isolation?: string } | undefined;
  let stageName: string | undefined;
  if (input.scope === "stage" && input.stageIdx !== undefined && session) {
    const flowDef = await d.flows.get(session.flow);
    stageDef = flowDef?.stages?.[input.stageIdx];
    stageName = stageDef?.name;
    if (stageName && updates.stage === undefined) updates.stage = stageName;
  }

  const isTerminalStatus = status === "completed" || status === "failed";
  const enteringNewStage = input.scope === "stage" && !!stageName && stageName !== prevStage && !isTerminalStatus;

  // Snapshot/checkpoint the leaving stage before the row moves; fresh
  // isolation drops the prior runtime so the next stage gets a clean agent.
  if (enteringNewStage) {
    if (session) {
      await bestEffort("agent_turn", () =>
        recordEvent({ type: "agent_turn", sessionId: input.sessionId, data: { stage: prevStage } }),
      );
      await bestEffort("capturePlanMd", () => capturePlanMdIfPresent(d, session));
      await bestEffort("checkpoint", () => saveCheckpoint({ sessions: d.sessions, events: d.events }, input.sessionId));
    }
    await bestEffort("stopStatusPoller", () => d.statusPollers.stop(input.sessionId));
    await bestEffort("stageSpanEnd", () => emitStageSpanEnd(input.sessionId, { status: "completed" }));
    if ((stageDef?.isolation ?? "fresh") === "fresh" && updates.claude_session_id === undefined) {
      updates.claude_session_id = null;
    }
  }

  // running implies a live handle; an action stage has no session_id, so
  // drop the transition rather than trip SessionRepository's invariant.
  if (updates.status === "running" && updates.session_id === undefined && !session?.session_id) {
    delete updates.status;
  }

  if (Object.keys(updates).length > 0) {
    await d.sessions.update(input.sessionId, updates as never);
  }

  if (input.scope === "stage") {
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
      await bestEffort("stageSpanStart", () =>
        emitStageSpanStart(input.sessionId, {
          stage: stageName!,
          agent: stageAgentLabel(stageDef) ?? undefined,
          gate: stageDef?.gate as string | undefined,
        }),
      );
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
    await bestEffort("markRead", () => d.messages.markRead(input.sessionId));
    await bestEffort("sessionSpanEnd", async () => {
      const agg = d.app ? await d.app.usageRecorder.getSessionCost(input.sessionId) : null;
      emitSessionSpanEnd(input.sessionId, {
        status: status === "completed" ? "completed" : "failed",
        tokens_in: agg?.input_tokens,
        tokens_out: agg?.output_tokens,
        tokens_cache: agg?.cache_read_tokens,
        cost_usd: agg?.cost,
        turns: session?.config?.turns as number | undefined,
      });
    });
    await bestEffort("flushSpans", () => flushSpans());
  }
}
