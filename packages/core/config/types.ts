/**
 * Typed AppConfig shape -- Spring-Boot-style nested sections.
 *
 * This is the future-facing config surface. The legacy flat fields on
 * `ArkConfig` are retained for back-compat and will be derived from
 * these nested sections during the transition.
 *
 * Every field has an `@envvar` TSDoc tag naming the env var that
 * overrides it, so `ARK_*` vars are discoverable from the type itself.
 */

/** Active profile -- selected by explicit arg, `ARK_PROFILE`, or heuristics. */
export type ArkProfile = "local" | "control-plane" | "test";

/** Filesystem locations. */
export interface DirsConfig {
  /**
   * Ark home directory. Contains ark.db, logs, user-defined
   * agents/flows/skills, etc.
   * @envvar ARK_DIR (preferred) / ARK_TEST_DIR (legacy)
   * @default ~/.ark
   */
  ark: string;
  /**
   * Worktrees dir for session branches.
   * @default {dirs.ark}/worktrees
   */
  worktrees: string;
  /**
   * Tracks dir for session transcripts / state.
   * @default {dirs.ark}/tracks
   */
  tracks: string;
  /**
   * Log directory.
   * @default {dirs.ark}/logs
   */
  logs: string;
  /**
   * Scratch / temp dir for short-lived state.
   * @default {dirs.ark}/tmp
   */
  tmp: string;
}

/** Network ports. */
export interface PortsConfig {
  /**
   * Merged conductor + server daemon HTTP port.
   * @envvar ARK_CONDUCTOR_PORT
   * @default 19400 (test profile: random)
   */
  conductor: number;
  /**
   * Arkd agent-proxy port.
   * @envvar ARK_ARKD_PORT
   * @default 19300 (test profile: random)
   */
  arkd: number;
  /**
   * Web dashboard port.
   * @envvar ARK_WEB_PORT
   * @default 8420 (test profile: random)
   */
  web: number;
}

/** Database connection. */
export interface DatabaseConfig {
  /**
   * Database URL. Undefined means local SQLite at {dirs.ark}/ark.db.
   * A `postgres://` URL selects the Postgres adapter (control-plane).
   * @envvar DATABASE_URL
   */
  url?: string;
}

/** Channel port allocation for session IPC. */
export interface ChannelsConfig {
  /**
   * Base port for channel hash: port = basePort + (hash(sessionId) % range).
   * @envvar ARK_CHANNEL_BASE_PORT
   * @default 19200 (test profile: randomized by port allocator)
   */
  basePort: number;
  /**
   * Range size for the channel port hash modulus.
   * @envvar ARK_CHANNEL_RANGE
   * @default 10000 (test profile: 1000)
   */
  range: number;
}

/** Observability knobs. */
export interface ObservabilityConfig {
  /**
   * OTLP collector endpoint (OpenTelemetry traces/spans).
   * @envvar ARK_OTLP_ENDPOINT
   */
  otlpEndpoint?: string;
  /**
   * Root log level. Components can override via `setLogComponents`.
   * @envvar ARK_LOG_LEVEL
   * @default "info" (test profile: "error")
   */
  logLevel: "debug" | "info" | "warn" | "error";
}

/** Auth / multi-tenancy. */
export interface AuthSectionConfig {
  /**
   * Require a bearer token on the public API.
   * @envvar ARK_AUTH_REQUIRE_TOKEN
   * @default false (local / test), true (control-plane)
   */
  requireToken: boolean;
  /**
   * Tenant id used when no explicit tenant is provided on an API call.
   * @envvar ARK_DEFAULT_TENANT
   * @default null
   */
  defaultTenant: string | null;
  /** Google OIDC settings for the cookie-based web login flow. */
  google: GoogleAuthConfig;
  /** Server-side auth session (cookie) lifetime + naming. */
  session: AuthSessionConfig;
}

/** Google OIDC settings for the cookie-based web login flow (Phase 1). */
export interface GoogleAuthConfig {
  /**
   * OAuth 2.0 client id registered with Google for the Foundry web app.
   * Used as the `aud` claim when verifying ID tokens.
   * `null` disables the Google login flow.
   * @envvar ARK_AUTH_GOOGLE_CLIENT_ID
   * @default null (no Google login configured)
   */
  clientId: string | null;
  /**
   * OAuth 2.0 client secret. Used server-side at the token-exchange step
   * (`POST oauth2.googleapis.com/token`). Sensitive: read ONLY from
   * `process.env.ARK_AUTH_GOOGLE_CLIENT_SECRET`. NEVER persisted to YAML,
   * config.yaml, DB, or any committed file. Deployment injects via K8s
   * Secret / Compose secret / shell env. Never logged, never sent to
   * clients.
   * @envvar ARK_AUTH_GOOGLE_CLIENT_SECRET
   * @default null (no Google login configured)
   */
  clientSecret: string | null;
  /**
   * Redirect URI registered with Google's OAuth client. Must match the
   * URL Google bounces the user back to after consent (e.g.
   * `http://localhost:8420/auth/google/callback` for local dev,
   * `https://foundry.paytm.com/auth/google/callback` for hosted).
   * @envvar ARK_AUTH_GOOGLE_REDIRECT_URI
   * @default null (deployment must configure)
   */
  redirectUri: string | null;
  /**
   * Allow-list of Google hosted domains. The token's `hd` claim must equal
   * one of these for the login to succeed. Paytm has multiple Google
   * Workspace domains (paytm.com for OCL, paytmpayments.com for PPSL,
   * paytmmoney.com for PML, etc.) so this is a list rather than a single
   * value. Empty list rejects every login (defensive default if mis-configured).
   * @envvar ARK_AUTH_GOOGLE_ALLOWED_DOMAINS  (comma-separated, e.g.
   *   `paytm.com,paytmpayments.com,paytmmoney.com`)
   * @default ["paytm.com"] (covers OCL out of the box; deployment adds
   *   PPSL / PML / others as needed)
   */
  allowedDomains: string[];
}

