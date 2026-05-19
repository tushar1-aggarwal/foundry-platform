/**
 * Shared backfill for migration 026 -- maps the old single-axis provider
 * names stored on `tenant_policies` into `(compute_kind, isolation_kind)`
 * pairs and rewrites the `compute_pools` JSON.
 *
 * The mapping table is dialect-agnostic; both the SQLite and Postgres
 * halves call `backfillTwoAxis` after the new columns exist and before the
 * old columns are dropped.
 */

import type { DatabaseAdapter } from "../database/index.js";
import type { ComputeAxes } from "../../types/index.js";
import { logDebug } from "../observability/structured-log.js";

/**
 * Exact provider-name -> ComputeAxes map. Any name not listed here
 * (firecracker, k8s-kata, remote-*, empty, etc.) collapses to
 * { k8s, direct }.
 */
function nameToAxes(name: string | null | undefined): ComputeAxes {
  switch ((name ?? "").trim()) {
    case "local":
      return { compute_kind: "local", isolation_kind: "direct" };
    case "docker":
      return { compute_kind: "local", isolation_kind: "docker" };
    case "devcontainer":
      return { compute_kind: "local", isolation_kind: "devcontainer" };
    case "ec2":
      return { compute_kind: "ec2", isolation_kind: "direct" };
    case "ec2-docker":
      return { compute_kind: "ec2", isolation_kind: "docker" };
    case "ec2-devcontainer":
      return { compute_kind: "ec2", isolation_kind: "devcontainer" };
    case "k8s":
      return { compute_kind: "k8s", isolation_kind: "direct" };
    default:
      return { compute_kind: "k8s", isolation_kind: "direct" };
  }
}

interface OldPolicyRow {
  tenant_id: string;
  allowed_providers: string | null;
  default_provider: string | null;
  compute_pools: string | null;
}

function rewritePools(raw: string | null): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch {
    return "[]";
  }
  if (!Array.isArray(parsed)) return "[]";
  const out = parsed.map((el) => {
    if (el && typeof el === "object") {
      const e = el as Record<string, unknown>;
      // Already two-axis -- leave it alone.
      if (e.compute && typeof e.compute === "object") return e;
      const { provider, ...rest } = e;
      return { ...rest, compute: nameToAxes(typeof provider === "string" ? provider : null) };
    }
    return el;
  });
  return JSON.stringify(out);
}

export async function backfillTwoAxis(db: DatabaseAdapter): Promise<void> {
  let rows: OldPolicyRow[];
  try {
    rows = (await db
      .prepare("SELECT tenant_id, allowed_providers, default_provider, compute_pools FROM tenant_policies")
      .all()) as OldPolicyRow[];
  } catch {
    // Old columns already dropped (idempotent re-run) -- nothing to backfill.
    logDebug("general", "tenant_policies two-axis backfill: old columns absent, skipping");
    return;
  }

  for (const row of rows) {
    let allowedNames: string[] = [];
    try {
      const parsed = JSON.parse(row.allowed_providers ?? "[]");
      if (Array.isArray(parsed)) allowedNames = parsed.filter((n): n is string => typeof n === "string");
    } catch {
      allowedNames = [];
    }

    // Dedupe identical axis pairs produced by the collapse map.
    const seen = new Set<string>();
    const allowedCompute: ComputeAxes[] = [];
    for (const n of allowedNames) {
      const axes = nameToAxes(n);
      const key = `${axes.compute_kind}/${axes.isolation_kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allowedCompute.push(axes);
    }

    const defaultCompute = nameToAxes(row.default_provider);
    const pools = rewritePools(row.compute_pools);

    await db
      .prepare(
        "UPDATE tenant_policies SET allowed_compute = ?, default_compute = ?, compute_pools = ? WHERE tenant_id = ?",
      )
      .run(JSON.stringify(allowedCompute), JSON.stringify(defaultCompute), pools, row.tenant_id);
  }
}
