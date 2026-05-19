/**
 * RemoteArkdCompute -- shared base for every off-host arkd-backed Compute
 * (EC2, K8s, K8s-Kata via K8s, Firecracker).
 *
 * These computes all run arkd on a separate host/pod/microVM that the
 * conductor reaches through a transport (SSM port-forward, kubectl
 * port-forward, TAP bridge). The per-session workspace setup, the deferred
 * typed-secret flush, the MCP `ark-channel` wire config and the workdir
 * path translation were copy-pasted near-verbatim across all three impls
 * (~150 lines). They are collapsed here and parameterized by a small set
 * of abstract hooks:
 *
 *   - `workdirRoot(h, session)` -- the on-compute parent directory the
 *     per-session checkout lands under (EC2: `${home}/Projects`,
 *     K8s: `/workspace`, Firecracker: `${guestHome}/Projects`).
 *   - `placementCtxFor(h)` -- the real PlacementCtx the deferred queue
 *     replays onto (SSM / kubectl / microVM medium). EC2 throws here when
 *     the handle has no instanceId.
 *   - `channelBinaryPath()` -- absolute path to the `ark` binary that
 *     hosts the channel MCP server inside the compute.
 *   - `arkdPort()` -- the loopback port arkd listens on inside the compute.
 *
 * Subclasses keep only the provider-specific lifecycle (provision / start /
 * stop / destroy / ensureReachable / attachExistingHandle / getArkdUrl).
 */

import { DEFAULT_CONDUCTOR_URL } from "../constants.js";
import type { AppContext } from "../app.js";
import type { Session } from "../../types/session.js";
import type {
  Compute,
  ComputeCapabilities,
  ComputeHandle,
  ComputeKind,
  EnsureReachableOpts,
  FlushPlacementOpts,
  MethodedComputeHandle,
  PersistedComputeHandleState,
  PrepareWorkspaceOpts,
  ProvisionOpts,
  Snapshot,
} from "./types.js";
import { cloneWorkspaceViaArkd } from "./workspace-clone.js";
import { resolveAgentIdentityForRemoteCompute } from "./git-identity.js";
import type { PlacementCtx } from "../secrets/placement-types.js";

export abstract class RemoteArkdCompute implements Compute {
  abstract readonly kind: ComputeKind;
  abstract readonly capabilities: ComputeCapabilities;

  constructor(protected readonly app: AppContext) {}

  // ── Provider-specific lifecycle (implemented per subclass) ───────────────

  abstract provision(opts: ProvisionOpts): Promise<ComputeHandle>;
  abstract start(h: ComputeHandle): Promise<void>;
  abstract stop(h: ComputeHandle): Promise<void>;
  abstract destroy(h: ComputeHandle): Promise<void>;
  abstract attachExistingHandle(row: {
    name: string;
    status: string;
    config: Record<string, unknown>;
  }): MethodedComputeHandle | null;
  abstract rehydrateHandle(state: PersistedComputeHandleState): MethodedComputeHandle;
  abstract getArkdUrl(h: ComputeHandle): string;
  abstract ensureReachable(h: ComputeHandle, opts: EnsureReachableOpts): Promise<void>;
  abstract snapshot(h: ComputeHandle): Promise<Snapshot>;
  abstract restore(s: Snapshot): Promise<ComputeHandle>;
  abstract getAttachCommand(h: ComputeHandle, session: Session): string[];

  // ── Abstract hooks parameterizing the shared bodies ──────────────────────

  /**
   * The on-compute parent directory the per-session checkout lands under.
   * Implementations append `/<sessionId>/<repoBasename>` themselves via
   * `resolveWorkdir`; this hook returns just the root prefix (no trailing
   * slash). May read provider meta off `h`.
   */
  protected abstract workdirRoot(h: ComputeHandle, session: Session): string;

  /** Real PlacementCtx the deferred queue replays onto for this handle. */
  protected abstract placementCtxFor(h: ComputeHandle): PlacementCtx;

  /** Absolute path to the `ark` binary hosting the channel MCP server. */
  protected abstract channelBinaryPath(): string;

