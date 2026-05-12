/**
 * AuthContext -- single source of truth for auth state in the web bundle.
 *
 * State machine (Phase 1):
 *
 *   checking ── whoami() resolves to non-null identity ──> authed
 *   checking ── whoami() returns null OR throws ─────────> anonymous
 *   authed   ── window event "ark:auth-required" ────────> anonymous
 *   anonymous── refresh() called with non-null identity ─> authed
 *
 * The "ark:auth-required" event is dispatched by `HttpTransport` when an
 * RPC returns 401 -- a stale cookie, a revoked Bearer, or a tenant-scope
 * 401 all collapse to the same recovery: drop to login. Phase 2 may
 * refine.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useTransport } from "../transport/TransportContext.js";
import { whoami, type Identity } from "./whoami.js";

export type AuthStatus = "checking" | "authed" | "anonymous";

export interface AuthContextValue {
  status: AuthStatus;
  identity: Identity | null;
  /** Force a fresh whoami probe -- used after login flows complete. */
  refresh: () => Promise<void>;
  /** Drop to anonymous and clear in-memory identity. UI then renders LoginPage. */
  signOut: () => void;
}

/**
 * Exported so unit tests can wrap renders with `<AuthContext.Provider
 * value={...}>` and synthesize a logged-in identity without going
 * through the real whoami round-trip (which uses `useEffect`, which
 * doesn't fire under SSR `renderToString`).
 */
export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const transport = useTransport();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [status, setStatus] = useState<AuthStatus>("checking");

  const refresh = useCallback(async (): Promise<void> => {
    const next = await whoami(transport);
    setIdentity(next);
    setStatus(next ? "authed" : "anonymous");
  }, [transport]);

  const signOut = useCallback((): void => {
    // Clear any stored Bearer token so it can't shadow a subsequent
    // cookie-based login. Without this, signing out of a Google session
    // and then signing back in via Google would leave a stale API-key
    // Bearer in localStorage that Bearer-first precedence would prefer
    // over the new cookie -- the user gets silently re-authed as the
    // earlier api-key identity instead of their Google identity.
    transport.setToken(null);
    setIdentity(null);
    setStatus("anonymous");
  }, [transport]);

  // Boot probe.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Global 401 listener (HttpTransport dispatches on any 401 from /api/rpc).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onAuthRequired = () => signOut();
    window.addEventListener("ark:auth-required", onAuthRequired);
    return () => window.removeEventListener("ark:auth-required", onAuthRequired);
  }, [signOut]);

  return <AuthContext.Provider value={{ status, identity, refresh, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/**
 * Variant for callers that work fine without auth context (e.g. layout
 * shells used in unit tests that render-to-string outside the App tree).
 * Returns null when no provider is mounted; never throws.
 */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}
