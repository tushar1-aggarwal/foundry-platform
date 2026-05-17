/**
 * Review-gate wrappers -- inject `advance` / `dispatch` deps into the
 * `approve` / `reject` primitives on `SessionReviewer`.
 *
 * SessionReviewer exposes gate primitives that accept an `advance` /
 * `dispatch` override so the service layer (and tests) can substitute
 * their own; the production wrappers here thread in the real module-level
 * `advance` and `dispatch` functions.
 */

import type { AppContext } from "../app.js";

export async function approveReviewGate(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  return app.sessionReviewer.approve(sessionId, (id, force) => app.stageAdvance.advance(id, force));
}

export async function rejectReviewGate(
  app: AppContext,
  sessionId: string,
  reason: string,
): Promise<{ ok: boolean; message: string }> {
  return app.sessionReviewer.reject(sessionId, reason, (id) => app.dispatchService.dispatch(id));
}
