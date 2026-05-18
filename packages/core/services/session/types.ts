/**
 * Shared types + Deps interface for the session-lifecycle pipeline.
 *
 * `SessionLifecycleDeps` enumerates the narrow capabilities that the
 * sub-classes actually read. Callbacks wrap still-AppContext-taking
 * helpers (removeWorktree, gcCompute, deleteCredsSecret, ...) so the
 * class itself never sees AppContext. Those callbacks are wired at the
 * container-registration layer where a single `c.app` reference is
 * acceptable.
 */

import type { ArkConfig } from "../../config.js";
import type { Session, Compute, CreateSessionOpts } from "../../../types/index.js";
import type { SessionRepository } from "../../repositories/session.js";
import type { EventRepository } from "../../repositories/event.js";
import type { MessageRepository } from "../../repositories/message.js";
import type { TodoRepository } from "../../repositories/todo.js";
import type { ComputeRepository } from "../../repositories/compute.js";
import type { FlowStore } from "../../stores/flow-store.js";
import type { RuntimeStore } from "../../stores/runtime-store.js";
import type { WorkspaceStore } from "../../workspace/store.js";
import type { Workspace } from "../../workspace/types.js";
import type { UsageRecorder } from "../../observability/usage.js";
import type { StatusPollerRegistry } from "../../executors/status-poller.js";
import type { ComputeTarget } from "../../compute/compute-target.js";

// ── Callbacks for helpers that still take AppContext ────────────────────────
// These wrap free functions that themselves take `app: AppContext` and reach
// into many cradle slots (workspace, compute-lifecycle, creds). Wiring them
// as narrow callbacks at container-reg time keeps the Lifecycle class free
// of AppContext entirely.

export interface DispatchCb {
  (sessionId: string): Promise<{ ok: boolean; message: string }>;
}
export interface RemoveWorktreeCb {
  (session: Session): Promise<void>;
}
export interface DeleteCredsSecretCb {
  (session: Session, compute: Compute | null): Promise<void>;
}
export interface GcComputeIfTemplateCb {
  (computeName: string | null | undefined): Promise<boolean>;
}
export interface ResolveComputeTargetCb {
  (session: Session): Promise<{ target: ComputeTarget | null; compute: Compute | null }>;
}
export interface CleanupSessionCb {
  (session: Session): Promise<void>;
}
export interface AdvanceCb {
  (sessionId: string, force?: boolean): Promise<{ ok: boolean; message: string }>;
}

// ── Public result shapes (stable; re-exported from the barrel) ──────────────

export type { SessionOpResult } from "../../../types/index.js";

export interface VerificationResult {
  ok: boolean;
  todosResolved: boolean;
  pendingTodos: string[];
  scriptResults: Array<{ script: string; passed: boolean; output: string }>;
  message: string;
}

export type VerifyScriptRunner = (
  script: string,
  opts: { cwd?: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

// Re-export CreateSessionOpts-aligned start opts (with two local extras not
// in the canonical type: `config` as a loose record for templating inputs,
// and `attachments`).
export type StartSessionOpts = CreateSessionOpts;

// ── Deps ────────────────────────────────────────────────────────────────────

export interface SessionLifecycleDeps {
  // Repositories -- all reads/writes by the lifecycle methods
  sessions: SessionRepository;
  events: EventRepository;
  messages: MessageRepository;
  todos: TodoRepository;
  computes: ComputeRepository;

  // Stores -- flow / runtime lookups needed by start + verify + usage
  flows: FlowStore;
  runtimes: RuntimeStore;
  workspaces: WorkspaceStore;

  // Config + usage recording
  config: ArkConfig;
  usageRecorder: UsageRecorder;

  statusPollers: StatusPollerRegistry;

  // Callbacks for helpers that still take AppContext.
  dispatch: DispatchCb;
  removeWorktree: RemoveWorktreeCb;
  deleteCredsSecret: DeleteCredsSecretCb;
  gcComputeIfTemplate: GcComputeIfTemplateCb;
  resolveComputeTarget: ResolveComputeTargetCb;
  /** Stage-advance callback. Used by approveReviewGate to force-advance past a gate. */
  advance: AdvanceCb;
  /** Full post-terminal cleanup (worktree + creds + event log). Used by kill(). */
  cleanupSession: CleanupSessionCb;
  /** Workspace provisioner (takes AppContext upstream; passed as a callback). */
  provisionWorkspaceWorkdir: (
    session: Session,
    workspace: Workspace,
    opts: { primaryRepoId: string | null },
  ) => Promise<string>;
  /**
   * Temporal workflow starter. Temporal is the sole orchestrator, so this is
   * always wired: `start()` / fork / clone call it after persisting the
   * session row to launch the sessionWorkflow. Returns the workflow ID and
   * first execution run ID -- both persisted on the row so operators can
   * correlate session rows with workflow histories in the Temporal UI.
   */
  startTemporalWorkflow: (
    sessionId: string,
    flowName: string,
    tenantId: string,
  ) => Promise<{ workflowId: string; runId: string }>;
}
