/**
 * Factory: OrchestrationDeps -> DispatchDeps
 *
 * Constructs a DispatchDeps from the narrow OrchestrationDeps that Temporal
 * activities carry, without ever touching AppContext.
 *
 * Fields that come directly from OrchestrationDeps are wired through as-is.
 * Fields that still depend on AppContext (resolveAgent, buildTask,
 * materializeClaudeAuth, etc.) are stubbed with a clear "not yet ported"
 * error. These stubs are intentional placeholders -- Phase 3.5 will replace
 * them with self-contained implementations that do not require AppContext.
 *
 * The only field that structurally cannot be provided without AppContext is
 * `getApp`, which exists solely to satisfy the executor LaunchOpts.app
 * coupling. It throws as well; the executor migration is tracked separately.
 */

import type { DispatchDeps } from "../../services/dispatch/types.js";
import type { OrchestrationDeps } from "../../services/deps.js";
import type { BlobStore } from "../../storage/blob-store.js";
import type { ComputeService } from "../../services/compute.js";
import type { AppContext } from "../../app.js";
import { resolveAgentWithRuntime, buildClaudeArgs as buildClaudeArgsHelper } from "../../agent/agent.js";
import { getExecutor } from "../../executor.js";
import { buildTaskWithHandoff, extractSubtasks } from "../../services/task-builder.js";
import { startStatusPoller } from "../../executors/status-poller.js";
import { saveCheckpoint } from "../../session/checkpoint.js";
import { executeAction } from "../../services/actions/index.js";

/**
 * Build a minimal AppContext-shaped shim from OrchestrationDeps. Used to bridge
 * helpers that still take `app: AppContext` until their signatures are
 * narrowed. The shim only exposes fields helpers actually read; accessing any
 * other property surfaces as undefined (which is fine -- helpers fail loudly
 * if they need fields the shim doesn't carry).
 *
 * This is intentionally a shim rather than a full refactor of every helper.
 * Phase 3.5 ports run incrementally by extending OrchestrationDeps and adding
 * fields here; Phase 3.5+ refactors helpers to take narrow deps directly and
 * the shim shrinks toward zero.
 */
function buildAppShim(d: OrchestrationDeps): AppContext {
  // Prefer the real AppContext when the deps were produced from one (the
  // Temporal worker boots its own in worker.ts). Helpers that need
  // app-only methods (`resolveComputeTarget`, `getCompute`, `getIsolation`,
  // `forTenant`, etc.) see the full surface and Just Work without the
  // shim catching up to every field. The synthetic shim below remains for
  // call sites that don't have a real app (e.g. unit tests).
  if (d.app) return d.app;
  return {
    sessions: d.sessions,
    events: d.events,
    messages: d.messages,
    blobStore: d.blobStore,
    flows: d.flows,
    computes: d.computes,
    agents: d.agents,
    runtimes: d.runtimes,
    pluginRegistry: d.pluginRegistry,
    flowStates: d.flowStates,
    statusPollers: d.statusPollers,
    config: d.config,
    arkDir: d.arkDir,
    tenantId: d.tenantId,
    db: d.db,
    // SecretsManager is read by buildLaunchEnv → placeAllSecrets via
    // `app.secrets.list/listBlobsDetailed/resolveMany/getBlob`. Expose it at
    // the top level (not just on mode) so the shim matches the AppContext
    // surface those helpers expect.
    secrets: d.secrets,
    mode: { kind: "hosted", secrets: d.secrets },
  } as unknown as AppContext;
}

/**
 * DispatchDeps extended with OrchestrationDeps fields that Temporal activities
 * need but that are not part of the core DispatchService contract.
 * `blobStore` is the only addition today -- kept here so activities can read
 * session inputs without going through AppContext.
 */
export type TemporalDispatchDeps = DispatchDeps & {
  /** Pass-through from OrchestrationDeps for activities that read blob inputs. */
  blobStore: BlobStore;
};

// ── Minimal stub helpers ─────────────────────────────────────────────────────

/**
 * Diagnostic error for a DispatchDeps callback that hasn't been ported to
 * the Temporal worker. Operators hitting one of these need to know exactly
 * which flow shape is unsupported AND which knob to flip to recover, not a
 * generic "Phase 3.5" sentinel. Each callsite supplies its own guidance.
 */
