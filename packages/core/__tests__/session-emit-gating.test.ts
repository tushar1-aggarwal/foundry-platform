/**
 * Tests for Task 5 (Temporal Phase 3): emitSessionCreated / onCreated gating.
 *
 * Two assertions:
 *   1. In Temporal mode (startTemporalWorkflow wired), SessionCreator.start()
 *      does NOT call hooks.onCreated -- the workflow drives dispatch instead.
 *   2. In non-Temporal mode (default test profile), SessionService.start()
 *      DOES call every registered session_created listener exactly once.
 *
 * The Temporal-mode test avoids a real Temporal server by using a stub
 * startTemporalWorkflow that resolves synchronously. It goes through
 * SessionLifecycle directly (not sessionService.start()) so we can inject
 * the stub without standing up hosted mode plumbing.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { SessionLifecycle } from "../services/session/index.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

test("emitSessionCreated does NOT fire in Temporal mode", async () => {
  // Build a SessionLifecycle whose deps include a stub startTemporalWorkflow.
  // usesTemporal in create.ts = typeof d.startTemporalWorkflow === "function",
  // so this puts the creator in "Temporal mode" without a real Temporal server.
  let onCreatedCallCount = 0;

  const stubWorkflowId = "stub-wf-id";
  const stubRunId = "stub-run-id";

  const lifecycle = new SessionLifecycle({
    sessions: app.sessions,
    events: app.events,
    messages: app.messages,
    todos: app.container.cradle.todos,
    computes: app.container.cradle.computes,
    flows: app.flows,
    runtimes: app.runtimes,
    workspaces: app.container.cradle.workspaces,
    config: app.config,
    usageRecorder: app.container.cradle.usageRecorder,
    statusPollers: app.container.cradle.statusPollers,
    dispatch: async () => ({ ok: true, message: "noop" }),
    removeWorktree: async () => {},
    deleteCredsSecret: async () => {},
    gcComputeIfTemplate: async () => false,
    resolveComputeTarget: async () => ({ target: null, compute: null }),
    advance: async () => ({ ok: true, message: "noop" }),
    provisionWorkspaceWorkdir: async () => "/tmp/stub",
    // Stub: acts as Temporal being wired -- makes usesTemporal = true
    startTemporalWorkflow: async () => ({ workflowId: stubWorkflowId, runId: stubRunId }),
  });

  await lifecycle.start(
    { summary: "temporal-emit-gating-test" },
    {
      onCreated: () => {
        onCreatedCallCount++;
      },
    },
  );

  expect(onCreatedCallCount).toBe(0);
});

test("emitSessionCreated DOES fire in non-Temporal mode", async () => {
  // Default test profile: temporalOrchestration=false, mode.kind != "hosted".
  // SessionService.start() should call emitSessionCreated (and thus every
  // registered listener) exactly once.
  let listenerCallCount = 0;
  const unsubscribe = app.sessionService.onSessionCreated(() => {
    listenerCallCount++;
  });

  try {
    await app.sessionService.start({ summary: "bespoke-emit-gating-test" });
    expect(listenerCallCount).toBe(1);
  } finally {
    unsubscribe();
  }
});
