import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { useTransport } from "../transport/TransportContext.js";

interface LoginPageProps {
  /**
   * Called after a successful API-key sign-in. Receives the validated
   * key so the host can refresh AuthContext / re-probe whoami.
   */
  onLogin: (token: string) => void;
}

/**
 * Phase 1 login page.
 *
 * Two paths:
 *   - **Google sign-in (default surface)**: a top-level navigation to
 *     `/auth/google/start`. The conductor mints the OAuth state cookie,
 *     redirects to Google, and on success bounces back to `/` with a
 *     session cookie set.
 *   - **API key (collapsed)**: legacy flow under a `<details>` element.
 *     Used by power users / programmatic callers who already hold a key.
 *
 * Inline error banner: when the conductor lands the user back on this
 * page with `#login?error=<code>` (currently only
 * `google_not_configured`), we parse the hash and surface a one-line
 * message. Unknown codes are ignored.
 */
export function LoginPage({ onLogin }: LoginPageProps) {
  const transport = useTransport();
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [hashError, setHashError] = useState<string | null>(null);

  // Parse `#login?error=<code>` on mount. The hash-router shape is
  // `#<view>?<query>`; we only react to the `error` parameter.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash || "";
    const qIndex = hash.indexOf("?");
    if (qIndex < 0) return;
    const params = new URLSearchParams(hash.slice(qIndex + 1));
    const code = params.get("error");
    if (code === "google_not_configured") {
      setHashError("Google sign-in is not enabled on this deployment.");
    }
  }, []);

  const handleGoogle = () => {
    // Top-level navigation -- the conductor takes over from here. If
    // Google login isn't configured, it will redirect back with
    // `?error=google_not_configured` which the effect above surfaces.
    window.location.assign("/auth/google/start");
  };

  const handleSwitchAccount = () => {
    // ?force=1 makes the conductor add `prompt=select_account` to the
    // Google OAuth URL, forcing Google to show the account picker even
    // when it would normally skip it (recent-selection cache). Used by
    // multi-account users who need to switch from their cached choice.
    window.location.assign("/auth/google/start?force=1");
  };

  const handleApiKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) {
      setError("API key is required");
      return;
    }
    setLoading(true);
    setError("");
    transport.setToken(key);
    try {
      await transport.rpc("session/list", {});
      onLogin(key);
    } catch (err) {
      transport.setToken(null);
      const message = err instanceof Error ? err.message : "";
      if (/auth|unauthor|401/i.test(message)) {
        setError("Invalid API key");
      } else if (message) {
        setError(message);
      } else {
        setError("Connection failed - is the server running?");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="w-full max-w-sm mx-auto px-6">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-foreground mb-2">Ark</h1>
          <p className="text-sm text-muted-foreground">Sign in to continue</p>
        </div>

        {hashError && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {hashError}
          </div>
        )}

        <Button onClick={handleGoogle} className="w-full" type="button">
          Sign in with Google
        </Button>

        <button
          type="button"
          onClick={handleSwitchAccount}
          className="mt-2 w-full text-center text-xs text-muted-foreground hover:text-foreground bg-transparent border-0 cursor-pointer"
        >
          Use a different account
        </button>

        <details className="mt-6 group">
          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground select-none">
            Use an API key instead
          </summary>
          <form onSubmit={handleApiKeySubmit} className="space-y-4 mt-4">
            <div>
              <Input
                type="password"
                placeholder="API Key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                disabled={loading}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading || !key.trim()} variant="secondary">
              {loading ? "Authenticating..." : "Sign in with API key"}
            </Button>
          </form>
        </details>
      </div>
    </div>
  );
}
