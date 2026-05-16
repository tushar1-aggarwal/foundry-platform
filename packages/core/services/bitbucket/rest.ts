/**
 * Bitbucket Cloud REST API helpers for the deterministic action layer.
 *
 * Mirrors services/github/rest.ts. Bitbucket Cloud's PR-creation endpoint
 * (`POST /2.0/repositories/<workspace>/<repo>/pullrequests`) lets us create
 * a real pull-request object rather than the push-only "Create-PR" deeplink
 * that the legacy degraded path returns from `git push` stderr. The
 * deeplink left every Bitbucket session in a state where the branch was
 * pushed but no PR existed until a human clicked through the Bitbucket UI.
 *
 * Auth: HTTP Basic with `<email-or-username>:<token>`. ATATT* Atlassian
 * API tokens authenticate on the REST API in the Basic form even though
 * git-over-HTTPS for the same token requires the `x-bitbucket-api-token-auth`
 * username sentinel. Bearer-style auth returns 401 here -- verified live.
 */

const BITBUCKET_API = "https://api.bitbucket.org/2.0";

// ── URL parsing ─────────────────────────────────────────────────────────

export interface WorkspaceRepo {
  workspace: string;
  repo: string;
}

/**
 * Parse `workspace` + `repo` from a Bitbucket Cloud git remote or web URL.
 * Handles:
 *   - https://bitbucket.org/workspace/repo
 *   - https://bitbucket.org/workspace/repo.git
 *   - git@bitbucket.org:workspace/repo.git
 *   - https://x-bitbucket-api-token-auth:<token>@bitbucket.org/workspace/repo.git
 *     (the auth-embedded form Ark's clone URL builder produces)
 *
 * Returns null when the URL is not a Bitbucket Cloud URL.
 */
export function parseBitbucketWorkspaceRepoFromUrl(url: string | null | undefined): WorkspaceRepo | null {
  if (!url) return null;
  const trimmed = url.trim();

  const ssh = trimmed.match(/^git@bitbucket\.org:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { workspace: ssh[1], repo: ssh[2] };

  // https form, with optional userinfo@ prefix. Strip a leading credential
  // segment before the host so `.../@bitbucket.org/...` and bare
  // `bitbucket.org/...` both parse.
  const https = trimmed.match(/^(?:https?:\/\/)?(?:[^@/]+@)?bitbucket\.org\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (https) return { workspace: https[1], repo: https[2] };

  return null;
}

// ── createBitbucketPullRequest ──────────────────────────────────────────

export interface BitbucketDeps {
  /** Email or username for HTTP Basic. Required -- partial creds = ok:false. */
  username?: string;
  /** Atlassian API token (ATATT*) or app password. Required. */
  token?: string;
  /** Fetch implementation. Defaults to global fetch; tests inject a stub. */
  fetchFn?: typeof fetch;
}

export interface CreateBitbucketPullRequestArgs {
  workspace: string;
  repo: string;
  /** Source branch (the agent's session branch). */
  branch: string;
  /** Destination branch (typically "main"). */
  base: string;
  title: string;
  body?: string;
  /**
   * Bitbucket Cloud's PR API has no "draft" concept on REST -- the field
   * is accepted but ignored. Kept on the args type for caller symmetry
   * with the GitHub helper.
   */
  draft?: boolean;
}

export interface CreateBitbucketPullRequestResult {
  ok: boolean;
  pr_url?: string;
  pr_id?: number;
  /** Set when the PR already existed for this source branch. */
  existed?: boolean;
  message?: string;
}

/**
 * Create a Bitbucket Cloud pull request via REST. Returns the canonical
 * web URL on success.
 *
 * Duplicate-detection: Bitbucket returns HTTP 400 with an
 * "already an open pull request" error message when a PR for the same
 * source branch already exists. That case is treated as success
 * (existed=true) -- callers shouldn't need to differentiate "we created
 * it" from "it was already there" for the create-pr action's idempotency
 * contract.
 */
export async function createBitbucketPullRequest(
  args: CreateBitbucketPullRequestArgs,
  deps: BitbucketDeps,
): Promise<CreateBitbucketPullRequestResult> {
  if (!deps.token) {
    return { ok: false, message: "BITBUCKET_TOKEN not set; cannot create pull request via REST API" };
  }
  if (!deps.username) {
    return { ok: false, message: "BITBUCKET_USERNAME not set; Basic auth requires both halves" };
  }
  if (!args.workspace || !args.repo || !args.branch || !args.base || !args.title) {
    return {
      ok: false,
      message: "createBitbucketPullRequest requires workspace, repo, branch, base, and title.",
    };
  }

  const url = `${BITBUCKET_API}/repositories/${encodeURIComponent(args.workspace)}/${encodeURIComponent(args.repo)}/pullrequests`;
  const payload = {
    title: args.title,
    description: args.body ?? "",
    source: { branch: { name: args.branch } },
    destination: { branch: { name: args.base } },
  };
  const auth = "Basic " + Buffer.from(`${deps.username}:${deps.token}`).toString("base64");
  const fetchFn = deps.fetchFn ?? fetch;

  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response -- leave json null, fall through to status-based error */
  }

  if (res.status >= 200 && res.status < 300) {
    const prUrl = json?.links?.html?.href;
    return {
      ok: true,
      pr_url: typeof prUrl === "string" ? prUrl : undefined,
      pr_id: typeof json?.id === "number" ? json.id : undefined,
    };
  }

  // Duplicate-PR case (HTTP 400 with a specific message).
  const errMsg: string = json?.error?.message ?? "";
  if (res.status === 400 && /already.*pull request/i.test(errMsg)) {
    return {
      ok: true,
      existed: true,
      message: errMsg,
    };
  }

  return {
    ok: false,
    message: errMsg.length > 0 ? errMsg : `Bitbucket REST POST pullrequests returned HTTP ${res.status}`,
  };
}
