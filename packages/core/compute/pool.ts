/**
 * Compute pool management -- pre-provisioned pools of compute resources.
 *
 * Pools define a (compute_kind, isolation_kind) pair, min/max instance
 * counts, and compute-specific config. Sessions can request a compute from
 * a pool instead of specifying a named compute. When a session completes,
 * its compute is released back to the pool for reuse.
 */

import type { AppContext } from "../app.js";
import type { Compute, ComputeAxes } from "../../types/index.js";
import { logDebug } from "../observability/structured-log.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ComputePool {
  name: string;
  compute: ComputeAxes; // where it lives + how it is sandboxed
  min: number; // minimum warm instances
  max: number; // maximum instances
  config: Record<string, unknown>; // compute-specific config
}

export interface ComputePoolRow {
  name: string;
  compute: string; // JSON-encoded ComputeAxes
  min_instances: number;
  max_instances: number;
  config: string;
  tenant_id: string;
  created_at: string;
  updated_at: string;
}

export interface ComputePoolStatus extends ComputePool {
  active: number; // instances currently assigned to sessions
  available: number; // instances idle and ready
}

// ── Schema ─────────────────────────────────────────────────────────────────

export async function initPoolSchema(db: { exec(sql: string): Promise<void> }): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS compute_pools (
      name TEXT NOT NULL,
      compute TEXT NOT NULL,
      min_instances INTEGER NOT NULL DEFAULT 0,
      max_instances INTEGER NOT NULL DEFAULT 10,
      config TEXT DEFAULT '{}',
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (name, tenant_id)
    );
  `);
}

// ── Manager ────────────────────────────────────────────────────────────────

export class ComputePoolManager {
  private tenantId: string = "default";

  constructor(private app: AppContext) {}

  setTenant(id: string): void {
    this.tenantId = id;
  }
  getTenant(): string {
    return this.tenantId;
  }

  /** Create a pool definition. */
  async createPool(pool: ComputePool): Promise<ComputePool> {
    const ts = new Date().toISOString();
    await this.app.db
      .prepare(
        `
      INSERT INTO compute_pools (name, compute, min_instances, max_instances, config, tenant_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        pool.name,
        JSON.stringify(pool.compute),
        pool.min,
        pool.max,
        JSON.stringify(pool.config),
        this.tenantId,
        ts,
        ts,
      );
    return pool;
  }

  /** Get a pool by name. Returns null if not found. */
  async getPool(name: string): Promise<ComputePool | null> {
    const row = (await this.app.db
      .prepare("SELECT * FROM compute_pools WHERE name = ? AND tenant_id = ?")
      .get(name, this.tenantId)) as ComputePoolRow | undefined;
    if (!row) return null;
    return this._rowToPool(row);
  }

  /** Delete a pool definition. Returns true if deleted. */
  async deletePool(name: string): Promise<boolean> {
    const result = await this.app.db
      .prepare("DELETE FROM compute_pools WHERE name = ? AND tenant_id = ?")
      .run(name, this.tenantId);
    return (result?.changes ?? 0) > 0;
  }

  /**
   * Request a compute from the pool.
   * Returns an available (idle) compute, or provisions a new one if under max.
   */
  async requestCompute(poolName: string): Promise<Compute> {
    const pool = await this.getPool(poolName);
    if (!pool) throw new Error(`Pool '${poolName}' not found`);

    // Find computes belonging to this pool that are not assigned to any running session
    const poolComputes = await this._getPoolComputes(poolName);
    const runningSessions = await this.app.sessions.list({ status: "running" });
    const busyComputeNames = new Set(runningSessions.map((s) => s.compute_name).filter(Boolean) as string[]);

    // Find an idle compute in the pool
    const idle = poolComputes.find((c) => !busyComputeNames.has(c.name) && c.status === "running");
    if (idle) return idle;

    // Check if we can provision a new one
    if (poolComputes.length >= pool.max) {
      throw new Error(`Pool '${poolName}' at max capacity (${pool.max})`);
    }

    // Create a new compute in the pool from the pool's (compute_kind,
    // isolation_kind) pair.
    const idx = poolComputes.length + 1;
    const computeName = `${poolName}-${idx}`;
    await this.app.computeService.create({
      name: computeName,
      compute: pool.compute.compute_kind,
      isolation: pool.compute.isolation_kind,
      config: { ...pool.config, pool: poolName },
    });

    // Provision via the new ComputeTarget API.
    const computeImpl = this.app.getCompute(pool.compute.compute_kind);
    if (computeImpl) {
      await computeImpl.provision({ config: { ...pool.config, pool: poolName } });
      await this.app.computes.update(computeName, { status: "running" });
    }

    return (await this.app.computes.get(computeName))!;
  }

  /** Release a compute back to the pool after session completes. */
  async releaseCompute(poolName: string, _computeName: string): Promise<void> {
    const pool = await this.getPool(poolName);
    if (!pool) return;

    // The compute stays running but becomes available for new sessions.
    // If we're over min instances, we could optionally stop it.
    const poolComputes = await this._getPoolComputes(poolName);
    const runningSessions = await this.app.sessions.list({ status: "running" });
    const checks = await Promise.all(
      runningSessions.map(async (s) => (s.compute_name ? await this._isPoolCompute(s.compute_name, poolName) : false)),
    );
    const busyCount = checks.filter(Boolean).length;

    // If after release we have more running than min, and this compute
    // would be excess, mark it for potential cleanup (but don't destroy yet).
    if (poolComputes.length > pool.min && busyCount <= pool.min) {
      // Keep it warm for now -- a background cleanup can reap excess later
    }
  }

  /** List all pools with their current utilization. */
  async listPools(): Promise<ComputePoolStatus[]> {
    const rows = (await this.app.db
      .prepare("SELECT * FROM compute_pools WHERE tenant_id = ? ORDER BY name")
      .all(this.tenantId)) as ComputePoolRow[];
    const runningSessions = await this.app.sessions.list({ status: "running" });

    const out: ComputePoolStatus[] = [];
    for (const row of rows) {
      const pool = this._rowToPool(row);
      const poolComputes = await this._getPoolComputes(pool.name);
      const busyNames = new Set<string>();
      for (const s of runningSessions) {
        if (s.compute_name && (await this._isPoolCompute(s.compute_name, pool.name))) {
          busyNames.add(s.compute_name);
        }
      }
      const active = busyNames.size;
      const available = poolComputes.filter((c) => !busyNames.has(c.name) && c.status === "running").length;
      out.push({ ...pool, active, available });
    }
    return out;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private _rowToPool(row: ComputePoolRow): ComputePool {
    let config: Record<string, unknown> = {};
    let compute: ComputeAxes = { compute_kind: "k8s", isolation_kind: "direct" };
    try {
      config = JSON.parse(row.config);
    } catch {
      logDebug("pool", "default");
    }
    try {
      compute = JSON.parse(row.compute);
    } catch {
      logDebug("pool", "default");
    }
    return {
      name: row.name,
      compute,
      min: row.min_instances,
      max: row.max_instances,
      config,
    };
  }

  private async _getPoolComputes(poolName: string): Promise<Compute[]> {
    const all = await this.app.computes.list();
    const out: Compute[] = [];
    for (const c of all) {
      if (await this._isPoolCompute(c.name, poolName)) out.push(c);
    }
    return out;
  }

  private async _isPoolCompute(computeName: string, poolName: string): Promise<boolean> {
    // Pool computes are named <poolName>-<N> or have pool config
    if (computeName.startsWith(`${poolName}-`)) return true;
    const compute = await this.app.computes.get(computeName);
    if (compute && (compute.config as Record<string, unknown>)?.pool === poolName) return true;
    return false;
  }
}
