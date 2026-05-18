/**
 * SessionService -- owns session lifecycle orchestration.
 *
 * Core lifecycle methods (start, stop, resume, complete, pause, delete, undelete)
 * are fully ported. State-machine methods (applyHookStatus, applyReport) live
 * in session-orchestration.ts.
 *
 * Complex methods (dispatch, advance, fork, clone, etc.) delegate to the
 * existing session-orchestration.ts functions for now.
 */

import type { Session, SessionStatus, CreateSessionOpts, SessionOpResult } from "../../types/index.js";
import type { SessionRepository } from "../repositories/session.js";
import type { EventRepository } from "../repositories/event.js";
import type { MessageRepository } from "../repositories/message.js";
import type { AppContext } from "../app.js";
import { logDebug } from "../observability/structured-log.js";
import { ValidationError } from "./orchestrator-errors.js";

// ── SessionService ───────────────────────────────────────────────────────────

export class SessionService {
  /**
   * Factory for the Temporal client. Overridable in tests (assign a stub
   * function to `(service as any)._temporalClientFactory`) without needing
   * to monkey-patch ES module live bindings.
   */
  _temporalClientFactory: ((cfg: any) => Promise<any>) | null = null;

  constructor(
    private sessions: SessionRepository,
    private events: EventRepository,
    private messages: MessageRepository,
    private readonly _app: AppContext | null = null,
  ) {}

  private get app(): AppContext {
    if (!this._app) {
      throw new Error("SessionService: AppContext required for this method -- pass app to the constructor");
    }
    return this._app;
  }

  // ── Core lifecycle (fully ported) ─────────────────────────────────────────

  /**
   * Create a new session with sensible defaults.
   * Port of session.ts startSession() -- simplified: no flow-stage resolution,
   * no telemetry, no OTLP spans (those belong at the orchestration layer above).
   */
  async start(opts: CreateSessionOpts): Promise<Session> {
    // RF-5: reject inline attachment bytes -- callers must upload to BlobStore first.
    if (opts.attachments?.some((a: any) => a.content && !a.locator)) {
      throw new ValidationError(
        "startSession: attachment.content is not allowed; upload to BlobStore and pass locator instead",
      );
    }

    // compute_name fallback: explicit arg > "local". Mirrors the
    // service-level default in `services/session/create.ts` so every
    // path through `sessionService.start` lands in the DB with a
    // non-null compute_name (the compute panel filter relies on this).
    // Tests that need the legacy NULL behaviour go through
    // `app.sessions.create()` directly. See #472.
    const app = this._app;

    // Per-stage-pod invariant: in hosted mode `local` compute would execute
    // the agent in-process on the control-plane / temporal-worker pod with
    // zero isolation (it competes with the control plane for resources and
    // breaks the "one pod per flow stage" model). Reject early and loudly
    // instead of silently running it in the worker.
    const effectiveComputeName = opts.compute_name ?? "local";
    if (app !== null && app.mode.kind === "hosted" && effectiveComputeName === "local") {
      throw new ValidationError(
        `Hosted mode requires an explicit non-local compute_name -- 'local' would run the agent ` +
          `inside the control-plane/temporal-worker pod with zero isolation. Pass a registered ` +
          `compute target (k8s / ec2 / docker / firecracker).`,
      );
    }

    const session = await this.sessions.create({
      ...opts,
      compute_name: effectiveComputeName,
      orchestrator: "temporal",
    });

    // Apply agent override if specified
    if (opts.agent) {
      await this.sessions.update(session.id, { agent: opts.agent } as Partial<Session>);
    }

    // Log creation event
    await this.events.log(session.id, "session_created", {
      actor: "system",
      data: {
        flow: opts.flow ?? "default",
        repo: opts.repo ?? null,
        agent: opts.agent ?? null,
      },
    });

    // Temporal is the sole orchestrator: the session-workflow loop drives
    // every stage via dispatchStageActivity. There is no bespoke fallback.
    await this.startSessionWorkflow(session.id, `session-${session.id}`, (opts as any).flow ?? "default");
    return (await this.sessions.get(session.id))!;
  }

