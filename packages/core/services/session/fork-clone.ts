/**
 * SessionForker -- fork + clone.
 * Extracted from the old session-lifecycle.ts.
 */

import type { Session } from "../../../types/index.js";
import type { SessionLifecycleDeps, SessionOpResult } from "./types.js";

export class SessionForker {
  constructor(private readonly deps: SessionLifecycleDeps) {}

  /** Start the Temporal session-workflow for a freshly created child row. */
  private async startWorkflow(childId: string, flowName: string): Promise<void> {
    const tenantId = this.deps.sessions.getTenant?.() ?? "default";
    const { workflowId, runId } = await this.deps.startTemporalWorkflow(childId, flowName, tenantId);
    await this.deps.sessions.update(childId, {
      workflow_id: workflowId,
      workflow_run_id: runId,
    } as Partial<Session>);
  }

  /**
   * Fork: shallow copy -- same compute, repo, flow, group. Fresh session, no resume.
   */
  async fork(sessionId: string, newName?: string): Promise<SessionOpResult> {
    const d = this.deps;
    const original = await d.sessions.get(sessionId);
    if (!original) return { ok: false, message: `Session ${sessionId} not found` };

    const baseName = original.summary || sessionId;
    const fork = await d.sessions.create({
      ticket: original.ticket || undefined,
      summary: newName ?? `${baseName} (fork)`,
      repo: original.repo || undefined,
      flow: original.flow,
      compute_name: original.compute_name || undefined,
      workdir: original.workdir || undefined,
      orchestrator: "temporal",
    });

    await d.sessions.update(fork.id, {
      stage: original.stage,
      status: "ready",
      group_name: original.group_name,
    });

    await d.events.log(fork.id, "session_forked", {
      stage: original.stage,
      actor: "user",
      data: { forked_from: sessionId },
    });

    await this.startWorkflow(fork.id, original.flow);
    return { ok: true, message: "OK", sessionId: fork.id };
  }

  /**
   * Clone: deep copy -- same as fork PLUS claude_session_id for --resume.
   * The new session will resume the same Claude conversation.
   */
  async clone(sessionId: string, newName?: string): Promise<SessionOpResult> {
    const d = this.deps;
    const original = await d.sessions.get(sessionId);
    if (!original) return { ok: false, message: `Session ${sessionId} not found` };

    const baseName = original.summary || sessionId;
    const clone = await d.sessions.create({
      ticket: original.ticket || undefined,
      summary: newName ?? `${baseName} (clone)`,
      repo: original.repo || undefined,
      flow: original.flow,
      compute_name: original.compute_name || undefined,
      workdir: original.workdir || undefined,
      orchestrator: "temporal",
    });

    await d.sessions.update(clone.id, {
      stage: original.stage,
      status: "ready",
      group_name: original.group_name,
      claude_session_id: original.claude_session_id,
    });

    await d.events.log(clone.id, "session_cloned", {
      stage: original.stage,
      actor: "user",
      data: { cloned_from: sessionId, claude_session_id: original.claude_session_id },
    });

    await this.startWorkflow(clone.id, original.flow);
    return { ok: true, message: "OK", sessionId: clone.id };
  }
}
