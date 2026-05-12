import type { SessionRepository } from "../repositories/session.js";
import type { EventRepository } from "../repositories/event.js";
import type { MessageRepository } from "../repositories/message.js";
import type { BlobStore } from "../storage/blob-store.js";
import type { FlowStore } from "../stores/flow-store.js";
import type { ComputeRepository } from "../repositories/compute.js";
import type { ArkConfig } from "../config.js";
import type { SecretsCapability } from "../secrets/types.js";
import type { AgentStore } from "../stores/agent-store.js";
import type { RuntimeStore } from "../stores/runtime-store.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { FlowStateRepository } from "../repositories/flow-state.js";
import type { StatusPollerRegistry } from "../executors/status-poller.js";
import type { DatabaseAdapter } from "../database/index.js";

/**
 * Narrow dependency set for orchestration functions.
 * Activities receive this at worker construction time instead of AppContext
 * so Temporal can serialize activity inputs at the workflow boundary.
 */
export interface OrchestrationDeps {
  sessions: SessionRepository;
  events: EventRepository;
  messages: MessageRepository;
  blobStore: BlobStore;
  flows: FlowStore;
  computes: ComputeRepository;
  config: ArkConfig;
  secrets: SecretsCapability;
  tenantId: string;
  arkDir: string;
  /** Phase 3.5: dispatch helper port deps. */
  agents: AgentStore;
  runtimes: RuntimeStore;
  pluginRegistry: PluginRegistry;
  flowStates: FlowStateRepository;
  statusPollers: StatusPollerRegistry;
  /** Phase 3.6: raw DB adapter for idempotency ledger in executeAction. */
  db: DatabaseAdapter;
  /**
   * Phase 3.7 escape hatch: the full AppContext when one is available
   * (the Temporal worker boots its own). In-process executors that still
   * read app-only methods (`resolveComputeTarget`, `getCompute`, `getIsolation`,
   * `forTenant`) read through here instead of going through the synthetic
   * shim. Activities should never use this directly -- it exists solely to
   * let `dispatch-deps.buildAppShim` return the real thing when possible.
   */
  app?: import("../app.js").AppContext;
}

/** Derive narrow deps from a full AppContext for local/transition use. */
export function depsFromApp(app: import("../app.js").AppContext): OrchestrationDeps {
  return {
    sessions: app.sessions,
    events: app.events,
    messages: app.messages,
    blobStore: app.blobStore,
    flows: app.flows,
    computes: app.computes,
    config: app.config,
    secrets: app.mode.secrets,
    tenantId: app.tenantId!,
    arkDir: app.arkDir,
    agents: app.agents,
    runtimes: app.runtimes,
    pluginRegistry: app.pluginRegistry,
    flowStates: app.flowStates,
    statusPollers: app.statusPollers,
    db: app.db,
    app,
  };
}
