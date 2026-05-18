/**
 * Status poller for non-Claude executors.
 *
 * Claude Code reports status via HTTP hooks. Other CLI tools don't.
 * This poller checks tmux session existence periodically and updates
 * session status when the process exits.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import type { Executor, ExecutorStatus } from "../executor.js";
import { getExecutor } from "../executor.js";
import { logDebug, logError, logInfo, logWarn } from "../observability/structured-log.js";
import { resolveComputeTarget } from "../compute-resolver.js";
import { ArkdUnreachableError } from "../../arkd/common/index.js";
import { withSessionLock } from "../services/session-lock.js";

const UNREACHABLE_BUDGET = 5; // consecutive unreachable probes before marking session failed

/**
 * Read the exit-code sentinel for a session, if the launcher wrote one.
 * Returns the parsed non-zero exit code, or `null` when no sentinel is
 * present / the file is empty / the code is 0.
 *
 * The launcher (see claude.ts:buildLauncher) writes `$ARK_SESSION_DIR/exit-code`
 * when the agent exits non-zero. We treat this as the authoritative signal
 * that the session failed, even if tmux's `exec bash` keeps the pane alive.
 */
export function readExitCodeSentinel(tracksDir: string, sessionId: string): number | null {
  const path = join(tracksDir, sessionId, "exit-code");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    const code = Number.parseInt(raw, 10);
    if (!Number.isFinite(code) || code === 0) return null;
    return code;
  } catch {
    return null;
  }
}

/**
 * Registry of active status-poll intervals, keyed by sessionId. One instance
 * per AppContext -- disposed on `shutdown()` so per-test / per-replica
 * cleanup doesn't leave intervals leaking against a stale executor registry.
 *
 * The previous module-level `activePollers` Map survived AppContext teardown,
 * which in parallel test execution meant one test's pollers could tick against
 * another's AppContext (usually harmless, but a latent cross-test leak).
 */
export class StatusPollerRegistry {
  private readonly intervals = new Map<string, ReturnType<typeof setInterval>>();

  has(sessionId: string): boolean {
    return this.intervals.has(sessionId);
  }

  set(sessionId: string, interval: ReturnType<typeof setInterval>): void {
    this.intervals.set(sessionId, interval);
  }

  stop(sessionId: string): void {
    const interval = this.intervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(sessionId);
    }
  }

  stopAll(): void {
    this.intervals.forEach((interval) => clearInterval(interval));
    this.intervals.clear();
  }

  /** Awilix disposer -- called on container.dispose(). */
  dispose(): void {
    this.stopAll();
  }
}

/**
 * Resolve a session's compute target + a usable ComputeHandle.
 *
 * `computeHandle` is null when the row can't yield one yet -- callers decide
 * whether that's fatal. The persisted-handle fallback exists because for K8s
 * sessions on a TEMPLATE compute (e.g. session.compute_name="docs-k8s") the
 * template row never has pod_name; pod metadata is persisted to
 * session.config.compute_handle by the dispatcher's runTargetLifecycle.
 * Without it attachExistingHandle returns null, the K8s checkAlive branch is
 * skipped, executor.status() runs a local `tmux has-session` against a
 * pod-side tmux name that never exists on the conductor, and the session is
 * wrongly marked "agent process exited" while claude is still alive in the
 * pod. (claude-code.ts uses the same fallback for previewHandle.)
 */
async function resolveComputeHandle(app: AppContext, session: Session) {
  const { target, compute: computeRow } = await resolveComputeTarget(app, session);
  if (!target || !computeRow) return null;
  const persistedHandle =
    ((session.config as { compute_handle?: import("../compute/types.js").ComputeHandle } | null | undefined)
      ?.compute_handle as import("../compute/types.js").ComputeHandle | undefined) ?? undefined;
  const computeHandle =
    target.compute.attachExistingHandle?.({
      name: computeRow.name,
      status: computeRow.status,
      config: computeRow.config ?? {},
    }) ??
    persistedHandle ??
    null;
  return { target, computeRow, computeHandle };
}

