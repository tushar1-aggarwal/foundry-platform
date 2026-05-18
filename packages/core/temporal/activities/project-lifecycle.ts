import type { OrchestrationDeps } from "../../services/deps.js";
import { capturePlanMdIfPresent } from "../../services/plan-artifact.js";
import { saveCheckpoint } from "../../session/checkpoint.js";
import { captureNonClaudeUsage } from "../../services/non-claude-usage.js";
import { recordEvent } from "../../observability.js";
import { emitStageSpanStart, emitStageSpanEnd, emitSessionSpanEnd, flushSpans } from "../../observability/otlp.js";
import { logDebug } from "../../observability/structured-log.js";

/**
 * The single lifecycle-projection seam.
 *
 * The bespoke StageAdvanceService owned every half of a lifecycle
 * transition cohesively: the row mutation, the event that records it
 * (`stage_ready` / `stage_completed` / `session_completed` /
 * `session_failed`), and the side-effects that must happen atomically with
 * it (spans, PLAN.md snapshot, checkpoint, poller stop, stage isolation,
 * non-Claude billing, usage rollup). The Temporal port had split projection
 * into thin "apply a row patch" activities and dropped the rest -- so the
 * row could reach `completed` while the event stream, the traces, and
 * codex/gemini billing never saw the transition.
 *
 * Compute GC is intentionally NOT here: under Template materialization
 * there are no per-session clone rows to reap, and template-lifecycle
 * computes (firecracker / k8s) are durable registered targets that must
 * survive session completion.
 *
 * This module restores the full cohesion in ONE place. A transition is the
 * row change PLUS its event PLUS its side-effects, all derived from the
 * same transition so they cannot diverge. `projectStage` / `projectSession`
 * are thin delegations. Side-effects are best-effort: observability or
 * billing must never fail the transition itself.
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

  // Stage entry: snapshot + checkpoint the LEAVING stage before the row
  // moves, and reset stage isolation. Fresh isolation (the default) drops
  // the prior runtime session so the next stage gets a clean agent.
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

  // Invariant guard: SessionRepository rejects status="running" when
  // session_id would be null (running implies a live handle). Action
  // stages launch no executor, so the workflow's post-dispatch running
  // projection has no session_id -- drop it; the action completed sync.
  if (updates.status === "running" && updates.session_id === undefined && !session?.session_id) {
    delete updates.status;
  }

  if (Object.keys(updates).length > 0) {
    await d.sessions.update(input.sessionId, updates as never);
  }

  // The transition's implied lifecycle event + its side-effects. The row
  // update above and everything below are halves of one transition.
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
      // Recover codex/gemini token usage from the transcript now the
      // stage's agent has exited (Claude is billed live via hooks).
      if (session) await bestEffort("nonClaudeUsage", () => captureNonClaudeUsage(d, session));
    }
    return;
  }

  // Session scope: terminal transition -> terminal event + teardown.
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
