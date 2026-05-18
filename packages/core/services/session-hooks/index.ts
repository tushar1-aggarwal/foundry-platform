/**
 * SessionHooks -- inbound event processing (hook status, channel reports,
 * failure retries). Composes the hook-status + report appliers over a
 * shared `SessionHooksDeps` cradle-slice. Stage advancement is driven by
 * the Temporal session-workflow, not here.
 */

import type { Session, SessionStatus } from "../../../types/index.js";
import type { OutboundMessage } from "../channel/channel-types.js";
import { HookStatusApplier } from "./hook-status.js";
import { ReportApplier } from "./report.js";
import type { HookStatusResult, ReportResult, SessionHooksDeps } from "./types.js";

export type { HookStatusResult, ReportResult, SessionHooksDeps } from "./types.js";
export { parseOnFailure } from "./types.js";

export class SessionHooks {
  private readonly hookStatus: HookStatusApplier;
  private readonly report: ReportApplier;

  constructor(private readonly deps: SessionHooksDeps) {
    this.hookStatus = new HookStatusApplier(deps);
    this.report = new ReportApplier(deps);
  }

  /**
   * Pure decision step: returns the updates+events+flags the caller would
   * have applied. Exposed for tests and callers that need to inspect the
   * computed plan without performing I/O. Production code paths should
   * prefer `ingestHookStatus`, which applies the plan itself.
   */
  applyHookStatus(session: Session, hookEvent: string, payload: Record<string, unknown>): Promise<HookStatusResult> {
    return this.hookStatus.apply(session, hookEvent, payload);
  }

  /** Pure decision step for channel reports. See `applyHookStatus` rationale. */
  applyReport(sessionId: string, report: OutboundMessage): Promise<ReportResult> {
    return this.report.apply(sessionId, report);
  }

  /**
   * Decide + persist a hook-status event: runs the applier and immediately
   * commits the mechanical side-effects (event log entries, session
   * updates, mark-as-read). Returns the decision so callers can run the
   * remaining cross-cutting work (bus emit, span end, retry-dispatch,
   * stage handoff, terminal cleanup).
   */
  async ingestHookStatus(
    session: Session,
    hookEvent: string,
    payload: Record<string, unknown>,
  ): Promise<HookStatusResult> {
    const result = await this.hookStatus.apply(session, hookEvent, payload);
    for (const evt of result.events ?? []) {
      await this.deps.events.log(session.id, evt.type, evt.opts);
    }
    if (result.updates) {
      await this.deps.sessions.update(session.id, result.updates);
    }
    if (result.markRead) {
      await this.deps.messages.markRead(session.id);
    }
    return result;
  }

  /**
   * Decide + persist a channel report: runs the applier and commits the
   * mechanical side-effects (event log entries, message send, session
   * updates, artifact tracking). Returns the decision so callers can run
   * the remaining cross-cutting work (bus emit, retry-dispatch, stage
   * handoff, OS notification, auto-PR).
   */
  async ingestReport(sessionId: string, report: OutboundMessage): Promise<ReportResult> {
    const result = await this.report.apply(sessionId, report);
    for (const evt of result.logEvents ?? []) {
      await this.deps.events.log(sessionId, evt.type, evt.opts);
    }
    if (result.message) {
      await this.deps.messages.send(sessionId, result.message.role, result.message.content, result.message.type);
    }
    if (Object.keys(result.updates).length > 0) {
      await this.deps.sessions.update(sessionId, result.updates);
    }
    await this.persistReportArtifacts(sessionId, report, result.prUrl);
    return result;
  }

  /**
   * Artifact recording is best-effort: a single bad value (e.g. a malformed
   * filesChanged entry) must not abort the rest of the ingest pipeline,
   * which already wrote the events and updates. Errors are swallowed --
   * the caller's structured-log channel captures them.
   */
  private async persistReportArtifacts(
    sessionId: string,
    report: OutboundMessage,
    prUrl: string | undefined,
  ): Promise<void> {
    try {
      const r = report as unknown as Record<string, unknown>;
      if (prUrl) {
        await this.deps.artifacts.add(sessionId, "pr", [prUrl]);
      }
      if (Array.isArray(r.filesChanged) && r.filesChanged.length > 0) {
        await this.deps.artifacts.add(sessionId, "file", r.filesChanged as string[]);
      }
      if (Array.isArray(r.commits) && r.commits.length > 0) {
        await this.deps.artifacts.add(sessionId, "commit", r.commits as string[]);
      }
      if (report.type === "completed") {
        const s = await this.deps.sessions.get(sessionId);
        if (s?.branch) await this.deps.artifacts.add(sessionId, "branch", [s.branch]);
      }
    } catch {
      /* artifact tracking is best-effort; main ingest path already committed */
    }
  }

  /**
   * Reset a failed session to `ready` for re-dispatch, gated on max retries.
   * Stage advancement itself is driven by the Temporal session-workflow loop;
   * this only flips a failed session back to `ready` so the workflow's next
   * dispatchStageActivity can re-run the current stage.
   */
  async retryWithContext(sessionId: string, opts?: { maxRetries?: number }): Promise<{ ok: boolean; message: string }> {
    const { sessions, events } = this.deps;
    const s = await sessions.get(sessionId);
    if (!s) return { ok: false, message: "Session not found" };
    if (s.status !== "failed") return { ok: false, message: "Session is not in failed state" };

    const maxRetries = opts?.maxRetries ?? 3;
    const priorRetries = (await events.list(sessionId)).filter((e) => e.type === "retry_with_context").length;
    if (priorRetries >= maxRetries) {
      return { ok: false, message: `Max retries (${maxRetries}) reached` };
    }

    await events.log(sessionId, "retry_with_context", {
      actor: "system",
      data: { attempt: priorRetries + 1, error: s.error, stage: s.stage },
    });

    await sessions.update(sessionId, { status: "ready" as SessionStatus, error: null } as Partial<Session>);

    return { ok: true, message: `Retry ${priorRetries + 1}/${maxRetries} queued` };
  }
}
