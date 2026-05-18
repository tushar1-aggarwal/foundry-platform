/**
 * In-process Temporal test harness.
 *
 * Runs the REAL `sessionWorkflow` / `stageWorkflow` functions and the REAL
 * activities against a test AppContext (in-memory SQLite, ephemeral dirs) --
 * no Temporal server, no Docker, no time-skipping test server.
 *
 * Why a synchronous in-process driver instead of @temporalio/testing's
 * TestWorkflowEnvironment:
 *  - The dispatch chain starts a real wall-clock setInterval status poller
 *    OUTSIDE Temporal; a time-skipping env would skip the timers the poller
 *    needs to flip the session row to "ready", so the real activity chain
 *    would never complete.
 *  - TestWorkflowEnvironment spawns an external temporal test-server binary
 *    and bundles workflows through the Node worker (napi) -- fragile under
 *    Bun and explicitly out of scope (no server/Docker).
 *  - sessionWorkflow is plain async orchestration; its only Temporal surface
 *    is proxyActivities / signals / condition / startChild / workflowInfo /
 *    CancellationScope. Faithful in-process shims let the genuine prod
 *    workflow code run unmodified.
 *
 * Interception point is the genuine prod test seam: `getTemporalClient`
 * (temporal/client.js). Both prod start paths -- the startTemporalWorkflow
 * DI dep (di/services.ts) and SessionService's default _temporalClientFactory
 * -- call it. Substituting it with a fake in-process Client means the prod
 * code (start / approveReviewGate / rejectReviewGate / stop) runs unchanged
 * against client.workflow.start + client.workflow.getHandle; nothing forks.
 *
 * @temporalio/workflow + @temporalio/activity are substituted via bun's
 * mock.module at harness import time (before any workflow file loads).
 */

import { mock } from "bun:test";
import type { AppContext } from "../app.js";
import { depsFromApp } from "../services/deps.js";

// --- in-process @temporalio/workflow substitute -----------------------------

type SignalDef = { name: string };
type SignalHandler = (...args: any[]) => void;

// Each running workflow gets its own handler table + a per-invocation async
// scope so concurrent sessions never cross signal wires.
let currentHandlers: Map<string, SignalHandler> | null = null;
const handlerTables = new Map<string, Map<string, SignalHandler>>();

function defineSignal(name: string): SignalDef {
  return { name };
}

function setHandler(def: SignalDef, fn: SignalHandler): void {
  if (currentHandlers) currentHandlers.set(def.name, fn);
}

// condition(): poll the predicate until true. Real wall-clock waits are
// correct here -- the harness runs the genuine poll-driven activities, so a
// deterministic time-skip would only break them.
async function condition(pred: () => boolean, _timeout?: string): Promise<boolean> {
  if (pred()) return true;
  return await new Promise<boolean>((resolve) => {
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv);
        resolve(true);
      }
    }, 25);
  });
}

let _activities: Record<string, (...a: any[]) => any> = {};

function proxyActivities<T>(_opts: unknown): T {
  // Every property access returns a fn that invokes the real injected
  // activity by name -- mirrors Temporal's name-based activity dispatch.
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        return (...args: any[]) => {
          const fn = _activities[prop];
          if (!fn) throw new Error(`in-process harness: activity '${prop}' not registered`);
          return fn(...args);
        };
      },
    },
  ) as T;
}

let _childWorkflows: Record<string, (...a: any[]) => Promise<any>> = {};

function workflowInfo() {
  return { taskQueue: "in-process", workflowId: "in-process", runId: "in-process" };
}

async function startChild(workflowFn: any, opts: { args: any[]; workflowId?: string }) {
  const name = typeof workflowFn === "string" ? workflowFn : workflowFn?.name;
  const impl = typeof workflowFn === "function" ? workflowFn : _childWorkflows[name];
  if (!impl) throw new Error(`in-process harness: child workflow '${name}' not registered`);
  const resultPromise = Promise.resolve(impl(...opts.args));
  return { result: () => resultPromise };
}

const CancellationScope = {
  // No cancellation in-process: the finally-block cleanup always runs to
  // completion, which matches nonCancellable's intent.
  nonCancellable: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
};

// Substitute BEFORE any workflow file imports these. mock.module is
// process-global + idempotent; importing this harness once is enough.
mock.module("@temporalio/workflow", () => ({
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  workflowInfo,
  startChild,
  CancellationScope,
}));

// Activities call `Context.current().heartbeat(...)`; no Temporal activity
// context exists in-process, so substitute a no-op heartbeat.
mock.module("@temporalio/activity", () => ({
  Context: { current: () => ({ heartbeat: (_?: unknown) => {} }) },
}));

// --- fake in-process Temporal Client ----------------------------------------

type RunRecord = { promise: Promise<void>; runId: string };
const runs = new Map<string, RunRecord>(); // workflowId -> running workflow
const inFlight = new Set<Promise<void>>();