/** Server-side auth session (cookie) settings (Phase 1). */
export interface AuthSessionConfig {
  /**
   * Sliding TTL for an auth session, in seconds. `expires_at` is bumped to
   * `now + ttlSec` on each authenticated request.
   * @envvar ARK_AUTH_SESSION_TTL_SEC
   * @default 2592000 (30 days)
   */
  ttlSec: number;
  /**
   * Name of the session cookie set on the browser.
   * @envvar ARK_AUTH_SESSION_COOKIE_NAME
   * @default "ark_session"
   */
  cookieName: string;
  /**
   * Cookie `Domain` attribute. `null` produces a host-only cookie (the
   * cookie is sent only back to the exact host that set it). Set to e.g.
   * `.paytm.com` to share the cookie across subdomains.
   * @envvar ARK_AUTH_SESSION_COOKIE_DOMAIN
   * @default null (host-only)
   */
  cookieDomain: string | null;
  /**
   * Cookie `Secure` attribute. When `true`, the browser sends the cookie
   * ONLY over HTTPS. Production must set this true; local HTTP dev must
   * set this false. Explicit field rather than inference from NODE_ENV.
   * @envvar ARK_AUTH_SESSION_COOKIE_SECURE
   * @default false (local / test) / true (control-plane)
   */
  cookieSecure: boolean;
  /**
   * Refresh threshold for sliding expiry, in seconds. The middleware
   * touches `expires_at` on an authenticated request only when
   * `now - last_seen_at > refreshThresholdSec` OR remaining TTL has
   * dropped below half of `ttlSec`. Cuts DB writes by orders of magnitude
   * vs touching on every single request.
   * @envvar ARK_AUTH_SESSION_REFRESH_THRESHOLD_SEC
   * @default 300 (5 minutes)
   */
  refreshThresholdSec: number;
  /**
   * Allow-list of browser origins for cookie-authenticated state-changing
   * requests (POST/PUT/PATCH/DELETE) and WebSocket upgrades. Cookie-auth
   * GET / HEAD / OPTIONS skip the check (browser top-level navigation may
   * omit `Origin`). Bearer-token requests bypass the check entirely.
   * Empty list = no cookie-auth state-changing request from any origin
   * is admitted (deliberate fail-closed default for hosted deployments).
   * @envvar ARK_AUTH_SESSION_ALLOWED_ORIGINS  (comma-separated, e.g.
   *   `https://foundry.paytm.com,https://foundry-staging.paytm.com`)
   * @default ["http://localhost:8420"] (local) / [] (control-plane,
   *   deployment must configure) / [] (test)
   */
  allowedOrigins: string[];
  /**
   * Where the OAuth callback redirects the browser after a successful
   * Google login. In production deployments the dashboard SPA is served
   * by the same host as the daemon, so the default `/` lands the user
   * on the dashboard. In local development the dashboard runs on a
   * separate Vite host (`http://localhost:5173`), so set this to
   * `http://localhost:5173/` to land the user on the dashboard instead
   * of the daemon's bare friendly-landing page.
   * @envvar ARK_AUTH_DASHBOARD_URL
   * @default "/"
   */
  dashboardUrl: string;
}

/** Blob storage -- uploads, exports, anything that can't live on one replica's disk. */
export interface StorageConfig {
  /**
   * Active backend. `local` writes under `{dirs.ark}/blobs`, `s3` writes to
   * the bucket configured below.
   * @envvar ARK_BLOB_BACKEND
   * @default "local" (local/test profile) / "s3" (control-plane profile)
   */
  blobBackend: "local" | "s3";
  /**
   * S3 backend settings. Required when `blobBackend === "s3"`; ignored otherwise.
   * Credentials use the AWS SDK default provider chain (env / shared config / IMDS).
   */
  s3?: {
    /** @envvar ARK_S3_BUCKET */
    bucket: string;
    /** @envvar ARK_S3_REGION */
    region: string;
    /**
     * Key prefix under the bucket root.
     * @envvar ARK_S3_PREFIX
     * @default "ark"
     */
    prefix?: string;
    /**
     * Override endpoint for LocalStack / MinIO. Unset in production.
     * @envvar ARK_S3_ENDPOINT
     */
    endpoint?: string;
  };
}

/** Feature flags. Grep the codebase for new `config.features.*` usage. */
export interface FeaturesConfig {
  /**
   * Enable auto-rebase on agent completion.
   * @envvar ARK_AUTO_REBASE
   */
  autoRebase: boolean;
}

/**
 * Profile defaults -- partial shape, merged by the resolver under env / YAML
 * / programmatic overrides. Profiles export one of these.
 */
export interface ProfileDefaults {
  profile: ArkProfile;
  /** Test profile pre-allocates a dir; other profiles leave undefined. */
  arkDir?: string;
  ports: PortsConfig;
  channels: ChannelsConfig;
  auth: AuthSectionConfig;
  features: FeaturesConfig;
  observability: { logLevel: ObservabilityConfig["logLevel"] };
  storage: StorageConfig;
}
