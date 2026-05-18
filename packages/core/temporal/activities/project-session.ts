import type { ProjectionInput } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";
import { projectLifecycle } from "./project-lifecycle.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("projectSessionActivity: deps not injected");
  return _deps;
}

/**
 * Project a session-level lifecycle transition. Thin delegation to the
 * single projection seam (project-lifecycle.ts), which applies the row
 * change AND emits the terminal lifecycle event (session_completed /
 * session_failed) so row and event can't diverge.
 */
export async function projectSessionActivity(input: ProjectionInput): Promise<void> {
  await projectLifecycle(deps(), {
    sessionId: input.sessionId,
    scope: "session",
    patch: input.patch,
  });
}
