/**
 * setupSessionWorktree must short-circuit for sessions destined for a
 * remote compute (supportsWorktree=false).
 *
 * Failure shape on the cluster (s-hi1cr8wz4g, 2026-05-15): a session
 * started with `remoteRepo` + `repo: "foundry-test-repo"` (a bare name)
 * had its `session.workdir` written to `/app` by the conductor-side
 * setupSessionWorktree, which then pre-empted K8sCompute's prepareWorkspace
 * lifecycle step. Downstream the agent ran in /app (no git), and the pr
 * stage failed with "Cannot determine worktree branch".
 *
 * Architectural rule: for any compute whose capabilities.supportsWorktree
 * is false, the conductor must do NOTHING repo-related; the compute's
 * prepareWorkspace owns the workspace lifecycle.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AppContext } from "../app.js";
import { setupSessionWorktree } from "../services/worktree/setup.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

let app: AppContext;
let testDir: string;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  testDir = join(tmpdir(), `ark-short-circuit-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterAll(async () => {
  await app?.shutdown();
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe("setupSessionWorktree short-circuit for remote compute", () => {
  it("returns the compute's resolveWorkdir result so the executor can thread it into prepareWorkspace", async () => {
    // Regression guard for s-w6212tpa72 (2026-05-15): the short-circuit
    // initially returned null, which made the executor's workerWorkdir
    // null, which made target-lifecycle skip prepareWorkspace (its guard
    // requires non-null remoteWorkdir). Result: no clone, agent crashed.
    // Fix: short-circuit calls compute.resolveWorkdir with a synthetic
    // handle so the caller gets a usable path without us persisting it.
    await app.computes.insert({
      name: "k8s-resolve-test",
      compute_kind: "k8s",
      isolation_kind: "direct",
      status: "running",
      config: { image: "test:latest", namespace: "ark", resources: { cpu: "100m", memory: "128Mi" } },
    });
    const session = await app.sessions.create({
      summary: "resolve-test",
      repo: "foundry-test-repo",
      config: { remoteRepo: "https://bitbucket.org/paytmteam/foundry-test-repo.git" },
    });
    const compute = await app.computes.get("k8s-resolve-test");
    const result = await setupSessionWorktree(app, session, compute);
    expect(result).toBe(`/workspace/${session.id}/foundry-test-repo`);

    // And critically: still NOT persisted to the row -- the compute side
    // owns the write (in prepareWorkspace), not the conductor.
    const after = await app.sessions.get(session.id);
    expect(after?.workdir).toBeFalsy();
  }, 30_000);

  it("does NOT persist session.workdir when the resolved compute has supportsWorktree=false", async () => {
    // Create a k8s compute row -- K8sCompute.capabilities.supportsWorktree === false.
    await app.computes.insert({
      name: "k8s-test",
      compute_kind: "k8s",
      isolation_kind: "direct",
      status: "running",
      config: { image: "test:latest", namespace: "ark", resources: { cpu: "100m", memory: "128Mi" } },
    });

    // Session shape that triggered the bug: bare-name repo + remoteRepo URL.
    const session = await app.sessions.create({
      summary: "k8s-short-circuit-test",
      repo: "foundry-test-repo", // bare name, not a real local path
      config: { remoteRepo: "https://bitbucket.org/paytmteam/foundry-test-repo.git" },
    });

    const compute = await app.computes.get("k8s-test");
    expect(compute).toBeTruthy();

    await setupSessionWorktree(app, session, compute);

    const after = await app.sessions.get(session.id);
    // The session row's workdir must NOT have been mutated to a conductor-side
    // bogus path. Either still null (preferred) or unchanged from input.
    expect(after?.workdir).toBeFalsy();
  }, 30_000);

  it("still creates a real git worktree + persists workdir for LocalCompute (regression guard)", async () => {
    // Real git repo: init, commit one file -- LocalCompute's supportsWorktree=true
    // path requires existsSync(<repo>/.git) to be true to take the worktree branch.
    const repoDir = join(testDir, "local-repo");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.email", "test@example.com");
    git(repoDir, "config", "user.name", "test");
    writeFileSync(join(repoDir, "README.md"), "hi");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "seed");

    const session = await app.sessions.create({
      summary: "local-regression-guard",
      repo: repoDir,
    });

    await setupSessionWorktree(app, session);

    const after = await app.sessions.get(session.id);
    const expectedWtDir = join(app.config.dirs.worktrees, session.id);
    // The function must (a) persist an absolute workdir and (b) actually
    // create the git worktree at ~/.ark/worktrees/<sessionId>.
    expect(after?.workdir).toBe(expectedWtDir);
    expect(existsSync(expectedWtDir)).toBe(true);
    expect(existsSync(join(expectedWtDir, ".git"))).toBe(true);

    // Cleanup the worktree so the next test in the same fixture starts clean.
    try {
      execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", expectedWtDir], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      /* ignore */
    }
  }, 30_000);
});
