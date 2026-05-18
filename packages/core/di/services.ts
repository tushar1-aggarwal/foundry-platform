/**
 * DI registrations for application services.
 *
 * Services are singleton-scoped (one instance per container). They receive
 * dependencies via constructor arguments resolved from the container's
 * cradle. Factories use `asFunction` with explicit cradle reads so
 * registrations survive `bun build --compile` minification.
 */

import { asFunction, Lifetime } from "awilix";
import type { AppContainer } from "../container.js";
import type { AppContext } from "../app.js";
import type { ArkConfig } from "../config.js";
import type { SessionRepository } from "../repositories/session.js";
import type { ComputeRepository } from "../repositories/compute.js";
import type { EventRepository } from "../repositories/event.js";
import type { MessageRepository } from "../repositories/message.js";
import type { TodoRepository } from "../repositories/todo.js";
import type { ArtifactRepository } from "../repositories/artifact.js";
import type { LedgerRepository } from "../repositories/ledger.js";
import type { FlowStateRepository } from "../repositories/flow-state.js";
import type { FlowStore } from "../stores/flow-store.js";
import type { RuntimeStore } from "../stores/runtime-store.js";
import type { WorkspaceStore } from "../workspace/store.js";
import type { ModelStore } from "../stores/model-store.js";
import { ModelService } from "../models/ModelService.js";
import type { UsageRecorder } from "../observability/usage.js";
import type { TranscriptParserRegistry } from "../runtimes/transcript-parser.js";
import type { StatusPollerRegistry } from "../executors/status-poller.js";
import { SessionService, ComputeService } from "../services/index.js";
import { SessionHooks } from "../services/session-hooks/index.js";
import {
  SessionCreator,
  SessionTerminator,
  SessionSuspender,
  SessionForker,
  SessionReviewer,
} from "../services/session/index.js";
import type { SessionLifecycleDeps } from "../services/session/index.js";
import { SessionAttachService } from "../services/session/attach.js";
import { DispatchService } from "../services/dispatch/index.js";
import { SessionProgression } from "../services/session-progression.js";
import { executeAction } from "../services/actions/index.js";
import { depsFromApp } from "../services/deps.js";
import { getOutput } from "../services/session-output.js";
import { removeSessionWorktree } from "../services/worktree/index.js";
import { deletePerSessionCredsSecret, materializeClaudeAuthForDispatch } from "../services/dispatch-claude-auth.js";
import { garbageCollectComputeIfTemplate } from "../services/compute-lifecycle.js";
import { saveCheckpoint } from "../session/checkpoint.js";
import { provisionWorkspaceWorkdir } from "../workspace/provisioner.js";
import { buildFlowCallbacks } from "../services/flow-callbacks.js";
import { buildTaskWithHandoff, extractSubtasks } from "../services/task-builder.js";
import * as agentRegistry from "../agent/agent.js";
import { getExecutor } from "../executor.js";
import { startStatusPoller } from "../executors/status-poller.js";
import { fork as forkFn } from "../services/fork-join.js";
import type { ComputeService as ComputeServiceType } from "../services/compute.js";
import type { PluginRegistry } from "../plugins/registry.js";

/**
 * Register the core services.
 *
 * `app: AppContext` is registered in `AppContext.constructor()` so `c.app` is
 * always resolvable by the time these factories run.
 *
 * The optional `lifetime` parameter lets `tenant-scope.ts` reuse these exact
 * factories to register scoped copies in a child container, so tenant-sensitive
 * services close over the tenant-scoped repos + tenant-scoped `c.app` instead
 * of the root singletons. See `tenant-scope.ts` for the rationale: with awilix
 * `strict: true`, singleton deps resolve through the parent scope, which would
 * otherwise bind every tenant's `dispatchService` / session sub-services /
 * `sessionHooks` to the default-tenant repositories.
 */
interface SessionLifecycleCradle {
  sessions: SessionRepository;
  events: EventRepository;
  messages: MessageRepository;
  todos: TodoRepository;
  computes: ComputeRepository;
  flows: FlowStore;
  runtimes: RuntimeStore;
  workspaces: WorkspaceStore;
  usageRecorder: UsageRecorder;
  statusPollers: StatusPollerRegistry;
  config: ArkConfig;
  app: AppContext;
}

/**
 * Build the shared `SessionLifecycleDeps` cradle-slice consumed by every
 * session sub-service. Each sub-service is registered independently in the
 * container; they all close over the same narrow capability set.
 */