  /**
   * Stop a session. Idempotent -- already-stopped/completed/failed returns ok.
   * When a running process exists (session_id set) and orchestration is available,
   * delegates for proper tmux/provider cleanup. Otherwise does a local state transition.
   */
  async stop(id: string, opts?: { force?: boolean }): Promise<SessionOpResult> {
    const session = await this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    // Idempotent: already in terminal state with no running process
    if (!opts?.force && ["stopped", "completed", "failed"].includes(session.status) && !session.session_id) {
      return { ok: true, message: "OK", sessionId: id };
    }

    await this.terminateTemporalWorkflowIfAny(session, "user stopped");

    // If there's a running process and AppContext is available, delegate to
    // orchestration for full cleanup (tmux kill, provider cleanup, hooks removal)
    if (session.session_id) {
      try {
        return await this.app.sessionTerminator.stop(id, opts);
      } catch {
        logDebug("session", "AppContext not available (e.g. unit tests) -- fall through to local stop");
      }
    }

    // Local state transition -- no process cleanup needed (or not available)
    await this.sessions.update(id, {
      status: "stopped" as SessionStatus,
      error: null,
      session_id: null,
    } as Partial<Session>);
    await this.events.log(id, "session_stopped", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: { session_id: session.session_id, agent: session.agent },
    });

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Terminate the Temporal workflow tied to a session, if any. Best-effort:
   * swallows "workflow not found / already-terminal" errors. Called on
   * stop/delete so a session row going to a terminal state takes its
   * workflow with it instead of leaking a Running execution in Temporal.
   */
  private async terminateTemporalWorkflowIfAny(session: Session, reason: string): Promise<void> {
    if (session.orchestrator !== "temporal" || !session.workflow_id) return;
    try {
      const factory = this._temporalClientFactory ?? (await import("../temporal/client.js")).getTemporalClient;
      const client = await factory(this.app.config.temporal);
      const handle = client.workflow.getHandle(session.workflow_id);
      await handle.terminate(reason);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      // Already-terminal / not-found are expected and harmless.
      if (/not found|already (?:terminat|complet|cancel|fail)/i.test(msg)) return;
      logDebug("session", `terminateTemporalWorkflowIfAny: ${session.workflow_id} -- ${msg}`);
    }
  }

  /**
   * Start the Temporal session-workflow for a session and persist its
   * workflow id/run id. Shared by `start()` (fresh) and `resume()` (a new
   * workflow id since the prior one was terminated/completed).
   */
  private async startSessionWorkflow(sessionId: string, workflowId: string, flowName: string): Promise<void> {
    const app = this.app;
    const { getTemporalClient } = await import("../temporal/client.js");
    const factory = this._temporalClientFactory ?? getTemporalClient;
    const client = await factory(app.config.temporal);
    const handle = await client.workflow.start("sessionWorkflow", {
      taskQueue: `ark.${app.tenantId ?? "default"}.stages`,
      workflowId,
      // Hard wall-clock cap so a stuck workflow eventually closes itself.
      // Without this, an orphan (worker crash, stop() that didn't terminate,
      // signal that never arrives) stays Running until namespace retention.
      workflowExecutionTimeout: (app.config.temporal?.workflowExecutionTimeout ?? "24h") as any,
      args: [{ sessionId, tenantId: app.tenantId ?? "default", flowName }],
    });
    await this.sessions.update(sessionId, {
      workflow_id: workflowId,
      workflow_run_id: handle.firstExecutionRunId,
    } as Partial<Session>);
  }

  /**
   * Start the Temporal session-workflow for an already-created session row
   * (subagents / fan-out children whose row is built outside `start()`).
   */
  async startWorkflowFor(sessionId: string, flowName: string): Promise<void> {
    await this.startSessionWorkflow(sessionId, `session-${sessionId}`, flowName);
  }

