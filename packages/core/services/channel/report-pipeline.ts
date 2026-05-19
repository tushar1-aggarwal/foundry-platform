/**
 * Channel-report processing pipeline.
 *
 * The `channel/deliver` JSON-RPC handler and the `/hooks/status` non-hook
 * passthrough both feed reports through `handleReport`. This module owns
 * that pipeline: log events, persist messages, emit bus events, apply
 * store updates, reset failed sessions for on_failure retry, and trigger
 * completion side-effects (notifications, artifact tracking, auto-PR).
 * Stage advancement is driven by the Temporal session-workflow, not here.
 */

import type { OrchestrationDeps } from "../deps.js";
import { createWorktreePR } from "../worktree/index.js";
import { eventBus } from "../../hooks.js";
import type { OutboundMessage } from "./channel-types.js";
import { safeAsync } from "../../safe.js";
import { logInfo, logWarn } from "../../observability/structured-log.js";
import { sendOSNotification } from "../../notify.js";

export async function handleReport(deps: OrchestrationDeps, sessionId: string, report: OutboundMessage): Promise<void> {
  // Decide + persist the mechanical side-effects (events log, message
  // send, session updates, artifact tracking). Returns the decision so
  // this function can still drive cross-cutting concerns (bus emit,
  // retry-dispatch, stage handoff, OS notification, auto-PR).
  const result = await deps.app!.sessionHooks.ingestReport(sessionId, report);

  for (const evt of result.busEvents ?? []) {
    eventBus.emit(evt.type, evt.sessionId, evt.data);
  }

  // Stage advancement is driven solely by the Temporal session-workflow
  // loop: it polls session.status via awaitStageCompletionActivity and
  // schedules the next stage's dispatchStageActivity itself. The report
  // pipeline only persists the ingest side-effects (done above) and the
  // failure-retry state reset below.

  if (result.shouldRetry) {
    // retryWithContext flips a failed session back to `ready`; the Temporal
    // workflow's next dispatchStageActivity re-runs the current stage. No
    // in-process re-dispatch here -- that would race the workflow.
    const retryResult = await deps.app!.sessionHooks.retryWithContext(sessionId, {
      maxRetries: result.retryMaxRetries,
    });
    if (retryResult.ok) {
      logInfo("conductor", `on_failure retry triggered for ${sessionId}: ${retryResult.message}`);
      return;
    }
    logWarn("conductor", `on_failure retry exhausted for ${sessionId}: ${retryResult.message}`);
  }

  const finalSession = await deps.sessions.get(sessionId);
  if (finalSession && (report.type === "completed" || report.type === "error")) {
    const notifyTitle = report.type === "completed" ? "Stage completed" : "Session failed";
    const notifyBody = `${finalSession.summary ?? sessionId} - ${finalSession.stage ?? ""}`;
    await sendOSNotification(`Ark: ${notifyTitle}`, notifyBody);
  }

  if (result.prUrl) {
    await deps.events.log(sessionId, "pr_detected", {
      actor: "agent",
      data: { pr_url: result.prUrl },
    });
  }

  if (report.type === "completed" && !result.prUrl) {
    const s = await deps.sessions.get(sessionId);
    if (s && !s.pr_url && s.config?.github_url && s.branch) {
      const { loadRepoConfig } = await import("../../repo-config.js");
      const repoConfig = s.workdir ? loadRepoConfig(s.workdir) : {};
      const autoPR = repoConfig.auto_pr !== false;

      if (autoPR) {
        await safeAsync(`auto-pr: ${sessionId}`, async () => {
          const prResult = await createWorktreePR(deps, sessionId, {
            title: s.summary ?? undefined,
          });
          if (prResult.ok && prResult.pr_url) {
            logInfo("conductor", `auto-PR created for ${sessionId}: ${prResult.pr_url}`);
          }
        });
      }
    }
  }
}