function notPortedYet(field: string, guidance: string): never {
  throw new Error(`Temporal: ${field} is not yet supported. ${guidance}`);
}

/**
 * Per-callback guidance strings -- centralized so the messages stay in sync
 * across multiple call sites (e.g. computeService.* all share the same
 * "compute template clone" guidance). Each string ends with a recovery hint
 * that names ARK_TEMPORAL_ORCHESTRATION when bespoke is the workaround.
 */
const NOT_PORTED_GUIDANCE = {
  computeService:
    "Per-stage compute template clones are not yet ported to Temporal. " +
    "Either pre-create the cloned compute row, or unset ARK_TEMPORAL_ORCHESTRATION " +
    "for tenants whose flows use `stage.compute: <template-name>`.",
  dispatchChild:
    "for_each stages (child dispatch) are not yet ported to Temporal. " +
    "Unset ARK_TEMPORAL_ORCHESTRATION for tenants whose flows use `for_each` " +
    "until the for_each workflow branch lands.",
  fork:
    "The fork primitive should be unreachable under Temporal -- the session " +
    "workflow's fan_out branch consumes `type: fork` stages before this " +
    "callback is reached. Hitting this is unexpected; please report the flow " +
    "definition that triggered it.",
} as const;

/** Minimal ComputeService stub. Throws on every access. Phase 3.5 follow-up. */
function stubComputeService(): ComputeService {
  const g = NOT_PORTED_GUIDANCE.computeService;
  const stub = {
    create: () => notPortedYet("computeService.create", g),
    update: () => notPortedYet("computeService.update", g),
    delete: () => notPortedYet("computeService.delete", g),
    get: () => notPortedYet("computeService.get", g),
    list: () => notPortedYet("computeService.list", g),
    cloneTemplate: () => notPortedYet("computeService.cloneTemplate", g),
  };
  return stub as unknown as ComputeService;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a DispatchDeps from OrchestrationDeps.
 *
 * Callers (Temporal activities) pass this result to `new DispatchService()`
 * instead of constructing DispatchDeps inside `di/services.ts` where
 * AppContext is available. The stubs ensure activities that don't exercise the
 * AppContext-dependent paths (the common Temporal case: hosted-mode launch via
 * scheduler) fail loudly rather than silently misbehaving.
 */
export function buildDispatchDeps(orchDeps: OrchestrationDeps): TemporalDispatchDeps {
  return {
    // ── Direct pass-through from OrchestrationDeps ───────────────────────────
    sessions: orchDeps.sessions,
    events: orchDeps.events,
    computes: orchDeps.computes,
    flows: orchDeps.flows,
    config: orchDeps.config,
    secrets: orchDeps.secrets,
    blobStore: orchDeps.blobStore,

    // ── Phase 3.5 ports: real repos/stores from widened OrchestrationDeps ────
    runtimes: orchDeps.runtimes,
    flowStates: orchDeps.flowStates,
    pluginRegistry: orchDeps.pluginRegistry,
    statusPollers: orchDeps.statusPollers,
    // computeService: still stubbed -- not in OrchestrationDeps yet. The
    // dispatch chain only hits computeService.cloneTemplate for compute
    // template resolution; the e2e stub-runner path uses compute_name="local"
    // which short-circuits that branch.
    computeService: stubComputeService(),

    // models is optional -- omit; raw agent.model flows through in that case.

    // ── Hosted-mode scheduler ────────────────────────────────────────────────
    // Return null: the Temporal worker does not carry an AppContext-bound
    // SessionScheduler. The DispatchService uses the scheduler only in the
    // hosted-mode branch; Temporal workflows replace that path.
    // TODO(Phase 3.5): supply a real scheduler if the hosted-mode branch is
    // needed inside a Temporal activity.
    getScheduler: () => null,

    // ── Phase 3.5 ports: read directly from FlowStore ────────────────────────
    getStage: (flowName, stageName) => {
      const f = orchDeps.flows.get(flowName);
      // Hosted DB store can return a Promise on cache miss; treat as "not loaded".
      if (f && typeof (f as { then?: unknown }).then === "function") return null;
      const stages = (f as { stages?: any[] })?.stages ?? [];
      return stages.find((s: { name: string }) => s.name === stageName) ?? null;
    },
    getStageAction: (flowName, stageName) => {
      const f = orchDeps.flows.get(flowName);
      if (f && typeof (f as { then?: unknown }).then === "function") return { type: "unknown" };
      const stages = (f as { stages?: any[] })?.stages ?? [];
      const stage = stages.find((s: { name: string }) => s.name === stageName);
      if (!stage) return { type: "unknown" };
      if (stage.for_each !== undefined) {
        return { type: "for_each", on_failure: stage.on_failure, optional: stage.optional };
      }
      if (stage.type === "fork") {
        return {
          type: "fork",
          agent: stage.agent ?? "implementer",
          strategy: stage.strategy ?? "plan",
          max_parallel: stage.max_parallel ?? 4,
          on_failure: stage.on_failure,
          optional: stage.optional,
        };
      }
      if (stage.action) {
        return { type: "action", action: stage.action, on_failure: stage.on_failure, optional: stage.optional };
      }
      if (stage.agent) {
        return { type: "agent", agent: stage.agent, on_failure: stage.on_failure, optional: stage.optional };
      }
      return { type: "unknown", on_failure: stage.on_failure, optional: stage.optional };
    },
    // ── Phase 3.5 ports: helpers via AppContext shim from OrchestrationDeps ──
    buildTask: (session, stage, agentName) => buildTaskWithHandoff(buildAppShim(orchDeps), session, stage, agentName),
    extractSubtasks: (session) => extractSubtasks(buildAppShim(orchDeps), session),
    resolveAgent: (agentName, sessionVars, opts) =>
      resolveAgentWithRuntime(buildAppShim(orchDeps), agentName, sessionVars, opts),
    buildClaudeArgs: (agent, opts) =>
      buildClaudeArgsHelper(agent as any, {
        autonomy: opts.autonomy,
        projectRoot: opts.projectRoot,
        app: buildAppShim(orchDeps),
      }),
    resolveExecutor: (runtime) => orchDeps.pluginRegistry.executor(runtime) ?? getExecutor(runtime),

    // materializeClaudeAuth: buildLaunchEnv calls this unconditionally before
    // branching on runtime, so even stub-runner stages walk through it. The
    // production helper (materializeClaudeAuthForDispatch) returns EMPTY for
    // tenants with no claude binding, which is the default for the Temporal
    // e2e fixtures. We mirror that: no binding lookup yet (tenantClaudeAuth
    // isn't on OrchestrationDeps), return EMPTY. Phase 3.5+ will port the
    // real lookup once OrchestrationDeps carries the binding store.
    materializeClaudeAuth: async () => ({
      env: {},
      credsSecretName: null,
      credsSecretNamespace: null,
    }),

    // ── Lifecycle / follow-on ─────────────────────────────────────────────────
    checkpoint: (sessionId) => {
      void saveCheckpoint({ sessions: orchDeps.sessions, events: orchDeps.events }, sessionId);
    },
    startStatusPoller: (sessionId, tmuxName, runtime) =>
      startStatusPoller(buildAppShim(orchDeps), sessionId, tmuxName, runtime),

    // mediateStageHandoff is a no-op under Temporal. In bespoke mode it
    // advances the next stage via StageAdvanceService; under Temporal the
    // session-workflow loop drives stage advancement itself, so a stage's
    // post-action handoff has nothing to do.
    mediateStageHandoff: async (_sessionId, _opts) => undefined,
    executeAction: (sessionId, action) => executeAction(buildAppShim(orchDeps), sessionId, action),
    dispatchChild: (_childId) => notPortedYet("dispatchChild", NOT_PORTED_GUIDANCE.dispatchChild),
    fork: (_parentId, _task, _opts) => notPortedYet("fork", NOT_PORTED_GUIDANCE.fork),

    // getApp: feeds the executor LaunchOpts.app coupling. The shim is enough
    // for the executor to perform repo writes and event logging.
    getApp: () => buildAppShim(orchDeps),
  };
}