/**
 * Probe whether the agent is still live on its compute target.
 *
 * Each runtime owns its own status check via `Executor.probeStatus`:
 *   - tmux-based runtimes (claude-code, codex, gemini, goose, cli-agent)
 *     ask arkd `/agent/status` (-> `tmux has-session`)
 *   - process-based runtimes (claude-agent) ask arkd `/process/status`
 *     (-> `kill(pid, 0)`); their handle never points at a tmux session,
 *     so the tmux check would always say "not running" and prematurely
 *     flip the row to completed within ~3s of launch (#435).
 *
 * Falls back to the legacy `executor.status(handle)` only when there is
 * no provider/compute on the session (legacy dispatch without
 * compute_name) AND the executor has not implemented probeStatus.
 *
 * Transient probe failures (arkd unreachable, network timeout) keep the
 * status as `running` rather than tripping a false `not_found` -- a
 * single failed probe must not flip a healthy session to completed.
 */
async function probeSessionStatus(
  app: AppContext,
  sessionId: string,
  handle: string,
  executor: Executor,
): Promise<ExecutorStatus> {
  const session = await app.sessions.get(sessionId);
  if (session?.compute_name) {
    try {
      // The runtime-specific probeStatus path (e.g. claude-agent's
      // /process/status) gets first crack; if absent we fall back to
      // AgentHandle.checkAlive which talks /agent/status to arkd.
      const resolved = await resolveComputeHandle(app, session);
      if (resolved) {
        if (executor.probeStatus) {
          return await executor.probeStatus({ app, session, handle });
        }
        if (resolved.computeHandle) {
          const agent = resolved.target.isolation.attachAgent(resolved.target.compute, resolved.computeHandle, handle);
          const running = await agent.checkAlive();
          return running ? { state: "running" } : { state: "not_found" };
        }
      }
    } catch (err: any) {
      logWarn("status", `compute-target status probe failed for ${sessionId}: ${err?.message ?? err}; keeping running`);
      return { state: "running" };
    }
  }
  return executor.status(handle);
}

/**
 * Resolve the live arkd URL for a session's compute pod, or null when it
 * can't be reached (no compute, template-only row, pod gone). Used purely
 * for best-effort forensic capture -- callers must tolerate null.
 */
async function resolveArkdUrl(app: AppContext, session: Session): Promise<string | null> {
  try {
    if (!session.compute_name) return null;
    const resolved = await resolveComputeHandle(app, session);
    if (!resolved?.computeHandle) return null;
    return resolved.target.compute.getArkdUrl(resolved.computeHandle);
  } catch {
    return null;
  }
}

/**
 * One poller tick. Exported as _tickForTest so tests can drive ticks manually
 * without relying on setInterval timing. NOT part of the public API.
 *
 * @param state - mutable per-poller state; caller must pass the same object on every tick
 */
export async function _tickForTest(
  app: AppContext,
  sessionId: string,
  handle: string,
  executor: Executor,
  state: { consecutiveUnreachable: number },
): Promise<void> {
  // Exit-code sentinel: the launcher writes $ARK_SESSION_DIR/exit-code
  // when the agent process exits non-zero. `exec bash` keeps the tmux
  // pane alive for post-mortem inspection, so executor.status() still
  // reports "running" -- we need this side-channel to flip the Ark
  // session to "failed". Bug 3 in the session-dispatch cascade.
  const exitCode = readExitCodeSentinel(app.config.dirs.tracks, sessionId);
  if (exitCode !== null) {
    app.statusPollers.stop(sessionId);

    const session = await app.sessions.get(sessionId);
    if (!session || session.status !== "running") return;

    // Tail the stderr/log for a helpful reason, best-effort.
    let tail = "";
    try {
      const stderrPath = join(app.config.dirs.tracks, sessionId, "stderr.log");
      if (existsSync(stderrPath)) {
        tail = readFileSync(stderrPath, "utf-8").split("\n").slice(-20).join("\n").trim();
      }
    } catch {
      logDebug("status", "stderr tail best-effort");
    }

    const reason = tail ? `Claude exited with code ${exitCode}\n${tail}` : `Claude exited with code ${exitCode}`;
    await app.sessions.update(sessionId, {
      status: "failed",
      error: reason,
      session_id: null,
    });

    await app.events.log(sessionId, "session_failed", {
      stage: session.stage,
      actor: "system",
      data: { reason: "agent exit-code sentinel", exitCode },
    });

    logInfo("session", `status-poller: ${sessionId} -> failed (exit code ${exitCode})`);
    return;
  }

  // Probe with ArkdUnreachableError budget.
  let status: ExecutorStatus;
  try {
    status = await probeSessionStatus(app, sessionId, handle, executor);
    state.consecutiveUnreachable = 0; // reset on any successful probe
  } catch (err: any) {
    if (err instanceof ArkdUnreachableError) {
      state.consecutiveUnreachable++;
      logWarn(
        "status",
        `status-poller: arkd unreachable for ${sessionId} (${state.consecutiveUnreachable}/${UNREACHABLE_BUDGET}): ${err.message}`,
      );
      if (state.consecutiveUnreachable >= UNREACHABLE_BUDGET) {
        app.statusPollers.stop(sessionId);
        const session = await app.sessions.get(sessionId);
        if (session && session.status === "running") {
          const errMsg = `arkd unreachable: status poller could not reach arkd after ${UNREACHABLE_BUDGET} consecutive retries: ${err.message}`;
          await app.sessions.update(sessionId, { status: "failed", error: errMsg, session_id: null });
          await app.events.log(sessionId, "session_failed", {
            stage: session.stage,
            actor: "system",
            data: { reason: "arkd unreachable", attempts: UNREACHABLE_BUDGET },
          });
          logError(
            "status",
            `status-poller: ${sessionId} -> failed (arkd unreachable after ${UNREACHABLE_BUDGET} retries)`,
          );
        }
      }
      return;
    }
    logWarn("status", `polling tick failed: ${err?.message ?? err}`);
    return;
  }

  // --- status handling (rest of tick logic follows) ---
  return _handleStatus(app, sessionId, handle, status);
}

