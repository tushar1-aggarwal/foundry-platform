import { proxyActivities } from "@temporalio/workflow";
import type * as acts from "../activities/index.js";
import type { StageWorkflowInput } from "../types.js";

const {
  provisionComputeActivity,
  dispatchStageActivity,
  awaitStageCompletionActivity,
  projectStageActivity,
} = proxyActivities<typeof acts>({
  startToCloseTimeout: "1 hour",
  heartbeatTimeout: "60 seconds",
  retry: { maximumAttempts: 2, initialInterval: "1s", backoffCoefficient: 2 },
});

/**
 * Child workflow for a single fan-out branch.
 * Runs the full dispatch-and-await lifecycle for one subtask session,
 * then returns the completion status so the parent can aggregate results.
 */
export async function stageWorkflow(input: StageWorkflowInput): Promise<{ status: string }> {
  // The activity resolves the compute target from session.compute_name.
  await provisionComputeActivity({ sessionId: input.childSessionId });
  await projectStageActivity({
    sessionId: input.childSessionId,
    stageIdx: input.stageIdx,
    patch: { status: "dispatching" },
  });

  const launch = await dispatchStageActivity({ sessionId: input.childSessionId, stageIdx: input.stageIdx });
  await projectStageActivity({
    sessionId: input.childSessionId,
    stageIdx: input.stageIdx,
    patch: { status: "running", ...launch },
  });

  const result = await awaitStageCompletionActivity({
    sessionId: input.childSessionId,
    stageIdx: input.stageIdx,
    timeoutMs: 3_600_000,
  });
  await projectStageActivity({
    sessionId: input.childSessionId,
    stageIdx: input.stageIdx,
    patch: { status: result.status },
  });

  return { status: result.status };
}
