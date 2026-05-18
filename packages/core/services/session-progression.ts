import type { SessionRepository } from "../repositories/session.js";
import type { EventRepository } from "../repositories/event.js";

/**
 * SessionProgression -- the out-of-workflow driver for Temporal-orchestrated
 * sessions.
 *
 * Temporal is the sole orchestrator: the running `sessionWorkflow` owns all
 * stage iteration, routing, gates and fan-out. Nothing outside the workflow
 * may mutate the stage machine directly. This service is the one cohesive
 * place that knows how to push a session forward from the outside, and it
 * replaces the bespoke in-tree StageAdvanceService entirely.
 *
 * It exposes exactly the two operations the outside world legitimately
 * needs and hides the Temporal contract behind them:
 *
 *   - `stageDone`: signal the current stage complete. The contract is
 *     `status:"ready"` + cleared `session_id`; `awaitStageCompletionActivity`
 *     polls `session.status`, treats `"ready"` as the per-stage-done signal,
 *     and the workflow advances to the next `topoOrder` stage (or completes
 *     the flow). Callers never see the magic status or the session_id rule.
 *
 *   - `handoff`: fork a session to a different agent. Not an advance -- it
 *     clones the session, records the handoff, and dispatches the clone;
 *     the original is left untouched.
 *
 * Deps-only (no AppContext); callbacks break the clone/dispatch cycle.
 */
export interface SessionProgressionDeps {
  sessions: SessionRepository;
  events: EventRepository;
  sessionClone: (
    sessionId: string,
    instructions?: string,
  ) => Promise<{ ok: boolean; sessionId?: string; message: string }>;
  dispatch: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
}

export class SessionProgression {
  constructor(private readonly deps: SessionProgressionDeps) {}

  /** Signal the session's current stage complete; the workflow advances. */
  async stageDone(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const session = await this.deps.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };
    await this.deps.sessions.update(sessionId, { status: "ready", session_id: null } as never);
    return { ok: true, message: "OK" };
  }

  /** Clone the session to a different agent, record it, dispatch the clone. */
  async handoff(
    sessionId: string,
    toAgent: string,
    instructions?: string,
  ): Promise<{ ok: boolean; message: string; sessionId?: string }> {
    const cloned = await this.deps.sessionClone(sessionId, instructions);
    if (!cloned.ok || !cloned.sessionId) return { ok: false, message: cloned.message };
    await this.deps.events.log(cloned.sessionId, "session_handoff", {
      actor: "user",
      data: { from_session: sessionId, to_agent: toAgent, instructions },
    });
    const d = await this.deps.dispatch(cloned.sessionId);
    return { ok: d.ok, message: d.message ?? "OK", sessionId: cloned.sessionId };
  }
}