  /**
   * Stop all running sessions. Used during test teardown and hosted shutdown.
   * Goes through the proper stop sequence for each (provider kill + cleanup).
   *
   * IMPORTANT: callers (AppContext.shutdown) must await this BEFORE closing the
   * underlying database. Previously the sync `app.sessions.list({})` call was
   * scheduled after the DB was already closed in some shutdown orderings,
   * producing the "Cannot use a closed database" stderr noise across tests.
   * Now `list({})` is a real promise that resolves against the live db, and
   * we swallow + log a warn if the db has already been closed -- shutdown is
   * best-effort.
   */
  async stopAll(): Promise<void> {
    let all: Session[] = [];
    try {
      all = await this.sessions.list({});
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      // Tolerate the race where shutdown teardown raced ahead of stopAll.
      if (/closed/i.test(msg) || /database/i.test(msg)) {
        logDebug("session", `stopAll: db already closed, skipping (${msg})`);
        return;
      }
      throw err;
    }
    if (all.length === 0) return;
    for (const s of all) {
      if (s.session_id) {
        try {
          await this.app.sessionTerminator.stop(s.id, { force: true });
        } catch (err: any) {
          logDebug("session", `stopAll: ${s.id}: ${err?.message ?? err}`);
        }
      }
    }
  }

  /**
   * Persist a session input blob and return an opaque locator callers should
   * store in `session.config.inputs.files[<role>]`. The locator is then fed
   * back through `input/read` (or decoded server-side) to retrieve the bytes.
   *
   * Backend selection is driven by config: local profile -> on-disk under
   * `{arkDir}/blobs/<tenantId>/inputs/<id>/<filename>`, control-plane
   * profile -> S3 under `{prefix}/<tenantId>/inputs/<id>/<filename>`.
   *
   * The return shape changed from `{ path }` to `{ locator }` on purpose --
   * the old filesystem path leaked arkDir and broke past a single replica.
   */
  async saveInput(opts: {
    name: string;
    role: string;
    content: string;
    contentEncoding?: "base64" | "utf-8";
  }): Promise<{ locator: string }> {
    const { basename } = await import("path");
    const { LOCAL_TENANT_ID } = await import("../storage/blob-store.js");
    const safeName = basename(opts.name).replace(/[^\w.\-]/g, "_");
    const safeRole = opts.role.replace(/[^\w.\-]/g, "_");
    const encoding = opts.contentEncoding ?? "utf-8";
    const bytes = encoding === "base64" ? Buffer.from(opts.content, "base64") : Buffer.from(opts.content, "utf-8");

    const tenantId = this.app.tenantId ?? LOCAL_TENANT_ID;
    const id = `${Date.now().toString(36)}-${safeRole}`;
    const meta = await this.app.blobStore.put({ tenantId, namespace: "inputs", id, filename: safeName }, bytes);
    return { locator: meta.locator };
  }

