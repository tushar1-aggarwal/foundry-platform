import type { SessionRepository } from "../repositories/session.js";
import type { EventRepository } from "../repositories/event.js";

/** Drives a Temporal session forward from outside the workflow. */
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

  async stageDone(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const session = await this.deps.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };
    // status:"ready" + null session_id is the signal awaitStageCompletionActivity polls.
    await this.deps.sessions.update(sessionId, { status: "ready", session_id: null } as never);
    return { ok: true, message: "OK" };
  }

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
