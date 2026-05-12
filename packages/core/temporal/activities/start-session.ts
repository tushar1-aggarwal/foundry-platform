import type { SessionWorkflowInput, StartSessionResult } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("startSessionActivity: deps not injected");
  return _deps;
}

/**
 * Initialize the workflow's bookkeeping around an existing session row.
 * The row + `session_created` event were already written by
 * `SessionService.start()` before the workflow was scheduled; we re-emitted
 * them here in an earlier iteration and that produced a duplicate event
 * which broke the "structurally identical events projection" invariant
 * (spec section 7, T1). The activity now only verifies the row exists
 * (workflow input is the source of truth for everything downstream).
 */
export async function startSessionActivity(input: SessionWorkflowInput): Promise<StartSessionResult> {
  const d = deps();
  const session = await d.sessions.get(input.sessionId);
  if (!session) {
    throw new Error(`startSessionActivity: session ${input.sessionId} not found`);
  }
  return { sessionId: input.sessionId };
}
