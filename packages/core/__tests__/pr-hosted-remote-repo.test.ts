/**
 * Hosted-mode sessions (started via remoteRepo, no local checkout) must
 * not fail the `create_pr` action with "Session has no repo".
 *
 * Regression: 2026-05-15. Session s-1b5q5xozpk on the pai-risk-mlops
 * cluster reached stage=pr and failed with `action 'create_pr' failed:
 * Session has no repo`. Root cause: createWorktreePR / rebaseOntoBase /
 * mergeWorktreePR read `session.repo` directly. For hosted sessions
 * dispatched with `--remote-repo`, that column is null -- the URL lives
 * at `session.config.remoteRepo`. Clone paths already do the
 * `config.remoteRepo ?? session.repo` dance; PR-creation/merge/rebase
 * did not, so every hosted-mode session hit the same wall once it
 * reached an action stage.
 *
 * These tests assert the failure mode is NOT the bogus "Session has no
 * repo" string. They do NOT assert a successful PR creation -- the test
 * env has no remote to push to. Once the fallback is wired, the
 * failure shifts to a downstream step (branch detection, push, gh) which
 * is the expected and acceptable shape for a real hosted session.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { createWorktreePR } from "../services/worktree/pr.js";
import { rebaseOntoBase } from "../services/worktree/git-ops.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

describe("hosted-mode sessions (remoteRepo only, repo column null)", () => {
  it("createWorktreePR does NOT fail with 'Session has no repo'", async () => {
    const session = await app.sessions.create({
      summary: "hosted-pr-test",
      // Deliberately NO `repo` -- this is the hosted-mode shape produced by
      // `session/start { remoteRepo: ... }` (the conductor's session handler
      // stuffs the URL into config.remoteRepo and leaves session.repo null).
      config: { remoteRepo: "https://example.invalid/owner/repo.git" },
    });

    const result = await createWorktreePR(app, session.id);

    expect(result.ok).toBe(false); // no remote -> push will fail; that's fine
    expect(result.message).not.toBe("Session has no repo");
  }, 30_000);

  it("rebaseOntoBase does NOT fail with 'Session has no repo'", async () => {
    const session = await app.sessions.create({
      summary: "hosted-rebase-test",
      config: { remoteRepo: "https://example.invalid/owner/repo.git" },
    });

    const result = await rebaseOntoBase(app, session.id);

    expect(result.ok).toBe(false); // fetch will fail against the bogus URL; fine
    expect(result.message).not.toBe("Session has no repo");
  }, 30_000);
});
