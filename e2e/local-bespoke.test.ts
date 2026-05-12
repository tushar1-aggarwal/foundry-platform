/**
 * Local-mode docs-flow e2e. Boots `ark server start` (default profile, no
 * --hosted, SQLite, single tenant) and runs:
 *   1. Compound test: plan -> implement -> review_gate -> pr (happy path + gate + stop/resume)
 *   2. Restart-then-fail: server killed mid-implement, restarted with FAIL env, session ends failed
 *
 * Mode-agnostic test bodies live in e2e/helpers/docs-flow-spec.ts.
 */

import { describe, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, chmodSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import { execFileSync } from "child_process";

import { startLocalServer, killServer } from "./helpers/server-process.js";
import { startGitHttpServer, type GitHttpServerHandle } from "./helpers/git-http-server.js";
import { compoundDocsFlowSpec, restartThenFailSpec } from "./helpers/docs-flow-spec.js";
import { RpcClient } from "./helpers/rpc-client.js";

const REPO_ROOT = resolvePath(import.meta.dir, "..");
const FAKE_CLAUDE_SRC = join(REPO_ROOT, "e2e/fixtures/fake-claude.sh");
const EXPECTED_TOKEN = "test-fake-token-XYZ";
const WEB_PORT = 8420;

function initBareRepoWithSeed(parent: string): string {
  const bare = join(parent, "fake-bitbucket.git");
  mkdirSync(parent, { recursive: true });
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  const working = join(parent, "working");
  execFileSync("git", ["clone", bare, working]);
  execFileSync("bash", ["-c", "echo initial > README.md"], { cwd: working });
  execFileSync("git", ["-C", working, "-c", "user.email=test@x", "-c", "user.name=test", "add", "README.md"]);
  execFileSync("git", ["-C", working, "-c", "user.email=test@x", "-c", "user.name=test", "commit", "-m", "initial"]);
  execFileSync("git", ["-C", working, "push", "origin", "main"]);
  rmSync(working, { recursive: true, force: true });
  return bare;
}

function installFakeClaude(arkDir: string): string {
  const binDir = join(arkDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const dst = join(binDir, "claude");
  copyFileSync(FAKE_CLAUDE_SRC, dst);
  chmodSync(dst, 0o755);
  return binDir;
}

describe("docs-flow e2e -- local bespoke", () => {
  // ── Test 1: Compound (happy path + manual gate + stop/resume) ─────────
  describe("compound", () => {
    let arkDir: string;
    let bareRepoParent: string;
    let bareRepoPath: string;
    let gitServer: GitHttpServerHandle;
    let server: Awaited<ReturnType<typeof startLocalServer>>;
    let rpc: RpcClient;

    beforeAll(async () => {
      arkDir = mkdtempSync(join(tmpdir(), "ark-local-compound-"));
      bareRepoParent = mkdtempSync(join(tmpdir(), "ark-local-compound-repo-"));
      bareRepoPath = initBareRepoWithSeed(bareRepoParent);
      const pathPrefix = installFakeClaude(arkDir);

      gitServer = await startGitHttpServer({
        repoPath: bareRepoPath,
        expectedToken: EXPECTED_TOKEN,
        logFile: join(arkDir, "git-auth-log.txt"),
        bindAddr: "127.0.0.1",
      });

      server = await startLocalServer({ arkDir, pathPrefix, webPort: WEB_PORT });
      rpc = new RpcClient(server.webUrl);
    });

    afterAll(async () => {
      try { await killServer(server); } catch {}
      try { await gitServer?.kill(); } catch {}
      if (arkDir && existsSync(arkDir)) rmSync(arkDir, { recursive: true, force: true });
      if (bareRepoParent && existsSync(bareRepoParent)) rmSync(bareRepoParent, { recursive: true, force: true });
    });

    test("plan -> implement -> review_gate -> pr completes after stop/resume + approve", async () => {
      await compoundDocsFlowSpec({
        rpc,
        repoUrl: gitServer.url,
        bareRepoPath,
        arkDir,
        expectedToken: EXPECTED_TOKEN,
        isHosted: false,
      });
    }, 120_000);
  });

  // ── Test 2: Restart-then-fail (durable persistence + AuthError) ────────
  describe("restart-then-fail", () => {
    let arkDir: string;
    let bareRepoParent: string;
    let bareRepoPath: string;
    let gitServer: GitHttpServerHandle;
    let server: Awaited<ReturnType<typeof startLocalServer>>;
    let rpc: RpcClient;
    let pathPrefix: string;

    const FAIL_ENV = { ARK_FAKE_CLAUDE_FAIL_STAGE: "implement" };

    beforeAll(async () => {
      arkDir = mkdtempSync(join(tmpdir(), "ark-local-restartfail-"));
      bareRepoParent = mkdtempSync(join(tmpdir(), "ark-local-restartfail-repo-"));
      bareRepoPath = initBareRepoWithSeed(bareRepoParent);
      pathPrefix = installFakeClaude(arkDir);

      gitServer = await startGitHttpServer({
        repoPath: bareRepoPath,
        expectedToken: EXPECTED_TOKEN,
        logFile: join(arkDir, "git-auth-log.txt"),
        bindAddr: "127.0.0.1",
      });

      server = await startLocalServer({ arkDir, pathPrefix, webPort: WEB_PORT + 1, extraEnv: FAIL_ENV });
      rpc = new RpcClient(server.webUrl);
    });

    afterAll(async () => {
      try { await killServer(server); } catch {}
      try { await gitServer?.kill(); } catch {}
      if (arkDir && existsSync(arkDir)) rmSync(arkDir, { recursive: true, force: true });
      if (bareRepoParent && existsSync(bareRepoParent)) rmSync(bareRepoParent, { recursive: true, force: true });
    });

    test("session resumes after restart and surfaces AuthError as status=failed", async () => {
      await restartThenFailSpec({
        rpc,
        repoUrl: gitServer.url,
        bareRepoPath,
        arkDir,
        expectedToken: EXPECTED_TOKEN,
        isHosted: false,
        killServer: async () => {
          server.proc.kill("SIGKILL");
          await new Promise((r) => setTimeout(r, 500));
        },
        restartServer: async () => {
          server = await startLocalServer({ arkDir, pathPrefix, webPort: WEB_PORT + 1, extraEnv: FAIL_ENV });
          rpc = new RpcClient(server.webUrl);
        },
      });
    }, 180_000);
  });
});
