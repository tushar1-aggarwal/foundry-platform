/**
 * Bitbucket REST helpers -- pull-request creation.
 *
 * Bitbucket Cloud REST 2.0 auth for ATATT* Atlassian tokens is HTTP Basic
 * with `<email-or-username>:<token>`. (Same token works on git-over-HTTPS
 * via the `x-bitbucket-api-token-auth:<token>` sentinel, but REST wants
 * the Basic form -- verified live in slice test, see commit message.)
 *
 * Mirrors services/github/rest.ts's `createPullRequest`. Returns the same
 * `{ok, pr_url, existed?, message?}` shape so callers can branch on host
 * without diverging.
 */
import { describe, expect, test } from "bun:test";
import { createBitbucketPullRequest, parseBitbucketWorkspaceRepoFromUrl } from "../rest.js";

// ── URL parsing ─────────────────────────────────────────────────────────

describe("parseBitbucketWorkspaceRepoFromUrl", () => {
  test("https with .git", () => {
    expect(parseBitbucketWorkspaceRepoFromUrl("https://bitbucket.org/paytmteam/foundry-test-repo.git")).toEqual({
      workspace: "paytmteam",
      repo: "foundry-test-repo",
    });
  });

  test("https without .git", () => {
    expect(parseBitbucketWorkspaceRepoFromUrl("https://bitbucket.org/paytmteam/foundry-test-repo")).toEqual({
      workspace: "paytmteam",
      repo: "foundry-test-repo",
    });
  });

  test("ssh form", () => {
    expect(parseBitbucketWorkspaceRepoFromUrl("git@bitbucket.org:paytmteam/foundry-test-repo.git")).toEqual({
      workspace: "paytmteam",
      repo: "foundry-test-repo",
    });
  });

  test("auth-embedded https (the form Ark's clone URL builder produces)", () => {
    expect(
      parseBitbucketWorkspaceRepoFromUrl(
        "https://x-bitbucket-api-token-auth:ATATT3xFf...@bitbucket.org/paytmteam/foundry-test-repo.git",
      ),
    ).toEqual({ workspace: "paytmteam", repo: "foundry-test-repo" });
  });

  test("non-bitbucket URL returns null", () => {
    expect(parseBitbucketWorkspaceRepoFromUrl("https://github.com/x/y.git")).toBeNull();
  });

  test("empty input returns null", () => {
    expect(parseBitbucketWorkspaceRepoFromUrl(null)).toBeNull();
    expect(parseBitbucketWorkspaceRepoFromUrl("")).toBeNull();
  });
});

// ── createBitbucketPullRequest ──────────────────────────────────────────

describe("createBitbucketPullRequest", () => {
  function stubFetch(responder: (url: string, init?: RequestInit) => { status: number; body: unknown }): typeof fetch {
    return (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const r = responder(url, init);
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  test("happy path: POSTs the canonical pullrequests payload with Basic auth and returns pr_url", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchFn = stubFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        status: 201,
        body: {
          id: 4147,
          state: "OPEN",
          links: { html: { href: "https://bitbucket.org/paytmteam/foundry-test-repo/pull-requests/4147" } },
        },
      };
    });

    const result = await createBitbucketPullRequest(
      {
        workspace: "paytmteam",
        repo: "foundry-test-repo",
        branch: "ark-s-et2kxohk4j",
        base: "main",
        title: "add a smoke test for caculator cli",
        body: "Implements smoke tests for calc CLI",
      },
      { username: "zineng.yuan@paytm.com", token: "ATATT-redacted", fetchFn },
    );

    expect(result.ok).toBe(true);
    expect(result.pr_url).toBe("https://bitbucket.org/paytmteam/foundry-test-repo/pull-requests/4147");
    expect(result.pr_id).toBe(4147);
    expect(capturedUrl).toBe("https://api.bitbucket.org/2.0/repositories/paytmteam/foundry-test-repo/pullrequests");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    const expectedAuth = "Basic " + Buffer.from("zineng.yuan@paytm.com:ATATT-redacted").toString("base64");
    expect(headers["Authorization"]).toBe(expectedAuth);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({
      title: "add a smoke test for caculator cli",
      description: "Implements smoke tests for calc CLI",
      source: { branch: { name: "ark-s-et2kxohk4j" } },
      destination: { branch: { name: "main" } },
    });
  });

  test("missing token returns ok:false with operator-facing message (no fetch call)", async () => {
    let called = false;
    const fetchFn = stubFetch(() => {
      called = true;
      return { status: 200, body: {} };
    });
    const result = await createBitbucketPullRequest(
      { workspace: "w", repo: "r", branch: "b", base: "main", title: "t" },
      { username: "u", token: undefined, fetchFn },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/BITBUCKET_TOKEN.*not set/i);
    expect(called).toBe(false);
  });

  test("missing username returns ok:false (Basic auth requires both halves)", async () => {
    const result = await createBitbucketPullRequest(
      { workspace: "w", repo: "r", branch: "b", base: "main", title: "t" },
      { username: undefined, token: "ATATT", fetchFn: stubFetch(() => ({ status: 200, body: {} })) },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/BITBUCKET_USERNAME.*not set/i);
  });

  test("missing required args -> ok:false", async () => {
    const result = await createBitbucketPullRequest(
      { workspace: "", repo: "r", branch: "b", base: "main", title: "t" } as any,
      { username: "u", token: "t" },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/requires workspace.*repo.*branch.*base.*title/i);
  });

  test("existing-PR (Bitbucket returns 'pull request already exists' 400) -> ok:true with existed=true", async () => {
    // Bitbucket's exact response for a duplicate open PR is HTTP 400 with
    // {"type":"error","error":{"message":"There is already an open pull request..."}}.
    const fetchFn = stubFetch(() => ({
      status: 400,
      body: { type: "error", error: { message: "There is already an open pull request for this branch" } },
    }));
    const result = await createBitbucketPullRequest(
      { workspace: "w", repo: "r", branch: "b", base: "main", title: "t" },
      { username: "u", token: "ATATT", fetchFn },
    );
    expect(result.ok).toBe(true);
    expect(result.existed).toBe(true);
  });

  test("auth failure -> ok:false with descriptive message", async () => {
    const fetchFn = stubFetch(() => ({
      status: 401,
      body: { type: "error", error: { message: "Token is invalid, expired, or not supported for this endpoint." } },
    }));
    const result = await createBitbucketPullRequest(
      { workspace: "w", repo: "r", branch: "b", base: "main", title: "t" },
      { username: "u", token: "ATATT", fetchFn },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Token is invalid/);
  });
});
