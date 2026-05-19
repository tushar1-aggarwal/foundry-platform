/**
 * ComputeTarget -- the composed (Compute, Isolation) pair used at dispatch.
 *
 * Exposes a straight delegation over the two interfaces. The dispatch layer
 * constructs a ComputeTarget from the `{compute_kind, isolation_kind}` DB
 * columns.
 *
 * Methods follow the lifecycle order: `provision` (compute) -> `prepare`
 * (isolation) -> `launchAgent` (isolation) -> `shutdown` (isolation) ->
 * `destroy` (compute). The compose shape intentionally does not expose
 * intermediate start/stop yet -- those semantics may get refined later
 * once more remote computes land.
 */

import type {
  AgentHandle,
  Compute,
  ComputeHandle,
  Isolation,
  LaunchOpts,
  PrepareCtx,
  ProvisionOpts,
  Snapshot,
} from "./types.js";

export class ComputeTarget {
  constructor(
    readonly compute: Compute,
    readonly isolation: Isolation,
  ) {}

  // ── Compute delegation ────────────────────────────────────────────────

  provision(opts: ProvisionOpts): Promise<ComputeHandle> {
    return this.compute.provision(opts);
  }

  start(h: ComputeHandle): Promise<void> {
    return this.compute.start(h);
  }

  stop(h: ComputeHandle): Promise<void> {
    return this.compute.stop(h);
  }

  destroy(h: ComputeHandle): Promise<void> {
    return this.compute.destroy(h);
  }

  getArkdUrl(h: ComputeHandle): string {
    return this.compute.getArkdUrl(h);
  }

  snapshot(h: ComputeHandle): Promise<Snapshot> {
    return this.compute.snapshot(h);
  }

  restore(s: Snapshot): Promise<ComputeHandle> {
    return this.compute.restore(s);
  }

  // ── Isolation delegation ──────────────────────────────────────────────

  prepare(h: ComputeHandle, ctx: PrepareCtx): Promise<void> {
    return this.isolation.prepare(this.compute, h, ctx);
  }

  launchAgent(h: ComputeHandle, opts: LaunchOpts): Promise<AgentHandle> {
    return this.isolation.launchAgent(this.compute, h, opts);
  }

  shutdown(h: ComputeHandle): Promise<void> {
    return this.isolation.shutdown(this.compute, h);
  }
}
