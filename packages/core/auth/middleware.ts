/**
 * Auth middleware for multi-tenant access control.
 *
 * Used by the hosted web server (`packages/core/hosted/web.ts`) which
 * fronts `/api/rpc` for the dashboard. The conductor's WS upgrade path
 * uses a separate but parallel resolver in `auth/context.ts`
 * (`materializeContext`); the two surfaces stay in sync semantically.
 *
 * Resolution order (first hit wins):
 *   1. Bearer token (Authorization header) -- API key auth
 *   2. ?token=<token> query param -- legacy compat
 *   3. Cookie -- the `ark_session` cookie set by the OIDC login flow,
 *      validated via AuthSessionManager when wired
 *
 * Cookie support is opt-in: callers that don't pass `authSessions` /
 * `cookieName` skip the cookie branch entirely. This keeps the legacy
 * call sites (no cookie context available) working unchanged.
 */

import type { TenantContext } from "../../types/index.js";
import type { ApiKeyManager } from "./api-keys.js";
import type { AuthSessionManager } from "./sessions.js";
import { getSessionCookie } from "./cookies.js";

export interface AuthConfig {
  enabled: boolean;
  apiKeyEnabled: boolean;
}

/** Default auth config -- auth disabled for backward compat. */
export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  enabled: false,
  apiKeyEnabled: false,
};

/** Default tenant context for unauthenticated / single-tenant mode. */
export const DEFAULT_TENANT_CONTEXT: TenantContext = {
  tenantId: "default",
  userId: "local",
  role: "admin",
  scopingUserId: null,
  teamChain: [],
};

export interface ExtractTenantContextOptions {
  /** When provided alongside `cookieName`, enables cookie-based auth. */
  authSessions?: AuthSessionManager | null;
  /** Cookie name to look up. Typically `config.authSection.session.cookieName`. */
  cookieName?: string | null;
}

/**
 * Which credential resolved the context. Drives downstream gates that only
 * apply on cookie-authed callers (Origin allowlist) and not on Bearer
 * (CSRF-immune, no browser auto-attach).
 */
export type AuthSource = "bearer" | "cookie" | "default";

export interface ResolvedTenantContext {
  ctx: TenantContext;
  source: AuthSource;
}

/**
 * Extract tenant context from an HTTP request.
 *
 * Returns null if no valid credentials found and auth is enabled.
 * Returns DEFAULT_TENANT_CONTEXT if auth is disabled.
 */
export async function extractTenantContext(
  req: Request,
  config: AuthConfig,
  apiKeyManager: ApiKeyManager | null,
  opts: ExtractTenantContextOptions = {},
): Promise<TenantContext | null> {
  const resolved = await extractTenantContextWithSource(req, config, apiKeyManager, opts);
  return resolved ? resolved.ctx : null;
}

/**
 * Same as `extractTenantContext` but also reports which credential
 * resolved the context. Use this when downstream code needs to apply
 * cookie-only gates (e.g. Origin allowlist on `/api/rpc` write methods).
 */
export async function extractTenantContextWithSource(
  req: Request,
  config: AuthConfig,
  apiKeyManager: ApiKeyManager | null,
  opts: ExtractTenantContextOptions = {},
): Promise<ResolvedTenantContext | null> {
  if (!config.enabled) {
    return { ctx: DEFAULT_TENANT_CONTEXT, source: "default" };
  }

  // Try Bearer token
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ") && apiKeyManager) {
    const token = auth.slice(7);
    const ctx = await apiKeyManager.validate(token);
    if (ctx) return { ctx, source: "bearer" };
  }

  // Try query param (backward compat)
  const url = new URL(req.url);
  const qToken = url.searchParams.get("token");
  if (qToken && apiKeyManager) {
    const ctx = await apiKeyManager.validate(qToken);
    if (ctx) return { ctx, source: "bearer" };
  }

  // Try the OIDC session cookie. Bearer-first precedence above already
  // ran -- cookie is the fallback when no Bearer was supplied. The
  // `getSessionCookie` helper fails closed on duplicate cookie headers
  // (cookie-tossing defense).
  if (opts.authSessions && opts.cookieName) {
    const cookieValue = getSessionCookie(req, opts.cookieName);
    if (cookieValue) {
      const ctx = await opts.authSessions.validate(cookieValue);
      if (ctx) return { ctx, source: "cookie" };
    }
  }

  return null;
}

/**
 * Check if a tenant context has sufficient permissions for a write operation.
 * Viewers cannot perform write operations.
 */
export function canWrite(ctx: TenantContext): boolean {
  return ctx.role === "admin" || ctx.role === "member";
}

/**
 * Check if a tenant context has admin permissions.
 */
export function isAdmin(ctx: TenantContext): boolean {
  return ctx.role === "admin";
}
