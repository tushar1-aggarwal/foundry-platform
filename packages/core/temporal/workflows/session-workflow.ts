import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  workflowInfo,
  startChild,
  CancellationScope,
} from "@temporalio/workflow";
import type * as acts from "../activities/index.js";
import type { SessionWorkflowInput } from "../types.js";
import { stageWorkflow } from "./stage-workflow.js";
import { classifyStage } from "../dag-helpers.js";

const {
  provisionComputeActivity,
  dispatchStageActivity,
  awaitStageCompletionActivity,
  executeActionActivity: _executeActionActivity,
  runVerificationActivity: _runVerificationActivity,
  projectSessionActivity,
  projectStageActivity,
  loadFlowActivity,
} = proxyActivities<typeof acts>({
  startToCloseTimeout: "1 hour",
  heartbeatTimeout: "60 seconds",
  retry: { maximumAttempts: 2, initialInterval: "1s", backoffCoefficient: 2 },
});

// Cleanup activity gets its own proxy config: short timeout + single attempt.
// A stuck destroy must not extend the workflow's lifetime indefinitely.
const { destroyComputeActivity } = proxyActivities<typeof acts>({
  startToCloseTimeout: "2 minutes",
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});

/**
 * Temporal wraps activity throws as `ActivityFailure` whose own `.message` is
 * the useless "Activity task failed" -- the real reason (the activity's
 * ApplicationFailure) is nested in `.cause`. Walk the chain and keep the
 * deepest non-generic message so `session.error` explains itself instead of
 * forcing a dig through temporal-worker logs. Pure + sandbox-safe.
 */
function unwrapWorkflowError(err: unknown): string {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  let best = "";
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const msg =
      typeof (cur as { message?: unknown }).message === "string" ? (cur as { message: string }).message.trim() : "";
    if (msg && !/^Activity task failed/.test(msg)) best = msg;
    cur = (cur as { cause?: unknown }).cause;
  }
  return best || String((err as Error)?.message ?? err);
}

export const approveReviewGateSignal = defineSignal<[{ sessionId: string }]>("approveReviewGate");
export const rejectReviewGateSignal = defineSignal<[{ sessionId: string; reason: string }]>("rejectReviewGate");