function buildSessionLifecycleDeps(c: SessionLifecycleCradle): SessionLifecycleDeps {
  return {
    sessions: c.sessions,
    events: c.events,
    messages: c.messages,
    todos: c.todos,
    computes: c.computes,
    flows: c.flows,
    runtimes: c.runtimes,
    workspaces: c.workspaces,
    config: c.config,
    usageRecorder: c.usageRecorder,
    statusPollers: c.statusPollers,
    dispatch: (id) => c.app.dispatchService.dispatch(id),
    removeWorktree: (session) => removeSessionWorktree(depsFromApp(c.app), session),
    deleteCredsSecret: (session, compute) => deletePerSessionCredsSecret(depsFromApp(c.app), session, compute),
    gcComputeIfTemplate: (computeName) => garbageCollectComputeIfTemplate(depsFromApp(c.app), computeName ?? null),
    resolveComputeTarget: (session) => c.app.resolveComputeTarget(session),
    advance: (id) => c.app.sessionProgression.stageDone(id),
    cleanupSession: async (session) => {
      const { cleanupSession } = await import("../services/session/cleanup.js");
      await cleanupSession(depsFromApp(c.app), session);
    },
    provisionWorkspaceWorkdir: (session, ws, opts) => provisionWorkspaceWorkdir(c.app, session, ws, opts),
    // Temporal is the sole orchestrator: every session is driven by a
    // sessionWorkflow. Lazy async import so the @temporalio packages load
    // only when a session is actually created.
    startTemporalWorkflow: async (sessionId: string, flowName: string, tenantId: string) => {
      const { getTemporalClient } = await import("../temporal/client.js");
      const client = await getTemporalClient(c.config.temporal);
      const wfId = `session-${sessionId}`;
      const handle = await client.workflow.start("sessionWorkflow", {
        taskQueue: `ark.${tenantId}.stages`,
        workflowId: wfId,
        // Hard wall-clock cap so a stuck workflow eventually closes
        // itself. See SessionService.start() for rationale.
        workflowExecutionTimeout: (c.config.temporal?.workflowExecutionTimeout ?? "24h") as any,
        args: [{ sessionId, tenantId, flowName }],
      });
      return { workflowId: wfId, runId: handle.firstExecutionRunId };
    },
  };
}

