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
 * Apply a review-gate rejection.
 *
 * The rework-loop policy lives in `SessionReviewer.reject` (intact): if
 * `on_reject.max_rejections` is exceeded it marks the session `failed`;
 * otherwise it renders the `on_reject` prompt with `{{rejection_reason}}`,
 * bumps `rejection_count`, writes the stage-done contract
 * (`status:"ready"` + cleared `session_id`) with `rework_prompt` set, and
 * re-dispatches the stage agent for rework.
 *
 * This activity is the deterministic-workflow boundary for that policy:
 * the workflow signal handler stays a pure flag-flip; this runs the
 * non-deterministic reject (DB reads, prompt render, dispatch) and reports
 * which branch was taken so the workflow can either fail or await + re-park
 * the gate for re-review.
 */
export async function applyReviewRejectActivity(input: {
  sessionId: string;
  reason: string;
}): Promise<{ outcome: "failed" | "rework" }> {
  const d = deps();
  const app = d.app;
  if (!app) throw new Error("applyReviewRejectActivity: AppContext not wired");

  await app.sessionReviewer.reject(input.sessionId, input.reason);

  // reject() drives the row: capped -> status:"failed"; rework ->
  // status:"ready" (+rework_prompt). Read it back rather than infer from
  // the {ok,message} return, which also reports unrelated failures.
  const session = await d.sessions.get(input.sessionId);
  return { outcome: session?.status === "failed" ? "failed" : "rework" };
}
