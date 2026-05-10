/**
 * Team-chain walker for the auth scoping resolver.
 *
 * Returns the chain `[team, parent, grandparent, ..., hod]` -- the input
 * team and every live ancestor walked via `parent_team_id` until NULL.
 * Excludes the tenant level (the resolver appends `tenant_id` separately).
 *
 * Decision #5: fail closed. A cycle (visited-set hit) or hitting the depth
 * cap (default 8) throws `TeamChainError` carrying the offending team_id.
 * `LoginManager` translates this to `LoginError(kind: "chain-broken")`; the
 * route handler maps to a generic 401 and the daemon logs the bad team_id
 * for ops to fix in SQL. Truncate-and-warn loses the warning in noisy logs
 * and lets users silently get the wrong policy for weeks; fail-closed
 * surfaces the data bug at the moment it matters.
 *
 * If a team in the chain is soft-deleted (or simply missing), the walk
 * stops at the previous live team -- the chain returned excludes the
 * tombstoned ancestor.
 */

export class TeamChainError extends Error {
  constructor(
    public readonly kind: "cycle" | "depth-cap",
    public readonly atTeamId: string,
  ) {
    super(`team chain ${kind} at ${atTeamId}`);
    this.name = "TeamChainError";
  }
}

/**
 * Minimal repo dependency: a single-hop "give me the parent of this live
 * team" lookup. Kept narrow on purpose so the walker is unit-testable
 * with an in-memory map.
 *
 *   - `string`     -> parent team id
 *   - `null`       -> team exists but parent_team_id is NULL (top-of-tenant)
 *   - `undefined`  -> team is soft-deleted or does not exist (stop walk)
 */
export interface TeamParentLookup {
  getParentTeamId(teamId: string): Promise<string | null | undefined>;
}

const DEFAULT_DEPTH_CAP = 8;

export async function getAncestorChain(
  repo: TeamParentLookup,
  teamId: string,
  opts: { depthCap?: number } = {},
): Promise<string[]> {
  const cap = opts.depthCap ?? DEFAULT_DEPTH_CAP;
  const chain: string[] = [];
  const visited = new Set<string>();

  let current: string | null = teamId;
  while (current !== null) {
    if (visited.has(current)) {
      throw new TeamChainError("cycle", current);
    }
    // Resolve parent first so that a soft-deleted or missing team
    // (`undefined`) is excluded from the chain rather than pushed.
    const parent = await repo.getParentTeamId(current);
    if (parent === undefined) break;

    visited.add(current);
    chain.push(current);

    if (chain.length > cap) {
      throw new TeamChainError("depth-cap", current);
    }

    current = parent;
  }

  return chain;
}