export function registerServices(
  container: AppContainer,
  lifetime: Lifetime.SINGLETON | Lifetime.SCOPED = Lifetime.SINGLETON,
): void {
  container.register({
    sessionService: asFunction(
      (c: { sessions: SessionRepository; events: EventRepository; messages: MessageRepository; app: AppContext }) =>
        new SessionService(c.sessions, c.events, c.messages, c.app),
      { lifetime },
    ),

    computeService: asFunction(
      (c: { computes: ComputeRepository; app: AppContext }) => new ComputeService(c.computes, c.app),
      { lifetime },
    ),

    sessionAttach: asFunction((c: { app: AppContext }) => new SessionAttachService(depsFromApp(c.app)), { lifetime }),

    sessionHooks: asFunction(
      (c: {
        sessions: SessionRepository;
        events: EventRepository;
        messages: MessageRepository;
        todos: TodoRepository;
        artifacts: ArtifactRepository;
        ledger: LedgerRepository;
        flows: FlowStore;
        usageRecorder: UsageRecorder;
        transcriptParsers: TranscriptParserRegistry;
        app: AppContext;
      }) =>
        new SessionHooks({
          sessions: c.sessions,
          events: c.events,
          messages: c.messages,
          todos: c.todos,
          artifacts: c.artifacts,
          ledger: c.ledger,
          flows: c.flows,
          usageRecorder: c.usageRecorder,
          transcriptParsers: c.transcriptParsers,
          advance: (id) => c.app.sessionProgression.stageDone(id),
          dispatch: (id) => c.app.dispatchService.dispatch(id),
          executeAction: (id, action) => executeAction(depsFromApp(c.app), id, action),
          runVerification: (id) => c.app.sessionReviewer.runVerification(id),
          recordSessionUsage: (session, usage, provider, source) =>
            c.app.sessionCreator.recordUsage(session, usage, provider, source),
          getOutput: (id, opts) => getOutput(depsFromApp(c.app), id, opts),
          cleanupOnTerminal: (id) => c.app.sessionTerminator.cleanupOnTerminal(id),
          ...buildFlowCallbacks(c.app),
        }),
      { lifetime },
    ),

    sessionCreator: asFunction((c: SessionLifecycleCradle) => new SessionCreator(buildSessionLifecycleDeps(c)), {
      lifetime,
    }),
    sessionTerminator: asFunction((c: SessionLifecycleCradle) => new SessionTerminator(buildSessionLifecycleDeps(c)), {
      lifetime,
    }),
    sessionSuspender: asFunction((c: SessionLifecycleCradle) => new SessionSuspender(buildSessionLifecycleDeps(c)), {
      lifetime,
    }),
    sessionForker: asFunction((c: SessionLifecycleCradle) => new SessionForker(buildSessionLifecycleDeps(c)), {
      lifetime,
    }),
    sessionReviewer: asFunction((c: SessionLifecycleCradle) => new SessionReviewer(buildSessionLifecycleDeps(c)), {
      lifetime,
    }),

    // DispatchService -- RF-3 narrow deps. No AppContext field. Callbacks
    // wrap the still-AppContext-taking helpers (buildTaskWithHandoff,
    // indexRepoForDispatch, materializeClaudeAuthForDispatch, ...); the
    // class body never sees app. `getApp` exists solely to feed
    // `LaunchOpts.app` into executors (separate migration).
    dispatchService: asFunction(
      (c: {
        sessions: SessionRepository;
        computes: ComputeRepository;
        events: EventRepository;
        flowStates: FlowStateRepository;
        flows: FlowStore;
        runtimes: RuntimeStore;
        models: ModelStore;
        computeService: ComputeServiceType;
        pluginRegistry: PluginRegistry;
        statusPollers: StatusPollerRegistry;
        config: ArkConfig;
        app: AppContext;
      }) =>
        new DispatchService({
          sessions: c.sessions,
          computes: c.computes,
          events: c.events,
          flowStates: c.flowStates,
          flows: c.flows,
          runtimes: c.runtimes,
          agents: c.app.agents,
          models: new ModelService(c.models),
          computeService: c.computeService,
          pluginRegistry: c.pluginRegistry,
          statusPollers: c.statusPollers,
          config: c.config,
          secrets: c.app.mode.secrets,

          // Hosted-mode: scheduler may be unset in local profiles. Accessor
          // throws when missing, so wrap in try/catch for the null return.
          getScheduler: () => {
            try {
              return c.app.scheduler;
            } catch {
              return null;
            }
          },

          // Flow + task-building callbacks
          ...buildFlowCallbacks(c.app),
          buildTask: (session, stage, agentName) => buildTaskWithHandoff(depsFromApp(c.app), session, stage, agentName),
          extractSubtasks: (session) => extractSubtasks(depsFromApp(c.app), session),
          materializeClaudeAuth: (session, compute) =>
            materializeClaudeAuthForDispatch(depsFromApp(c.app), session, compute),
          resolveAgent: (agentName, sessionVars, opts) =>
            agentRegistry.resolveAgentWithRuntime(c.app, agentName, sessionVars, opts),
          buildClaudeArgs: (agent, opts) =>
            agentRegistry.buildClaudeArgs(agent as any, {
              autonomy: opts.autonomy,
              projectRoot: opts.projectRoot,
              app: c.app,
            }),
          resolveExecutor: (runtime) => c.app.pluginRegistry.executor(runtime) ?? getExecutor(runtime),

          // Lifecycle / follow-on
          checkpoint: (sessionId) => {
            void saveCheckpoint({ sessions: c.sessions, events: c.events }, sessionId);
          },
          executeAction: (sessionId, action) => executeAction(depsFromApp(c.app), sessionId, action),
          dispatchChild: (childId) => c.app.dispatchService.dispatch(childId),
          fork: (parentId, task, opts) => forkFn(depsFromApp(c.app), parentId, task, opts),
          startStatusPoller: (sessionId, tmuxName, runtime) => startStatusPoller(c.app, sessionId, tmuxName, runtime),

          // Executor-interface coupling: LaunchOpts.app is required until
          // executors stop touching AppContext (separate migration).
          getApp: () => c.app,
        }),
      { lifetime },
    ),

    // SessionProgression -- the out-of-workflow driver for Temporal
    // sessions. Replaces the bespoke StageAdvanceService: the running
    // workflow owns stage iteration/routing/gates/fan-out; this only
    // exposes stageDone (the status:"ready" signal) + handoff
    // (clone+dispatch). All advance side-effects now live in the Temporal
    // lifecycle seam (temporal/activities/project-lifecycle.ts).
    sessionProgression: asFunction(
      (c: { sessions: SessionRepository; events: EventRepository; app: AppContext }) =>
        new SessionProgression({
          sessions: c.sessions,
          events: c.events,
          sessionClone: (id, instructions) => c.app.sessionForker.clone(id, instructions),
          dispatch: (id) => c.app.dispatchService.dispatch(id),
        }),
      { lifetime },
    ),
  });
}
