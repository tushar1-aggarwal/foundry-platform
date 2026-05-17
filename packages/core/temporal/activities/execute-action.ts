import type { OrchestrationDeps } from "../../services/deps.js";
import { executeAction } from "../../services/actions/index.js";
import { dispatchValidationError } from "../errors.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("executeActionActivity: deps not injected");
  return _deps;
}

/**
 * Execute a non-agent action stage (create_pr, merge, close, flaky_pr, ...).
 *
 * Phase 3.8: wires the bespoke executeAction() through the Temporal worker.
 * Uses Phase 3.6's d.app escape hatch -- worker.ts boots its own AppContext
 * and injects it via depsFromApp, so executeAction sees the full surface it
 * expects without a signature refactor.
 *
 * Idempotency: executeAction wraps in withIdempotency(db, op_kind, key) keyed
 * on `action:<handler.name>`. Temporal's at-least-once retry is safe because
 * the ledger inside executeAction dedupes.
 *
 * Error classification: dispatchValidationError marks the failure non-retryable
 * so the workflow surfaces it immediately instead of churning the retry budget.
 * Other errors bubble unchanged so Temporal's RetryPolicy retries them.
 */
export async function executeActionActivity(input: {
  sessionId: string;
  stageIdx: number;
  action?: string;
}): Promise<void> {
  const d = deps();

  if (!input.action) return; // No action specified -- forward-compat no-op.

  if (!d.app) {
    throw dispatchValidationError(
      "executeActionActivity: OrchestrationDeps.app is required for action stages. " +
        "Boot worker via depsFromApp(app) so the AppContext is exposed.",
    );
  }

  const idempotencyKey = `${input.sessionId}:${input.stageIdx}:${input.action}`;

  try {
    const result = await executeAction(d, input.sessionId, input.action, { idempotencyKey });
    if (!result.ok) {
      throw dispatchValidationError(`Action '${input.action}' failed: ${result.message}`);
    }
    // Observable success signal -- without this, the activity has no externally
    // visible difference between "stub returned" and "real handler ran". Inner
    // executeAction emits action_skipped only for the unknown-action bypass.
    await d.events.log(input.sessionId, "action_executed", {
      actor: "system",
      data: {
        action: input.action,
        stageIdx: input.stageIdx,
        message: result.message,
      },
    });
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    if (/validation|not found|unknown action|missing prereq/i.test(msg)) {
      throw dispatchValidationError(msg);
    }
    throw e;
  }
}