export function startStatusPoller(app: AppContext, sessionId: string, handle: string, executorName: string): void {
  const pollers = app.statusPollers;
  // Don't double-poll
  if (pollers.has(sessionId)) return;

  const state = { consecutiveUnreachable: 0 };
  let tick = 0;
  const interval = setInterval(async () => {
    tick++;
    try {
      const executor = app.pluginRegistry.executor(executorName) ?? getExecutor(executorName);
      if (!executor) {
        stopStatusPoller(app, sessionId);
        return;
      }

      // Every 5th tick (~15s), snapshot the process tree for observability
      if (tick % 5 === 0) {
        try {
          const session = await app.sessions.get(sessionId);
          if (session) {
            const { snapshotSessionTree } = await import("./process-tree.js");
            const tree = await snapshotSessionTree(handle);
            if (tree) {
              await app.sessions.mergeConfig(sessionId, { process_tree: tree });
            }
            // Heartbeat forensic snapshot: the terminal capture can race pod
            // teardown (a kill -9'd or OOM'd pod leaves no exit handler), so
            // periodically mirror the worker logs to durable storage. Hosted
            // only -- local mode already has the conductor-side tee on disk.
            if (app.mode.kind === "hosted") {
              const arkdUrl = await resolveArkdUrl(app, session);
              if (arkdUrl) {
                const { captureWorkerForensics } = await import("../services/session-forensic.js");
                const { depsFromApp } = await import("../services/deps.js");
                await captureWorkerForensics(depsFromApp(app), session, arkdUrl);
              }
            }
          }
        } catch {
          logDebug("status", "best-effort");
        }
      }

      await _tickForTest(app, sessionId, handle, executor, state);
    } catch (err: any) {
      // Don't crash the poller; surface the error in structured log.
      logWarn("status", `polling tick failed: ${err?.message ?? err}`);
    }
  }, 3000); // Check every 3 seconds

  pollers.set(sessionId, interval);
}