  /** Loopback port arkd listens on inside the compute. */
  protected abstract arkdPort(): number;

  // ── resolveWorkdir (shared) ──────────────────────────────────────────────
  //
  // Pure transform. Returns `${workdirRoot}/<sessionId>/<repoBasename>` or
  // null on a bare-worktree dispatch (no clone source) so the caller falls
  // back to `session.workdir`.

  resolveWorkdir(h: ComputeHandle, session: Session): string | null {
    const cloneSource = (session.config as { remoteRepo?: string } | null | undefined)?.remoteRepo ?? session.repo;
    if (!cloneSource) return null;
    const repoBasename =
      cloneSource
        .split("/")
        .pop()
        ?.replace(/\.git$/, "") ?? "project";
    return `${this.workdirRoot(h, session)}/${session.id}/${repoBasename}`;
  }

  // ── prepareWorkspace (shared) ────────────────────────────────────────────
  //
  // mkdir + git clone via arkd HTTP using the URL from `getArkdUrl(h)`.
  // Returns silently on bare-worktree dispatch. Persists the resolved
  // workdir + branch on the session row (conductor's setupSessionWorktree
  // short-circuits for remote computes, so this is the authoritative write
  // site for hosted-mode sessions).
  //
  // Ordering invariant: `ensureReachable` must have run on `h` so
  // `getArkdUrl(h)` resolves to a live transport.

  /** Test-only: swap the helper that performs `mkdir -p` + `git clone`. */
  setCloneHelperForTesting(fn: typeof cloneWorkspaceViaArkd): void {
    this.cloneHelper = fn;
  }

  protected cloneHelper: typeof cloneWorkspaceViaArkd = cloneWorkspaceViaArkd;

  async prepareWorkspace(h: ComputeHandle, opts: PrepareWorkspaceOpts): Promise<void> {
    if (!opts.source || !opts.remoteWorkdir) return;
    const arkdUrl = this.getArkdUrl(h);
    const arkdToken = process.env.ARK_ARKD_TOKEN ?? null;
    const branch = opts.branch ?? `ark-${opts.sessionId}`;
    const identity = await resolveAgentIdentityForRemoteCompute(this.app, this.app.tenantId ?? "default");
    await this.cloneHelper({
      arkdUrl,
      arkdToken,
      source: opts.source,
      remoteWorkdir: opts.remoteWorkdir,
      branch,
      authorName: identity.name,
      authorEmail: identity.email,
    });
    await this.app.sessions.update(opts.sessionId, { workdir: opts.remoteWorkdir, branch });
  }

  // ── flushPlacement (shared) ──────────────────────────────────────────────
  //
  // Replay the dispatcher's queued typed-secret ops onto the real
  // provider-specific PlacementCtx. No-op when the queue is empty. The
  // ctx is built by `placementCtxFor(h)` -- EC2 throws there when the
  // handle has no instanceId so queued ops are never silently dropped.

  async flushPlacement(h: ComputeHandle, opts: FlushPlacementOpts): Promise<void> {
    if (!opts.placement.hasDeferred()) return;
    const ctx = this.placementCtxFor(h);
    await opts.placement.flush(ctx);
  }

  // ── buildChannelConfig (shared) ──────────────────────────────────────────
  //
  // The remote `ark` binary hosts the channel MCP server; arkd inside the
  // compute listens on loopback `arkdPort()`. Same wire shape across all
  // remote computes -- only the binary path and arkd port differ.

  buildChannelConfig(
    sessionId: string,
    stage: string,
    channelPort: number,
    opts?: { conductorUrl?: string },
  ): Record<string, unknown> {
    return {
      command: this.channelBinaryPath(),
      args: ["channel"],
      env: {
        ARK_SESSION_ID: sessionId,
        ARK_STAGE: stage,
        ARK_CHANNEL_PORT: String(channelPort),
        ARK_CONDUCTOR_URL: opts?.conductorUrl ?? DEFAULT_CONDUCTOR_URL,
        ARK_ARKD_URL: `http://localhost:${this.arkdPort()}`,
      },
    };
  }

  buildLaunchEnv(_session: Session): Record<string, string> {
    return {};
  }
}
