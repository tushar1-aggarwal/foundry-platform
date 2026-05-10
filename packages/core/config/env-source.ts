/**
 * Env-var source: collect ARK_* variables and coerce them into
 * partial-shape overrides for the config resolver.
 *
 * Unknown env vars are ignored -- this is not the place to error on
 * typos (Spring Boot's approach: log once, don't crash). Type coercion
 * is strict: a malformed integer logs a warning and is dropped, rather
 * than silently becoming NaN.
 *
 * This module is pure: given `env`, it returns a partial overrides
 * object. The resolver composes it with YAML / profile defaults.
 */

import type {
  PortsConfig,
  ChannelsConfig,
  ObservabilityConfig,
  AuthSectionConfig,
  GoogleAuthConfig,
  AuthSessionConfig,
  FeaturesConfig,
  StorageConfig,
} from "./types.js";

export interface EnvSecretsOverrides {
  backend?: "file" | "aws";
  awsRegion?: string;
  awsKmsKeyId?: string;
}

/**
 * Sparse-partial AuthSectionConfig override. Nested objects (`google`,
 * `session`) are themselves `Partial<...>` so a deployment that sets
 * only `ARK_AUTH_GOOGLE_CLIENT_ID` does NOT also overwrite
 * `allowedDomains` with hard-coded defaults -- the unset field falls
 * through to whatever the profile defaults provided.
 */
export interface AuthEnvOverrides {
  requireToken?: AuthSectionConfig["requireToken"];
  defaultTenant?: AuthSectionConfig["defaultTenant"];
  google?: Partial<GoogleAuthConfig>;
  session?: Partial<AuthSessionConfig>;
}

export interface EnvOverrides {
  arkDir?: string;
  ports: Partial<PortsConfig>;
  channels: Partial<ChannelsConfig>;
  observability: Partial<ObservabilityConfig>;
  auth: AuthEnvOverrides;
  features: Partial<FeaturesConfig>;
  storage: Partial<StorageConfig>;
  secrets: EnvSecretsOverrides;
  databaseUrl?: string;
  redisUrl?: string;
}

function parseIntStrict(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    // Non-fatal: warn and drop so the rest of the config still resolves.
    // We can't use the structured logger here (it depends on config),
    // so fall back to console.
    console.warn(`[config] ${name}=${raw} is not an integer -- ignored`);
    return undefined;
  }
  return n;
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

function parseLogLevel(raw: string | undefined): ObservabilityConfig["logLevel"] | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return undefined;
}

/**
 * Parse a comma-separated list of domains, trimming whitespace and dropping
 * empty entries. Returns undefined when the env var is unset or empty so
 * the resolver can fall back to defaults.
 */
function parseDomainList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

/**
 * Parse a comma-separated list of browser origins (e.g. `https://foo.com,
 * http://localhost:8420`). Same shape as `parseDomainList` but kept separate
 * because origin values may contain `:port` and the semantic intent is
 * different. Returns undefined for unset/empty so profile defaults apply.
 */
function parseOriginList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

