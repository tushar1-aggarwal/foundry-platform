/**
 * WorktreeIsolation -- runs the agent directly via arkd on the host, but
 * each session gets its own git worktree as its workdir (created by the
 * workspace provisioner before launch). No container wrapper.
 *
 * Agent launch/attach is identical to direct isolation; the per-session
 * worktree lifecycle lives in the workspace layer, so `prepare`/`shutdown`
 * are no-ops here.
 */

import { ArkdClient } from "../../../arkd/client/index.js";
import type { AppContext } from "../../app.js";
import { buildAgentHandle } from "../handle-helpers.js";
import type {
  AgentHandle,
  Compute,
  ComputeHandle,
  IsolationKind,
  Isolation,
  LaunchOpts,
  PrepareCtx,
} from "../types.js";

export class WorktreeIsolation implements Isolation {
  readonly kind: IsolationKind = "worktree";
  readonly name = "worktree";

  /** Override hook for tests; when null we build a fresh `ArkdClient`. */
  private clientFactory: ((url: string) => ArkdClient) | null = null;

  constructor(private readonly app: AppContext) {}

  /** Test-only: swap in a stub `ArkdClient` factory. */
  setClientFactory(factory: (url: string) => ArkdClient): void {
    this.clientFactory = factory;
  }

  async prepare(_compute: Compute, _h: ComputeHandle, _ctx: PrepareCtx): Promise<void> {
    // No-op: the per-session worktree is provisioned by the workspace layer.
  }

  async launchAgent(compute: Compute, h: ComputeHandle, opts: LaunchOpts): Promise<AgentHandle> {
    const url = compute.getArkdUrl(h);
    const client = this.clientFactory ? this.clientFactory(url) : new ArkdClient(url);
    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: opts.launcherContent,
      workdir: opts.workdir,
    });
    return this.attachAgent(compute, h, opts.tmuxName);
  }

  attachAgent(compute: Compute, h: ComputeHandle, sessionName: string): AgentHandle {
    const factory = this.clientFactory ?? ((url: string) => new ArkdClient(url));
    return buildAgentHandle(sessionName, () => compute.getArkdUrl(h), factory);
  }

  async shutdown(_compute: Compute, _h: ComputeHandle): Promise<void> {
    // No-op: the worktree is reclaimed by the workspace layer, not here.
  }
}
