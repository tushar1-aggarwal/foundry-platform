/**
 * Flip a session to `failed` after a dispatch-time error, emitting a
 * `dispatch_failed` event with a full forensic error chain.
 *
 * Lenient: if the session was already marked terminal by another path the
 * status write is skipped so a more specific status (cancelled/completed)
 * is not clobbered. Shared by the Temporal-path failure callers
 * (subagents, fork-join children, on_failure retry dispatch).
 */

import type { Session, SessionStatus } from "../../../types/index.js";
import type { SessionRepository } from "../../repositories/session.js";
import type { EventRepository } from "../../repositories/event.js";
import { logWarn } from "../../observability/structured-log.js";

export async function markDispatchFailedShared(
  sessions: SessionRepository,
  events: EventRepository,
  sessionId: string,
  reason: string,
  detail?: { error?: unknown; context?: Record<string, unknown> },
): Promise<void> {
  const err = detail?.error;
  const errorObj = err instanceof Error ? err : null;
  const errorChain: Array<{ name?: string; message?: string; stack?: string }> = [];
  let cur: unknown = err;
  while (cur instanceof Error && errorChain.length < 5) {
    errorChain.push({ name: cur.name, message: cur.message, stack: cur.stack });
    cur = (cur as { cause?: unknown }).cause;
  }
  const fullData: Record<string, unknown> = { reason, ...(detail?.context ?? {}) };
  if (errorChain.length > 0) fullData.errorChain = errorChain;
  if (errorObj && (errorObj as { url?: string }).url) {
    fullData.requestUrl = (errorObj as { url?: string }).url;
    fullData.requestMethod = (errorObj as { method?: string }).method;
    fullData.requestPath = (errorObj as { path?: string }).path;
    fullData.attempts = (errorObj as { attempts?: number }).attempts;
  }

  logWarn("session", `dispatch failed for ${sessionId}: ${reason}`, {
    sessionId,
    ...fullData,
  });

  try {
    await events.log(sessionId, "dispatch_failed", { actor: "system", data: fullData });
  } catch (logErr) {
    logWarn("session", `markDispatchFailedShared: failed to log dispatch_failed event (sessionId=${sessionId})`, {
      sessionId,
      error: logErr instanceof Error ? logErr.message : String(logErr),
    });
  }
  try {
    const existing = await sessions.get(sessionId);
    if (!existing) return;
    if (existing.status === "failed" || existing.status === "completed") return;
    await sessions.update(sessionId, {
      status: "failed" as SessionStatus,
      error: reason,
    } as Partial<Session>);
  } catch (persistErr) {
    logWarn("session", `markDispatchFailedShared: failed to persist status (sessionId=${sessionId})`, {
      sessionId,
      error: persistErr instanceof Error ? persistErr.message : String(persistErr),
    });
  }
}
