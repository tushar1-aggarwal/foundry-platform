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
import type { AppContext } from "../../app.js";
import type { Session } from "../../../types/index.js";

/** Resolve a tenant-scoped secret with a `process.env` fallback for legacy daemons. */
async function resolveSecret(app: AppContext, session: Session, name: string): Promise<string | undefined> {
  try {
    const fromStore = await app.secrets.get(session.tenant_id, name);
    if (fromStore) return fromStore;
  } catch {
    // Secret store unavailable -- fall through to env fallback.
  }
  return process.env[name] || undefined;
}

export async function resolveGithubToken(app: AppContext, session: Session): Promise<string | undefined> {
  return resolveSecret(app, session, "GITHUB_TOKEN");
}

export async function resolveBitbucketToken(app: AppContext, session: Session): Promise<string | undefined> {
  return resolveSecret(app, session, "BITBUCKET_TOKEN");
}

export async function resolveBitbucketUsername(app: AppContext, session: Session): Promise<string | undefined> {
  return resolveSecret(app, session, "BITBUCKET_USERNAME");
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
export async function buildAuthedHttpsUrl(app: AppContext, session: Session, url: string): Promise<string> {
  if (!url.startsWith("https://")) return url;

  if (url.startsWith("https://github.com/")) {
    const token = await resolveGithubToken(app, session);
    if (!token) return url;
    return `https://x-access-token:${token}@${url.slice("https://".length)}`;
  }

  if (url.startsWith("https://bitbucket.org/")) {
    const token = await resolveBitbucketToken(app, session);
    if (!token) return url;
    const username = await resolveBitbucketUsername(app, session);
    if (username && username.length > 0) {
      // Atlassian API tokens require `<email>:<token>` basic auth. URL-encode
      // the username so emails (`user@host`) don't break the URL parser.
      return `https://${encodeURIComponent(username)}:${token}@${url.slice("https://".length)}`;
    }
    return `https://x-token-auth:${token}@${url.slice("https://".length)}`;
  }

  return url;
}
