export interface TenantContext {
  tenantId: string;
  userId: string | null;
  role: "admin" | "member" | "viewer" | "worker";
  /**
   * User id used by the auth scoping resolver for the user-level lookup.
   * Distinct from `userId` so that self-service api-keys (whose `userId`
   * is the `ak-...` sentinel that drives the `requireRealUser` identity
   * gate) still honor their owner's user-level overrides. The two fields
   * are orthogonal: identity gate vs scoping gate.
   *
   *   - cookie auth   -> same as `userId` (the real human's `users.id`)
   *   - owned api-key -> `api_keys.user_id` (the real owner's `users.id`)
   *   - admin-minted  -> null (no user-level overrides apply)
   *   - local mode    -> null
   *   - anonymous     -> null
   */
  scopingUserId: string | null;
  /**
   * Team chain `[team, parent, grandparent, ..., hod]` used by the auth
   * scoping resolver. Computed at login from the user's primary live
   * membership and cached on `sessions_auth.team_chain`. Empty for
   * anonymous / local / admin-minted-api-key callers.
   */
  teamChain: string[];
}

export interface ApiKey {
  id: string;
  tenantId: string;
  keyHash: string;
  name: string;
  role: "admin" | "member" | "viewer" | "worker";
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** Self-service ownership column. NULL for admin-minted / tenant-level
   *  keys. Set to a real users.id when the key was minted via the
   *  self-service `apikey/*` surface. Soft pointer (no FK), matching
   *  `tenantId`'s convention on this table. */
  userId?: string | null;
  /** Soft-delete timestamp (migration 006). Null for live keys. */
  deletedAt?: string | null;
  /** Acting user id recorded at revoke time (migration 006). Null if the
   *  key was revoked by the system / an unauthenticated caller. */
  deletedBy?: string | null;
}