  /**
   * Resume a stopped/failed session: clear runtime state, mark ready, and
   * kick a *background* dispatch so the current stage starts running again.
   * The earlier "does NOT auto-dispatch" port left the RPC caller to kick
   * dispatch manually, but nobody did -- the Restart button in the UI just
   * flipped status back to "ready" and the session sat idle forever.
   *
   * Kicking in the background (rather than awaiting dispatch) matches the
   * `session_created` -> default-dispatcher contract: the RPC returns
   * immediately with status="ready", and the session flips to "running"
   * once the launcher lands. Tests that assert `status === "ready"`
   * straight after the RPC still pass.
   *
   * Killing any lingering executor handle first keeps a zombie tmux session
   * from holding the claude session-id across a resume.
   */
  async resume(id: string, opts?: { rewindToStage?: string }): Promise<SessionOpResult> {
    const session = await this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    // Rewind allows re-running a completed session from any stage. Without a
    // rewind, completed sessions stay blocked -- there's nothing meaningful to
    // "resume" since the flow already terminated.
    if (session.status === "completed" && !opts?.rewindToStage) {
      return {
        ok: false,
        message: "Session is already completed. Pick a stage to restart from.",
      };
    }
    if (session.status === "running" && session.session_id) {
      return { ok: false, message: "Already running" };
    }

    if (session.session_id) {
      // Best-effort kill across every registered executor -- the handle is
      // an opaque string that only the owning executor knows how to clean
      // up (tmux session name for claude-code, `sdk-<id>` for agent-sdk,
      // etc.). A missing/dead handle after a crash is expected on resume.
      const handle = session.session_id;
      for (const entry of this.app.pluginRegistry.listByKind("executor")) {
        try {
          await entry.impl.kill(handle);
        } catch (err: any) {
          // try next executor -- only the owning executor knows the handle
          logDebug("session", `kill via executor '${entry.name}' failed: ${err?.message ?? err}`);
        }
      }
    }

    // Apply rewind updates: reset stage, wipe the claude conversation id so the
    // agent starts fresh, drop pr_url (so `create_pr` doesn't skip on a rerun),
    // and clear any cached flow-graph state (completed-stage tracking) so the
    // DAG orchestrator doesn't auto-skip already-completed successors.
    const targetStage = opts?.rewindToStage ?? session.stage ?? null;
    const rewinding = !!opts?.rewindToStage && opts.rewindToStage !== session.stage;

    const updates: Partial<Session> = {
      status: "ready" as SessionStatus,
      error: null,
      breakpoint_reason: null,
      attached_by: null,
      session_id: null,
    };
    if (rewinding) {
      updates.stage = targetStage;
      updates.claude_session_id = null;
      updates.pr_url = null;
      const cfg = { ...(session.config ?? {}) } as Record<string, unknown>;
      delete cfg.last_snapshot_id;
      updates.config = cfg;

      // The DAG orchestrator persists completed-stage tracking in the
      // flow_state table. If that row survives the rewind, `getReadyStages`
      // sees every stage as already-completed and the flow stalls at a
      // phantom join-barrier -- the agent runs, finishes, and the DAG
      // refuses to advance because it thinks all successors have already
      // run. Delete the row so the rewind truly starts over.
      try {
        await this.app.flowStates.delete(id);
      } catch {
        logDebug("session", "flow-state delete is best-effort");
      }
    }
    await this.sessions.update(id, updates);

    await this.events.log(id, "session_resumed", {
      stage: targetStage ?? undefined,
      actor: "user",
      data: {
        from_status: session.status,
        ...(rewinding ? { rewound_to: targetStage, from_stage: session.stage } : {}),
      },
    });

    // Restart the Temporal session-workflow: the prior workflow was
    // terminated (stop/fail/delete) or completed, so re-running the flow
    // means starting a fresh execution. The workflow loop drives both agent
    // and action stages via dispatchStageActivity -- there is no in-process
    // resume routing. A run-suffixed workflow id avoids colliding with the
    // terminated/closed prior execution that still carries `session-<id>`.
    await this.terminateTemporalWorkflowIfAny(session, "resumed -- restarting workflow");
    await this.startSessionWorkflow(id, `session-${id}-r${Date.now().toString(36)}`, session.flow);

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Mark session as completed.
   * Port of session.ts complete() -- simplified: just marks ready + logs event.
   * The advance() call is the caller's responsibility.
   */
  async complete(id: string): Promise<SessionOpResult> {
    const session = await this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    await this.events.log(id, "stage_completed", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: { note: "Manually completed" },
    });

    await this.messages.markRead(id);
    await this.sessions.update(id, { status: "ready" as SessionStatus, session_id: null } as Partial<Session>);

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Pause a session (set to blocked).
   * Port of session.ts pause().
   */
  async pause(id: string, reason?: string): Promise<SessionOpResult> {
    const session = await this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    await this.sessions.update(id, {
      status: "blocked" as SessionStatus,
      breakpoint_reason: reason ?? "User paused",
    } as Partial<Session>);

    await this.events.log(id, "session_paused", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: { reason, was_status: session.status },
    });

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Soft-delete a session (90s undo window).
   * Port of session.ts deleteSessionAsync() -- simplified: no tmux/provider
   * cleanup (caller handles), just state transition.
   */
  async delete(id: string): Promise<SessionOpResult> {
    const session = await this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    await this.terminateTemporalWorkflowIfAny(session, "session deleted");
    await this.sessions.softDelete(id);

    await this.events.log(id, "session_deleted", { actor: "user" });

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Restore a soft-deleted session.
   * Port of session.ts undeleteSessionAsync().
   */
  async undelete(id: string): Promise<SessionOpResult> {
    const restored = await this.sessions.undelete(id);
    if (!restored) return { ok: false, message: `Session ${id} not found or not deleted` };

    await this.events.log(id, "session_undeleted", { actor: "user" });

    return { ok: true, message: "OK", sessionId: id };
  }

  /**
   * Send a message to a running session's tmux pane.
   */
  async send(id: string, message: string): Promise<SessionOpResult> {
    const { send: legacySend } = await import("./session-output.js");
    const { depsFromApp } = await import("./deps.js");
    return legacySend(depsFromApp(this.app), id, message);
  }

  /**
   * Approve a review gate and force-advance past it.
   *
   * When the session uses Temporal orchestration, sends an `approveReviewGate`
   * signal to the running workflow instead of calling the legacy helper.
   */
  async approveReviewGate(id: string): Promise<SessionOpResult> {
    const session = await this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    if (session.orchestrator === "temporal") {
      if (!session.workflow_id) {
        return { ok: false, message: `Session ${id} has no workflow_id -- cannot send Temporal signal` };
      }
      const factory = this._temporalClientFactory ?? (await import("../temporal/client.js")).getTemporalClient;
      const client = await factory(this.app.config.temporal);
      const handle = client.workflow.getHandle(session.workflow_id);
      await handle.signal("approveReviewGate", { sessionId: id });
      return { ok: true, message: "OK", sessionId: id };
    }

    const { approveReviewGate: legacyApprove } = await import("./review-gate.js");
    return legacyApprove(this.app, id);
  }

  /**
   * Reject a review gate and dispatch a rework cycle. Renders `on_reject.prompt`
   * (with `{{rejection_reason}}` substituted) and appends it to the next
   * dispatch of the current stage. When `on_reject.max_rejections` is
   * exceeded, the session is marked failed instead.
   *
   * When the session uses Temporal orchestration, sends a `rejectReviewGate`
   * signal to the running workflow instead of calling the legacy helper.
   */
  async rejectReviewGate(id: string, reason: string): Promise<SessionOpResult> {
    const session = await this.sessions.get(id);
    if (!session) return { ok: false, message: `Session ${id} not found` };

    if (session.orchestrator === "temporal") {
      if (!session.workflow_id) {
        return { ok: false, message: `Session ${id} has no workflow_id -- cannot send Temporal signal` };
      }
      const factory = this._temporalClientFactory ?? (await import("../temporal/client.js")).getTemporalClient;
      const client = await factory(this.app.config.temporal);
      const handle = client.workflow.getHandle(session.workflow_id);
      await handle.signal("rejectReviewGate", { sessionId: id, reason: reason ?? "" });
      return { ok: true, message: "OK", sessionId: id };
    }

    const { rejectReviewGate: legacyReject } = await import("./review-gate.js");
    const r = await legacyReject(this.app, id, reason ?? "");
    // review-gate returns { ok, message } without sessionId; widen to SessionOpResult.
    return { ...r, sessionId: id } as SessionOpResult;
  }

  // ── Query helpers ─────────────────────────────────────────────────────────

  get(id: string): Promise<Session | null> {
    return this.sessions.get(id);
  }

  list(filters?: Parameters<SessionRepository["list"]>[0]): Promise<Session[]> {
    return this.sessions.list(filters);
  }
}
