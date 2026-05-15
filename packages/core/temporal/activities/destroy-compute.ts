import { Context } from "@temporalio/activity";
import type { OrchestrationDeps } from "../../services/deps.js";
import type { PersistedComputeHandleState } from "../../compute/types.js";
import { logInfo, logWarn } from "../../observability/structured-log.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("destroyComputeActivity: deps not injected");
  return _deps;
}

/**
 * Reap any compute (K8s pod, EC2 instance, etc.) provisioned for the
 * session. Invoked from the workflow's terminal `finally` block on every
 * exit path -- success, stage-failure return, thrown error, cancellation.
 *
 * Best-effort cleanup. Returns normally on every recoverable shape:
 *   (A) session not found            -> session row vanished, nothing to reap
 *   (B) session has no compute_handle -> never provisioned (e.g. failed in startSession)
 *   (C) handle present + compute resolves -> rehydrate, then compute.destroy()
 *   (D) compute.destroy() throws     -> swallow + log warn (e.g. "pod already gone",
 *                                       cluster unreachable). Workflow finally must
 *                                       not abort on cleanup errors.
 *   (E) compute target unresolvable  -> template row deleted; nothing to do.
 *   (F) no AppContext wired (tests)  -> early return; matches provisionCompute pattern.
 *
 * The workflow caller is expected to:
 *   - wrap the call in `CancellationScope.nonCancellable(...)` so a workflow
 *     timeout / cancel still lets the cleanup complete, and
 *   - configure the proxy with `maximumAttempts: 1` and a short
 *     startToCloseTimeout so a stuck cleanup never blocks workflow close.
 */
export async function destroyComputeActivity(input: { sessionId: string }): Promise<void> {
  const d = deps();
  // Heartbeat-guarded: only available inside a real activity context. Tests
  // call this function directly so guard the heartbeat.
  try {
    Context.current().heartbeat("destroy-start");
  } catch {
    /* test context -- no Temporal Context available */
  }

  const app = d.app;
  if (!app) {
    // F: no AppContext escape hatch wired -- match provisionCompute's
    // no-op behaviour in tests.
    return;
  }

  const baseSession = await d.sessions.get(input.sessionId);
  if (!baseSession) {
    // A: session row gone; nothing to clean.
    logInfo("temporal", `destroyComputeActivity: session ${input.sessionId} not found, skipping`, {
      sessionId: input.sessionId,
    });
    return;
  }

  // Re-scope to the session's tenant so resolveComputeTarget honours
  // (name, tenant_id) PK -- matches provisionCompute.
  const scoped =
    baseSession.tenant_id && baseSession.tenant_id !== app.tenantId ? app.forTenant(baseSession.tenant_id) : app;
  const session = (await scoped.sessions.get(input.sessionId)) ?? baseSession;

  const cfg = session.config as { compute_handle?: PersistedComputeHandleState } | null | undefined;
  const stored = cfg?.compute_handle;
  if (!stored || typeof stored.kind !== "string" || typeof stored.name !== "string") {
    // B: session never provisioned compute.
    return;
  }

  const { target } = await scoped.resolveComputeTarget(session);
  if (!target) {
    // E: compute target row deleted / unknown; pod (if any) will be
    // collected by the cluster's leak janitor or namespace TTL.
    logWarn("temporal", `destroyComputeActivity: compute target unresolved for ${input.sessionId}`, {
      sessionId: input.sessionId,
      computeKind: stored.kind,
      computeName: stored.name,
    });
    return;
  }

  // Method closures don't survive the JSON round-trip; reattach via
  // rehydrateHandle before calling destroy (same dance provisionCompute does
  // on resume).
  const rehydrated = target.compute.rehydrateHandle({
    kind: stored.kind,
    name: stored.name,
    meta: (stored.meta as Record<string, unknown> | undefined) ?? {},
  });

  // rehydrateHandle returns the handle for some compute impls and void for
  // others; either way we have a typed reference we can pass to destroy().
  const handle =
    rehydrated ??
    ({
      kind: stored.kind,
      name: stored.name,
      meta: (stored.meta as Record<string, unknown> | undefined) ?? {},
    } as any);

  try {
    await target.compute.destroy(handle);
    logInfo("temporal", `destroyComputeActivity: destroyed for ${input.sessionId}`, {
      sessionId: input.sessionId,
      computeKind: stored.kind,
      computeName: stored.name,
    });
  } catch (err) {
    // D: best-effort. K8sCompute.destroy already swallows "pod gone", but a
    // cluster-side error or AWS API blip can still bubble up. Don't let
    // cleanup failures abort the workflow finally.
    logWarn("temporal", `destroyComputeActivity: destroy failed for ${input.sessionId}, swallowing`, {
      sessionId: input.sessionId,
      computeKind: stored.kind,
      computeName: stored.name,
      err: String((err as Error)?.message ?? err),
    });
  }
}