export async function sessionWorkflow(input: SessionWorkflowInput): Promise<void> {
  let approved = false;
  let rejected: string | null = null;

  setHandler(approveReviewGateSignal, () => {
    approved = true;
  });
  setHandler(rejectReviewGateSignal, (p) => {
    rejected = p.reason;
  });

  try {
    // SessionService.start() already wrote the row and the session_created
    // event before scheduling this workflow; no separate start activity is
    // needed (a previous version of startSessionActivity re-emitted the
    // event and broke the projection invariant).
    await projectSessionActivity({ sessionId: input.sessionId, patch: { status: "ready" } });

    const flow = await loadFlowActivity({ flowName: input.flowName });

    for (const stageIdx of flow.topoOrder) {
      const stage = flow.stages[stageIdx];
      const kind = classifyStage(stage);

      // Review gate: park on signal -- durable across worker / server restart.
      // Use status="ready" while parked (matches the local bespoke behavior --
      // bespoke leaves the row at status=ready when the agent for the new
      // review_gate stage has nothing to dispatch). External callers tell the
      // gate state apart by `stage.type === "review_gate"` (or `gate === "manual"`)
      // rather than a status flag.
      if (kind === "review_gate") {
        await projectStageActivity({
          sessionId: input.sessionId,
          stageIdx,
          patch: { status: "ready" },
        });
        await condition(() => approved || rejected !== null);
        if (rejected !== null) {
          await projectStageActivity({
            sessionId: input.sessionId,
            stageIdx,
            patch: { status: "rejected", error: rejected },
          });
          await projectSessionActivity({
            sessionId: input.sessionId,
            patch: { status: "failed", error: rejected },
          });
          return;
        }
        // Reset both gate signals for the next review_gate in the same flow.
        // Forgetting `rejected = null` makes the next gate exit immediately
        // via the `rejected !== null` branch since the variable still holds
        // the prior gate's reason.
        approved = false;
        rejected = null;
        await projectStageActivity({
          sessionId: input.sessionId,
          stageIdx,
          patch: { status: "completed" },
        });
        continue;
      }

      // Fan-out: spawn child stageWorkflow instances in parallel, join via Promise.all.
      if (kind === "fan_out") {
        const subtasks: any[] = (stage as any).subtasks ?? [];
        await projectStageActivity({
          sessionId: input.sessionId,
          stageIdx,
          patch: { status: "fanning_out" },
        });
        const childPromises = subtasks.map((sub: any, j: number) =>
          startChild(stageWorkflow, {
            workflowId: `${input.sessionId}-${stage.name}-${j}`,
            taskQueue: workflowInfo().taskQueue,
            args: [
              {
                parentSessionId: input.sessionId,
                childSessionId: sub.sessionId ?? `${input.sessionId}-${stage.name}-${j}`,
                tenantId: input.tenantId,
                stageIdx,
                stageName: stage.name,
                task: sub.task ?? "",
                agent: sub.agent,
              },
            ],
          }).then((handle) => handle.result()),
        );
        const results = await Promise.all(childPromises);
        const failed = results.find((r) => r.status !== "completed");
        await projectStageActivity({
          sessionId: input.sessionId,
          stageIdx,
          patch: { status: failed ? "failed" : "completed" },
        });
        if (failed) {
          await projectSessionActivity({
            sessionId: input.sessionId,
            patch: { status: "failed" },
          });
          return;
        }
        continue;
      }

      // Linear/DAG stage: dispatch + await completion. The activity
      // resolves the compute target from session.compute_name.
      await provisionComputeActivity({ sessionId: input.sessionId });
      await projectStageActivity({
        sessionId: input.sessionId,
        stageIdx,
        patch: { status: "dispatching" },
      });

      let launch: import("../types.js").DispatchStageResult;
      try {
        launch = await dispatchStageActivity({ sessionId: input.sessionId, stageIdx });
      } catch (err) {
        const reason = unwrapWorkflowError(err);
        await projectStageActivity({
          sessionId: input.sessionId,
          stageIdx,
          patch: { status: "failed", error: reason },
        });
        await projectSessionActivity({
          sessionId: input.sessionId,
          patch: { status: "failed", error: reason },
        });
        throw err;
      }

      await projectStageActivity({
        sessionId: input.sessionId,
        stageIdx,
        patch: { status: "running", ...launch },
      });

      const result = await awaitStageCompletionActivity({
        sessionId: input.sessionId,
        stageIdx,
        timeoutMs: 3_600_000,
      });
      await projectStageActivity({
        sessionId: input.sessionId,
        stageIdx,
        patch: { status: result.status, ...(result.error ? { error: result.error } : {}) },
      });

      if (result.status !== "completed") {
        await projectSessionActivity({
          sessionId: input.sessionId,
          patch: { status: result.status, ...(result.error ? { error: result.error } : {}) },
        });
        return;
      }
    }

    await projectSessionActivity({
      sessionId: input.sessionId,
      patch: { status: "completed" },
    });
  } finally {
    // Reap the session's provisioned compute on every terminal path:
    // success, stage-failure return, thrown error, cancellation, or
    // workflowExecutionTimeout. nonCancellable keeps the destroy from
    // being aborted by the same cancel that's running this finally.
    // The inner try/catch is a last-ditch swallow for Temporal-level
    // failures (startToCloseTimeout, worker crash) that the activity body
    // itself cannot catch -- session state is already final by this
    // point, so we let the workflow complete cleanly regardless.
    await CancellationScope.nonCancellable(async () => {
      try {
        await destroyComputeActivity({ sessionId: input.sessionId });
      } catch {
        /* swallow: cleanup-on-exit must not abort workflow close */
      }
    });
  }
}
