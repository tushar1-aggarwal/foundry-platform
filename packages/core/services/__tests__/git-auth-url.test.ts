/**
 * Unit tests for buildAuthedHttpsUrl. Covers the three rewrite cases:
 *   - github.com -> x-access-token:<TOKEN>
 *   - bitbucket.org with username -> <urlencoded-email>:<TOKEN> (Atlassian API token)
 *   - bitbucket.org without username -> x-token-auth:<TOKEN> (legacy / workspace HTTP access token)
 * Plus pass-through cases (http, unknown host, no token).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";
import { buildAuthedHttpsUrl } from "../git/auth-url.js";
import type { Session } from "../../../types/index.js";

let app: AppContext;
const SAVED_ENV: Record<string, string | undefined> = {};
const TOKEN_ENV_VARS = ["GITHUB_TOKEN", "BITBUCKET_TOKEN", "BITBUCKET_USERNAME"];

beforeEach(async () => {
  // Isolate from the shell's env -- the helper falls back to process.env for
  // legacy-daemon support, and these vars are routinely set in dev shells.
  for (const k of TOKEN_ENV_VARS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});
afterEach(async () => {
  await app?.shutdown();
  clearApp();
  for (const k of TOKEN_ENV_VARS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

const TENANT = "t-test";
const stubSession = (): Session => ({ tenant_id: TENANT, id: "s-1" }) as unknown as Session;

describe("buildAuthedHttpsUrl", () => {
  it("rewrites github.com URLs with x-access-token when GITHUB_TOKEN is set", async () => {
    await app.secrets.set(TENANT, "GITHUB_TOKEN", "ghp_abc123", { type: "env-var" });
    const result = await buildAuthedHttpsUrl(app, stubSession(), "https://github.com/owner/repo.git");
    expect(result).toBe("https://x-access-token:ghp_abc123@github.com/owner/repo.git");
  });

  it("rewrites bitbucket.org URLs with x-bitbucket-api-token-auth for ATATT* tokens (regardless of BITBUCKET_USERNAME)", async () => {
    // Atlassian API tokens only authenticate against git-over-HTTPS with the
    // x-bitbucket-api-token-auth sentinel; the email form (which works for
    // the REST API) returns HTTP 401 on git. BITBUCKET_USERNAME is ignored
    // for this token flavour.
    await app.secrets.set(TENANT, "BITBUCKET_TOKEN", "ATATT_xyz", { type: "env-var" });
    await app.secrets.set(TENANT, "BITBUCKET_USERNAME", "user@example.com", { type: "env-var" });
    const result = await buildAuthedHttpsUrl(app, stubSession(), "https://bitbucket.org/team/repo.git");
    expect(result).toBe("https://x-bitbucket-api-token-auth:ATATT_xyz@bitbucket.org/team/repo.git");
  });

  it("rewrites bitbucket.org URLs with <username>:<token> for legacy app passwords (non-ATATT) when BITBUCKET_USERNAME is set", async () => {
    await app.secrets.set(TENANT, "BITBUCKET_TOKEN", "legacy_app_pwd_value", { type: "env-var" });
    await app.secrets.set(TENANT, "BITBUCKET_USERNAME", "bb-user", { type: "env-var" });
    const result = await buildAuthedHttpsUrl(app, stubSession(), "https://bitbucket.org/team/repo.git");
    expect(result).toBe("https://bb-user:legacy_app_pwd_value@bitbucket.org/team/repo.git");
  });

  it("falls back to x-token-auth on bitbucket.org for non-ATATT token when no username is configured (workspace HTTP access token)", async () => {
    await app.secrets.set(TENANT, "BITBUCKET_TOKEN", "workspace_http_token", { type: "env-var" });
    const result = await buildAuthedHttpsUrl(app, stubSession(), "https://bitbucket.org/team/repo.git");
    expect(result).toBe("https://x-token-auth:workspace_http_token@bitbucket.org/team/repo.git");
  });

  it("passes through when no token is configured", async () => {
    const url = "https://bitbucket.org/team/repo.git";
    expect(await buildAuthedHttpsUrl(app, stubSession(), url)).toBe(url);
  });

  it("passes through non-https URLs (ssh, git, http)", async () => {
    await app.secrets.set(TENANT, "GITHUB_TOKEN", "ghp_abc123", { type: "env-var" });
    expect(await buildAuthedHttpsUrl(app, stubSession(), "git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(await buildAuthedHttpsUrl(app, stubSession(), "ssh://git@bitbucket.org/team/repo.git")).toBe(
      "ssh://git@bitbucket.org/team/repo.git",
    );
    expect(await buildAuthedHttpsUrl(app, stubSession(), "http://github.com/owner/repo.git")).toBe(
      "http://github.com/owner/repo.git",
    );
  });

  it("passes through unknown hosts even with tokens configured", async () => {
    await app.secrets.set(TENANT, "GITHUB_TOKEN", "ghp_abc123", { type: "env-var" });
    const url = "https://gitlab.com/group/repo.git";
    expect(await buildAuthedHttpsUrl(app, stubSession(), url)).toBe(url);
  });
});
