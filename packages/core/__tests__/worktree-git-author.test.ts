/**
 * Per-worktree git author identity.
 *
 * Resolution chain (highest priority first):
 *   1. Explicit override -- `ARK_GIT_AUTHOR_NAME` / `_EMAIL` env or
 *      `app.config.git.author{Name,Email}` set to a non-placeholder value.
 *   2. The parent repo's effective git config (worktree -> repo-local ->
 *      `~/.gitconfig` -> system). This is what lets a laptop dev's local
 *      identity flow through automatically without operator action.
 *   3. The user's global git config (probed independently as a backstop
 *      when the parent repo's local config carries the placeholder from
 *      a prior `applyWorktreeGitIdentity` write).
 *   4. The placeholder `"Ark Agent" / "agent@ark.local"` -- last resort.
 *
 * The placeholder strings are treated as "no override" everywhere in the
 * chain because Bitbucket's BB Violator pre-receive hook rejects the
 * `agent@ark.local` email and rewrites the commit to a generic bot author
 * (see real incident PAI-31995). Production environments where the host
 * `~/.gitconfig` might also carry an invalid identity should set the
 * explicit env override.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync } from "fs";
import { join } from "path";

import { AppContext } from "../app.js";
import { setupSessionWorktree } from "../services/worktree/index.js";
import { depsFromApp } from "../services/deps.js";

let app: AppContext;
let originalCwd: string;
let repoDir: string;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();

  repoDir = join(app.config.dirs.ark, "fake-live-repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", repoDir], { stdio: "pipe" });
  // Set a host-level identity that we explicitly do NOT want the agent
  // to inherit on its commits.
  execFileSync("git", ["-C", repoDir, "config", "user.email", "host-config@example.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Host User"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });

  originalCwd = process.cwd();
  process.chdir(repoDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await app?.shutdown();
});

function readWorktreeIdentity(wt: string): { name: string; email: string } {
  const name = execFileSync("git", ["-C", wt, "config", "user.name"], { encoding: "utf-8" }).trim();
  const email = execFileSync("git", ["-C", wt, "config", "user.email"], { encoding: "utf-8" }).trim();
  return { name, email };
}

describe("setupSessionWorktree -- git author identity", () => {
  it("inherits the parent repo's git identity when no override is configured", async () => {
    // Default config carries the placeholder "Ark Agent" / "agent@ark.local"
    // (see config.ts:498-507), which the resolver treats as "no override".
    // The parent repo has user.name="Host User" / user.email="host-config@example.com"
    // (set in beforeEach), so those should propagate into the worktree.
    const session = await app.sessions.create({ summary: "git-author cascade", repo: "." });
    const wt = await setupSessionWorktree(depsFromApp(app), session, null);

    expect(readWorktreeIdentity(wt)).toEqual({
      name: "Host User",
      email: "host-config@example.com",
    });
  });

  it("honors app.config.git override over the parent repo's identity", async () => {
    // Mutate the resolved config directly -- this mirrors what env-source /
    // YAML overlay produces in real deployments. Explicit non-placeholder
    // overrides MUST win over the parent repo's identity even when the latter
    // is set and valid.
    (app.config as Record<string, unknown>).git = {
      authorName: "Custom Bot",
      authorEmail: "bot@example.org",
    };

    const session = await app.sessions.create({ summary: "git-author override", repo: "." });
    const wt = await setupSessionWorktree(depsFromApp(app), session, null);

    expect(readWorktreeIdentity(wt)).toEqual({ name: "Custom Bot", email: "bot@example.org" });
  });

  it("treats the literal placeholder in config.git as 'no override'", async () => {
    // Production deployments where the operator left ARK_GIT_AUTHOR_NAME
    // unset (or explicitly set to "Ark Agent") still get the parent repo's
    // identity. The placeholder is the BB-Violator-incompatible value we
    // want to avoid in practice.
    (app.config as Record<string, unknown>).git = {
      authorName: "Ark Agent",
      authorEmail: "agent@ark.local",
    };

    const session = await app.sessions.create({ summary: "git-author placeholder", repo: "." });
    const wt = await setupSessionWorktree(depsFromApp(app), session, null);

    expect(readWorktreeIdentity(wt)).toEqual({
      name: "Host User",
      email: "host-config@example.com",
    });
  });
});