async function _handleStatus(
  app: AppContext,
  sessionId: string,
  handle: string,
  status: ExecutorStatus,
): Promise<void> {
  if (status.state === "completed" || status.state === "failed" || status.state === "not_found") {
    stopStatusPoller(app, sessionId);

    const session = await app.sessions.get(sessionId);
    if (!session || session.status !== "running") return;

    // Defensive guard: with explicit stopStatusPoller calls in stage-advance,
    // this branch should never fire on a healthy stage handoff. Kept as a
    // safety net for direct sessions.update() calls that bypass StageAdvanceService.
    if (session.session_id && session.session_id !== handle) return;

    // `not_found` means the handle is gone. That happens cleanly when the
    // agent fires its completion hook and the process exits, or abnormally
    // when the agent is killed before firing the hook (the prior daemon
    // died mid-flight, the user pkilled the worker, etc). The two cases
    // are indistinguishable from the probe alone -- check the events log
    // for the completion hook to tell them apart.
    let newStatus: "completed" | "failed" = status.state === "failed" ? "failed" : "completed";
    let error = status.state === "failed" ? (status as { error?: string }).error : null;
    if (status.state === "not_found") {
      const events = await app.events.list(sessionId);
      const sawCompletionHook = events.some(
        (e: { type: string; data?: unknown }) =>
          e.type === "hook_status" && (e.data as { event?: string } | undefined)?.event === "SessionEnd",
      );
      if (!sawCompletionHook) {
        newStatus = "failed";
        error = "agent process exited without firing completion hook -- interrupted before reporting done";
      }
    }

    // Pull the worker's stdio.log + transcript.jsonl into durable storage
    // before the compute pod is reaped (hosted mode skips the conductor-side
    // tee, so this snapshot is the only post-mortem copy). On failure, fold
    // the stdio tail into the error + event so the session record explains
    // itself instead of just "process exited with code N". Best-effort.
    const arkdUrl = await resolveArkdUrl(app, session);
    if (arkdUrl) {
      try {
        const { captureWorkerForensics } = await import("../services/session-forensic.js");
        const { depsFromApp } = await import("../services/deps.js");
        const { stdioTail } = await captureWorkerForensics(depsFromApp(app), session, arkdUrl);
        if (newStatus === "failed" && stdioTail) {
          error = `${error ?? "agent process exited"}\n--- worker stdio (tail) ---\n${stdioTail}`;
        }
      } catch {
        logDebug("status", "forensic capture best-effort");
      }
    }

    // Under Temporal orchestration, skip the brief "completed" write on
    // success: external observers polling session.status for a terminal
    // state would race the workflow's next-stage dispatch and observe
    // the inter-stage gap as a false success. Write "ready" directly --
    // awaitStageCompletionActivity is taught to accept "ready" as a
    // stage-done signal. Failures still write "failed" so the workflow
    // can surface them.
    const writeStatus = newStatus === "completed" && session.orchestrator === "temporal" ? "ready" : newStatus;
    await app.sessions.update(sessionId, {
      status: writeStatus,
      error: error ?? null,
      session_id: null,
    });

    await app.events.log(sessionId, `session_${newStatus}`, {
      stage: session.stage,
      actor: "system",
      data: {
        reason: error ?? "agent process exited",
        exitCode: (status as { exitCode?: number }).exitCode,
      },
    });

    logInfo("session", `status-poller: ${sessionId} -> ${newStatus}`);

    // Advance flow for multi-stage pipelines (same as Claude hook path).
    // Use mediateStageHandoff instead of raw advance() so auto-dispatch fires.
    if (newStatus === "completed") {
      if (session.orchestrator === "temporal") {
        // Under Temporal the workflow's awaitStageCompletionActivity
        // sees the "ready" we wrote above and dispatches the next stage
        // via dispatchStageActivity with the workflow's retry envelope.
        // Running the bespoke handoff here would race that.
        logDebug("status", `status_poller: ${sessionId} -> ready (Temporal workflow drives advancement)`);
      } else {
        // Bespoke path: clear error + flip back to "ready" so auto-gate
        // doesn't reject, then run the handoff which auto-dispatches the
        // next stage in-process.
        await app.sessions.update(sessionId, { status: "ready", error: null });
        try {
          await withSessionLock(sessionId, () =>
            app.sessionHooks.mediateStageHandoff(sessionId, {
              autoDispatch: true,
              source: "status_poller",
            }),
          );
        } catch (err: any) {
          // advance may fail if flow is done
          logWarn("status", `mediateStageHandoff failed for ${sessionId}: ${err?.message ?? err}`);
        }
      }
    }

    // Send OS notification
    try {
      const { sendOSNotification } = await import("../notify.js");
      const title = newStatus === "completed" ? "Agent completed" : "Agent failed";
      await sendOSNotification(`Ark: ${title}`, session.summary ?? sessionId);
    } catch {
      logDebug("status", "best-effort");
    }
  }
}

export function stopStatusPoller(app: AppContext, sessionId: string): void {
  app.statusPollers.stop(sessionId);
}

export function stopAllPollers(app: AppContext): void {
  app.statusPollers.stopAll();
}
