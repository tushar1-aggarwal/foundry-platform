import { Context } from "@temporalio/activity";
import type { OrchestrationDeps } from "../../services/deps.js";
import type { ComputeHandle, PersistedComputeHandleState } from "../../compute/types.js";
import { logInfo, logWarn } from "../../observability/structured-log.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("provisionComputeActivity: deps not injected");
  return _deps;
}

/**
 * Provision compute for a session stage.
 *
 * Phase 3: ports `services/dispatch/target-resolver.resolveTargetAndHandle`
 * into the Temporal activity boundary. Idempotent on session id:
 *
 *   1. Persisted handle  -> rehydrate via `Compute.rehydrateHandle`. This
 *      is the second-stage / resume path; method closures don't survive
 *      the DB round-trip so we re-attach them here.
 *   2. attachExistingHandle -> for "live" persistent computes (LocalCompute
 *      always; EC2Compute against a row with instance_id). Skips a redundant
 *      provision call.
 *   3. fresh provision -> `target.provision({ config })`. Persists the
 *      resulting handle (kind/name/meta only, no methods) on
 *      `session.config.compute_handle` so the next stage of this session
 *      rehydrates instead of re-provisioning.
 *
 * Session has no compute target (e.g. hosted-mode default with no
 * compute_name and no AppMode default): activity is a no-op. The
 * dispatcher will surface the missing-target case downstream.
 *
 * No-compute fallback (e.g. local mode + LocalCompute): the input's
 * `computeName: "local"` argument is the workflow's Phase 1 default;
 * this activity now reads `session.compute_name` and ignores that input.
 */
export async function provisionComputeActivity(input: { sessionId: string; computeName: string }): Promise<void> {
  const d = deps();
  Context.current().heartbeat("provision-start");

  const app = d.app;
  if (!app) {
    // No AppContext escape hatch wired (test profile) -- preserve Phase 1
    // no-op behaviour so unit tests that don't need real provisioning keep
    // passing.
    void input;
    return;
  }

  const baseSession = await d.sessions.get(input.sessionId);
  if (!baseSession) {
    throw new Error(`provisionComputeActivity: session ${input.sessionId} not found`);
  }
  // Re-scope to the session's tenant so compute lookup honours
  // (name, tenant_id) PK. resolveComputeTarget re-scopes internally too,
  // but doing it here keeps the rest of the activity tenant-correct.
  const scoped =
    baseSession.tenant_id && baseSession.tenant_id !== app.tenantId ? app.forTenant(baseSession.tenant_id) : app;
  const session = (await scoped.sessions.get(input.sessionId)) ?? baseSession;

  const { target, compute } = await scoped.resolveComputeTarget(session);
  if (!target) {
    // No target resolved: hosted mode with no compute_name, or unknown
    // compute_name. Dispatch will surface this cleanly downstream.
    logInfo("temporal", `provisionComputeActivity: no compute target for session ${input.sessionId}`, {
      sessionId: input.sessionId,
      computeName: session.compute_name ?? null,
    });
    return;
  }

  Context.current().heartbeat("target-resolved");

  // 1. Persisted-handle rehydrate -- second-stage / resume path.
  const cfg = session.config as { compute_handle?: PersistedComputeHandleState } | null | undefined;
  const stored = cfg?.compute_handle;
  if (stored && typeof stored.kind === "string" && typeof stored.name === "string") {
    target.compute.rehydrateHandle({
      kind: stored.kind,
      name: stored.name,
      meta: (stored.meta as Record<string, unknown> | undefined) ?? {},
    });
    logInfo("temporal", `provisionComputeActivity: rehydrated handle for ${input.sessionId}`, {
      sessionId: input.sessionId,
      computeKind: stored.kind,
      computeName: stored.name,
    });
    return;
  }

  // 2. attachExistingHandle -- fast path for live persistent computes.
  if (compute && target.compute.attachExistingHandle) {
    const existing = target.compute.attachExistingHandle({
      name: compute.name,
      status: compute.status,
      config: (compute.config as Record<string, unknown> | null) ?? {},
    });
    if (existing) {
      await persistHandleState(scoped, session.id, existing);
      logInfo("temporal", `provisionComputeActivity: attached existing for ${input.sessionId}`, {
        sessionId: input.sessionId,
        computeKind: existing.kind,
        computeName: existing.name,
      });
      return;
    }
  }

  // 3. Fresh provision -- template computes (k8s, firecracker) where each
  // session gets its own instance. K8sCompute.provision waits up to 2 min
  // for pod Running + 1 min for arkd reachable; the workflow's 60s
  // heartbeatTimeout would otherwise kill the activity on cold-image
  // pulls. Keep a 15s ticker running so Temporal sees us alive throughout.
  Context.current().heartbeat("calling-provision");
  const ticker = setInterval(() => {
    try {
      Context.current().heartbeat("provision-in-progress");
    } catch {
      /* activity context torn down -- ticker will be cleared in finally */
    }
  }, 15_000);
  let handle: ComputeHandle;
  try {
    handle = await target.provision({
      config: (compute?.config as Record<string, unknown> | undefined) ?? undefined,
    });
  } finally {
    clearInterval(ticker);
  }
  Context.current().heartbeat("provisioned");
  await persistHandleState(scoped, session.id, handle);
  logInfo("temporal", `provisionComputeActivity: fresh provision for ${input.sessionId}`, {
    sessionId: input.sessionId,
    computeKind: handle.kind,
    computeName: handle.name,
  });
}

/**
 * Persist `(kind, name, meta)` on `session.config.compute_handle`. Method
 * closures don't survive `JSON.stringify`; rehydrateHandle on the next
 * dispatch re-attaches them.
 */
async function persistHandleState(
  app: import("../../app.js").AppContext,
  sessionId: string,
  handle: ComputeHandle,
): Promise<void> {
  const fresh = await app.sessions.get(sessionId);
  if (!fresh) {
    logWarn("temporal", `provisionComputeActivity: session ${sessionId} vanished mid-provision`, { sessionId });
    return;
  }
  const state: PersistedComputeHandleState = { kind: handle.kind, name: handle.name, meta: handle.meta };
  await app.sessions.update(sessionId, {
    config: { ...((fresh.config as object | null) ?? {}), compute_handle: state },
  });
}