function makeFakeClient(): any {
  return {
    workflow: {
      async start(_name: string, opts: { workflowId: string; args: any[] }) {
        const { sessionId, tenantId, flowName } = opts.args[0];
        const wfId = opts.workflowId;
        const runId = `run-${sessionId}`;
        const handlers = new Map<string, SignalHandler>();
        handlerTables.set(wfId, handlers);

        const { sessionWorkflow } = await import("./workflows/session-workflow.js");

        // Fire-and-forget: mirrors prod client.workflow.start returning
        // immediately while the workflow runs server-side.
        const promise = (async () => {
          const prev = currentHandlers;
          currentHandlers = handlers;
          try {
            await sessionWorkflow({ sessionId, tenantId, flowName });
          } catch {
            // Business failures are already projected onto the session row
            // by the workflow; a thrown re-raise is swallowed so the harness
            // mirrors the server (failure stays on the row, not the caller).
          } finally {
            currentHandlers = prev;
            handlerTables.delete(wfId);
          }
        })();
        runs.set(wfId, { promise, runId });
        inFlight.add(promise);
        void promise.finally(() => inFlight.delete(promise));
        return { firstExecutionRunId: runId, workflowId: wfId };
      },
      getHandle(workflowId: string) {
        return {
          async signal(signalName: string, ...args: any[]) {
            const fn = handlerTables.get(workflowId)?.get(signalName);
            if (fn) fn(...args);
          },
          async result() {
            await runs.get(workflowId)?.promise;
          },
          async terminate(_reason?: string) {
            // In-process workflows can't be force-killed mid-await; the
            // session row is already driven to a terminal state by the
            // stop/delete path before this is called. No-op is faithful.
          },
          async cancel() {},
        };
      },
    },
  };
}

// --- real activity wiring ---------------------------------------------------

async function injectAllActivities(app: AppContext): Promise<void> {
  const deps = depsFromApp(app);
  const provision = await import("./activities/provision-compute.js");
  const destroy = await import("./activities/destroy-compute.js");
  const dispatch = await import("./activities/dispatch-stage.js");
  const awaitC = await import("./activities/await-stage-completion.js");
  const action = await import("./activities/execute-action.js");
  const verify = await import("./activities/run-verification.js");
  const projSession = await import("./activities/project-session.js");
  const projStage = await import("./activities/project-stage.js");
  const loadFlow = await import("./activities/load-flow.js");

  provision.injectDeps(deps);
  destroy.injectDeps(deps);
  dispatch.injectDeps(deps);
  awaitC.injectDeps(deps);
  action.injectDeps(deps);
  verify.injectDeps(deps);
  projSession.injectDeps(deps);
  projStage.injectDeps(deps);
  loadFlow.injectDeps(deps);

  _activities = {
    provisionComputeActivity: provision.provisionComputeActivity,
    destroyComputeActivity: destroy.destroyComputeActivity,
    dispatchStageActivity: dispatch.dispatchStageActivity,
    awaitStageCompletionActivity: awaitC.awaitStageCompletionActivity,
    executeActionActivity: action.executeActionActivity,
    runVerificationActivity: verify.runVerificationActivity,
    projectSessionActivity: projSession.projectSessionActivity,
    projectStageActivity: projStage.projectStageActivity,
    loadFlowActivity: loadFlow.loadFlowActivity,
  };
}

// --- harness API ------------------------------------------------------------

/**
 * Wire a forTestAsync AppContext so the prod start / signal / stop paths
 * route to an in-process run of the real sessionWorkflow. Call after
 * `app.boot()`. Returns a disposer (call in afterAll).
 */
export async function attachTemporalTestHarness(app: AppContext): Promise<() => void> {
  await injectAllActivities(app);

  const { stageWorkflow } = await import("./workflows/stage-workflow.js");
  _childWorkflows = { stageWorkflow };

  // Substitute getTemporalClient -- the genuine boundary every prod start
  // path crosses. SessionService also reads a _temporalClientFactory seam;
  // set it too so an already-resolved service picks up the fake client.
  mock.module("./client.js", () => ({
    getTemporalClient: async () => makeFakeClient(),
    closeTemporalClient: async () => {},
    temporalClientKey: () => "in-process",
  }));
  const svc: any = app.sessionService;
  svc._temporalClientFactory = async () => makeFakeClient();

  return () => {
    svc._temporalClientFactory = null;
  };
}

/**
 * Poll `sessions.get(id)` until it reaches one of `statuses` or the deadline.
 * The deterministic await tests use in place of the bespoke pump's polling.
 */
export async function waitForSessionStatus(
  app: AppContext,
  sessionId: string,
  statuses: string[] = ["completed", "failed", "stopped", "archived"],
  timeoutMs = 30_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await app.sessions.get(sessionId);
    if (s && statuses.includes(s.status as string)) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  const last = await app.sessions.get(sessionId);
  throw new Error(
    `waitForSessionStatus: ${sessionId} did not reach [${statuses.join(",")}] in ${timeoutMs}ms ` +
      `(last status=${last?.status}, stage=${last?.stage}, error=${last?.error ?? "none"})`,
  );
}

/** Await every in-flight in-process workflow (use in afterEach/afterAll). */
export async function drainTemporalTestHarness(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}
