import { proxyActivities, defineSignal, setHandler, condition, workflowInfo, startChild } from "@temporalio/workflow";
import type * as acts from "../activities/index.js";
import type { SessionWorkflowInput } from "../types.js";
import { stageWorkflow } from "./stage-workflow.js";
import { classifyStage } from "../dag-helpers.js";

const {
  startSessionActivity,
  resolveComputeForStageActivity,
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

  await startSessionActivity(input);
  await projectSessionActivity({ sessionId: input.sessionId, patch: { status: "ready" } });

  const flow = await loadFlowActivity({ flowName: input.flowName });

  for (const stageIdx of flow.topoOrder) {
    const stage = flow.stages[stageIdx];
    const kind = classifyStage(stage);

    // Review gate: park on signal -- durable across worker / server restart.
    if (kind === "review_gate") {
      await projectStageActivity({
        sessionId: input.sessionId,
        stageIdx,
        patch: { status: "awaiting_review" },
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

    // Linear/DAG stage: dispatch + await completion.
    await resolveComputeForStageActivity({ sessionId: input.sessionId, stageIdx });
    await provisionComputeActivity({ sessionId: input.sessionId, computeName: "local" });
    await projectStageActivity({
      sessionId: input.sessionId,
      stageIdx,
      patch: { status: "dispatching" },
    });

    let launch: import("../types.js").DispatchStageResult;
    try {
      launch = await dispatchStageActivity({ sessionId: input.sessionId, stageIdx });
    } catch (err) {
      await projectStageActivity({
        sessionId: input.sessionId,
        stageIdx,
        patch: { status: "failed", error: String((err as Error)?.message ?? err) },
      });
      await projectSessionActivity({
        sessionId: input.sessionId,
        patch: { status: "failed", error: String((err as Error)?.message ?? err) },
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
      patch: { status: result.status },
    });

    if (result.status !== "completed") {
      await projectSessionActivity({
        sessionId: input.sessionId,
        patch: { status: result.status },
      });
      return;
    }
  }

  await projectSessionActivity({
    sessionId: input.sessionId,
    patch: { status: "completed" },
  });
}
