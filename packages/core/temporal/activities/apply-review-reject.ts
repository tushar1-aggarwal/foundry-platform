import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("applyReviewRejectActivity: deps not injected");
  return _deps;
}

/**
 * Runs the rework-loop policy (SessionReviewer.reject) off the workflow so
 * the signal handler stays deterministic; reports which branch was taken.
 */
export async function applyReviewRejectActivity(input: {
  sessionId: string;
  reason: string;
}): Promise<{ outcome: "failed" | "rework" }> {
  const d = deps();
  const app = d.app;
  if (!app) throw new Error("applyReviewRejectActivity: AppContext not wired");

  await app.sessionReviewer.reject(input.sessionId, input.reason);

  // Read the row back: reject()'s {ok} also reports unrelated failures.
  const session = await d.sessions.get(input.sessionId);
  return { outcome: session?.status === "failed" ? "failed" : "rework" };
}