/** Read the current process env into a typed overrides object. */
export function readEnv(env: NodeJS.ProcessEnv = process.env): EnvOverrides {
  const out: EnvOverrides = {
    ports: {},
    channels: {},
    observability: {},
    auth: {},
    features: {},
    storage: {},
    secrets: {},
  };

  // Dirs
  if (env.ARK_DIR) out.arkDir = env.ARK_DIR;
  else if (env.ARK_TEST_DIR) out.arkDir = env.ARK_TEST_DIR;

  // Ports
  // ARK_CONDUCTOR_PORT sets the merged conductor port (was 19100, now 19400).
  const conductor = parseIntStrict(env.ARK_CONDUCTOR_PORT, "ARK_CONDUCTOR_PORT");
  if (conductor !== undefined) out.ports.conductor = conductor;
  const arkd = parseIntStrict(env.ARK_ARKD_PORT, "ARK_ARKD_PORT");
  if (arkd !== undefined) out.ports.arkd = arkd;
  const web = parseIntStrict(env.ARK_WEB_PORT, "ARK_WEB_PORT");
  if (web !== undefined) out.ports.web = web;

  // Channels
  const chBase = parseIntStrict(env.ARK_CHANNEL_BASE_PORT, "ARK_CHANNEL_BASE_PORT");
  if (chBase !== undefined) out.channels.basePort = chBase;
  const chRange = parseIntStrict(env.ARK_CHANNEL_RANGE, "ARK_CHANNEL_RANGE");
  if (chRange !== undefined) out.channels.range = chRange;

  // Observability
  const level = parseLogLevel(env.ARK_LOG_LEVEL);
  if (level) out.observability.logLevel = level;
  if (env.ARK_OTLP_ENDPOINT) out.observability.otlpEndpoint = env.ARK_OTLP_ENDPOINT;

  // Auth
  const requireTok = parseBool(env.ARK_AUTH_REQUIRE_TOKEN);
  if (requireTok !== undefined) out.auth.requireToken = requireTok;
  if (env.ARK_DEFAULT_TENANT) out.auth.defaultTenant = env.ARK_DEFAULT_TENANT;

  // Auth -- Google OIDC (Phase 1 cookie login flow). Set only the fields
  // actually present in env so unset ones fall through to profile defaults.
  if (env.ARK_AUTH_GOOGLE_CLIENT_ID !== undefined) {
    out.auth.google = { ...out.auth.google, clientId: env.ARK_AUTH_GOOGLE_CLIENT_ID };
  }
  if (env.ARK_AUTH_GOOGLE_CLIENT_SECRET !== undefined) {
    out.auth.google = { ...out.auth.google, clientSecret: env.ARK_AUTH_GOOGLE_CLIENT_SECRET };
  }
  if (env.ARK_AUTH_GOOGLE_REDIRECT_URI !== undefined) {
    out.auth.google = { ...out.auth.google, redirectUri: env.ARK_AUTH_GOOGLE_REDIRECT_URI };
  }
  const allowedDomains = parseDomainList(env.ARK_AUTH_GOOGLE_ALLOWED_DOMAINS);
  if (allowedDomains !== undefined) {
    out.auth.google = { ...out.auth.google, allowedDomains };
  }

  // Auth -- session cookie. Same sparse-partial pattern.
  const sessionTtl = parseIntStrict(env.ARK_AUTH_SESSION_TTL_SEC, "ARK_AUTH_SESSION_TTL_SEC");
  if (sessionTtl !== undefined) {
    out.auth.session = { ...out.auth.session, ttlSec: sessionTtl };
  }
  if (env.ARK_AUTH_SESSION_COOKIE_NAME !== undefined) {
    out.auth.session = { ...out.auth.session, cookieName: env.ARK_AUTH_SESSION_COOKIE_NAME };
  }
  if (env.ARK_AUTH_SESSION_COOKIE_DOMAIN !== undefined) {
    out.auth.session = { ...out.auth.session, cookieDomain: env.ARK_AUTH_SESSION_COOKIE_DOMAIN };
  }
  const cookieSecure = parseBool(env.ARK_AUTH_SESSION_COOKIE_SECURE);
  if (cookieSecure !== undefined) {
    out.auth.session = { ...out.auth.session, cookieSecure };
  }
  const refreshThreshold = parseIntStrict(
    env.ARK_AUTH_SESSION_REFRESH_THRESHOLD_SEC,
    "ARK_AUTH_SESSION_REFRESH_THRESHOLD_SEC",
  );
  if (refreshThreshold !== undefined) {
    out.auth.session = { ...out.auth.session, refreshThresholdSec: refreshThreshold };
  }
  const allowedOrigins = parseOriginList(env.ARK_AUTH_SESSION_ALLOWED_ORIGINS);
  if (allowedOrigins !== undefined) {
    out.auth.session = { ...out.auth.session, allowedOrigins };
  }

  // Features
  const autoRebase = parseBool(env.ARK_AUTO_REBASE);
  if (autoRebase !== undefined) out.features.autoRebase = autoRebase;

  // Storage
  const blobBackend = env.ARK_BLOB_BACKEND?.toLowerCase();
  if (blobBackend === "local" || blobBackend === "s3") {
    out.storage.blobBackend = blobBackend;
  }
  if (env.ARK_S3_BUCKET || env.ARK_S3_REGION || env.ARK_S3_PREFIX || env.ARK_S3_ENDPOINT) {
    out.storage.s3 = {
      bucket: env.ARK_S3_BUCKET ?? "",
      region: env.ARK_S3_REGION ?? "",
      prefix: env.ARK_S3_PREFIX,
      endpoint: env.ARK_S3_ENDPOINT,
    };
  }

  // Secrets backend
  const secretsBackend = env.ARK_SECRETS_BACKEND?.toLowerCase();
  if (secretsBackend === "file" || secretsBackend === "aws") {
    out.secrets.backend = secretsBackend;
  }
  if (env.ARK_SECRETS_AWS_REGION) out.secrets.awsRegion = env.ARK_SECRETS_AWS_REGION;
  if (env.ARK_SECRETS_AWS_KMS_KEY_ID) out.secrets.awsKmsKeyId = env.ARK_SECRETS_AWS_KMS_KEY_ID;

  // Database
  if (env.DATABASE_URL) out.databaseUrl = env.DATABASE_URL;
  if (env.REDIS_URL) out.redisUrl = env.REDIS_URL;

  return out;
}
