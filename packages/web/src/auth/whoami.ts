/**
 * Phase 1 `auth/whoami` client wrapper.
 *
 * Calls the JSON-RPC method, normalizes the response shape, and is the
 * single source of truth for "who is the current user?" in the web bundle.
 *
 * Identity-only by design: this wrapper does NOT report deployment
 * configuration (which auth methods are wired, etc.). If a future feature
 * needs that, add a separate config probe -- don't widen `whoami`.
 */
import type { WebTransport } from "../transport/types.js";

export interface Identity {
  userId: string;
  email: string | null;
  tenantId: string;
  role: "admin" | "member" | "viewer" | "worker";
}

interface WhoAmIResponse {
  identity: Identity | null;
}

/**
 * Resolve the current caller's identity. Returns `null` when:
 *   - the caller is anonymous (server-side `ctx.userId === null`),
 *   - the response shape is unrecognized,
 *   - or the RPC throws (treated as anonymous so the UI falls back to
 *     login rather than spinning indefinitely).
 *
 * Network / RPC errors are swallowed by design -- the caller renders the
 * login page on null and re-tries on the next mount.
 */
export async function whoami(transport: WebTransport): Promise<Identity | null> {
  try {
    const res = await transport.rpc<WhoAmIResponse>("auth/whoami");
    return res?.identity ?? null;
  } catch {
    return null;
  }
}
