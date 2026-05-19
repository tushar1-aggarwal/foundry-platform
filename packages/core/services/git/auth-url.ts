/**
 * Build an HTTPS git URL with basic-auth credentials injected, when a
 * tenant-scoped token is available for the URL's host. The resulting URL is
 * safe to hand to `git clone` / `git push` / `git ls-remote`. Hosts we don't
 * recognise pass through unchanged so callers can route the same URL through
 * SSH or a credential helper.
 *
 * Host-specific basic-auth conventions:
 *
 *   - github.com -> `https://x-access-token:<TOKEN>@github.com/...`
 *   - bitbucket.org with email-shaped username (Atlassian API token):
 *     `https://<urlencoded-email>:<TOKEN>@bitbucket.org/...`
 *   - bitbucket.org without username (legacy Bitbucket HTTP access token /
 *     app-password headless form): `https://x-token-auth:<TOKEN>@bitbucket.org/...`
 *
 * Atlassian API tokens (`ATATT...`) only authenticate against Bitbucket Cloud
 * when paired with the owning account's email; the older `x-token-auth:<TOKEN>`
 * shorthand only works for workspace-scoped HTTP access tokens. Storing a
 * `BITBUCKET_USERNAME` alongside `BITBUCKET_TOKEN` lets us serve both token
 * types from a single code path.
 */
import type { OrchestrationDeps } from "../deps.js";
import type { Session } from "../../../types/index.js";

/** Resolve a tenant-scoped secret with a `process.env` fallback for legacy daemons. */
async function resolveSecret(deps: OrchestrationDeps, session: Session, name: string): Promise<string | undefined> {
  try {
    const fromStore = await deps.secrets.get(session.tenant_id, name);
    if (fromStore) return fromStore;
  } catch {
    // Secret store unavailable -- fall through to env fallback.
  }
  return process.env[name] || undefined;
}

export async function resolveGithubToken(deps: OrchestrationDeps, session: Session): Promise<string | undefined> {
  return resolveSecret(deps, session, "GITHUB_TOKEN");
}

export async function resolveBitbucketToken(deps: OrchestrationDeps, session: Session): Promise<string | undefined> {
  return resolveSecret(deps, session, "BITBUCKET_TOKEN");
}

export async function resolveBitbucketUsername(deps: OrchestrationDeps, session: Session): Promise<string | undefined> {
  return resolveSecret(deps, session, "BITBUCKET_USERNAME");
}

/**
 * Rewrite an https URL to embed basic-auth credentials when we have a token
 * for the URL's host. Pass-through when:
 *   - URL is not https
 *   - host has no rewrite rule
 *   - no token is configured for the host
 *
 * The returned string can be passed straight to `execFile("git", [...])`;
 * callers that subsequently log the URL should redact the token (see
 * `redactSecrets` in pr.ts for the existing pattern).
 */
export async function buildAuthedHttpsUrl(deps: OrchestrationDeps, session: Session, url: string): Promise<string> {
  if (!url.startsWith("https://")) return url;

  if (url.startsWith("https://github.com/")) {
    const token = await resolveGithubToken(deps, session);
    if (!token) return url;
    return `https://x-access-token:${token}@${url.slice("https://".length)}`;
  }

  if (url.startsWith("https://bitbucket.org/")) {
    const token = await resolveBitbucketToken(deps, session);
    if (!token) return url;
    const host = url.slice("https://".length);

    // Bitbucket Cloud has three credential flavours, each with a different
    // username sentinel for HTTPS basic-auth on git operations:
    //
    //   - Atlassian API tokens (`ATATT*`): username MUST be
    //     `x-bitbucket-api-token-auth`. The REST API accepts `<email>:<token>`
    //     too, but git-over-HTTPS only accepts the sentinel form -- the same
    //     token returns HTTP 401 when paired with the user's email.
    //   - Legacy Bitbucket app passwords: `<bitbucket-username>:<password>`
    //     (the username here is the user's Bitbucket handle, NOT email).
    //   - Workspace/repo HTTP access tokens: `x-token-auth:<token>`.
    //
    // BITBUCKET_USERNAME is a legacy-app-password signal: if it's set, the
    // operator is using flavour 2 and the username should be passed through.
    // For ATATT tokens we ignore BITBUCKET_USERNAME and use the sentinel.
    if (token.startsWith("ATATT")) {
      return `https://x-bitbucket-api-token-auth:${token}@${host}`;
    }
    const username = await resolveBitbucketUsername(deps, session);
    if (username && username.length > 0) {
      return `https://${encodeURIComponent(username)}:${token}@${host}`;
    }
    return `https://x-token-auth:${token}@${host}`;
  }

  return url;
}
