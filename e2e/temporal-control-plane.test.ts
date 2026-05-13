/**
 * Hosted-mode docs-flow e2e. Boots `ark server start --hosted` against the
 * Docker compose stack (Postgres + Redis + Temporal + temporal-worker) with
 * docker-isolation sidecar agents. Runs:
 *   1. Compound test: plan -> implement -> review_gate -> pr with stop/resume
 *   2. Restart-then-fail: server killed mid-implement, resumes the same
 *      Temporal workflow and surfaces AuthError as status=failed
 *
 * Mode-agnostic test bodies live in e2e/helpers/docs-flow-spec.ts.
 *
 * Run via: make test-e2e-control-plane
 */

import { describe, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFileSync } from "child_process";

import { spawnServer, killServer, type ServerHandle } from "./helpers/server-process.js";
import { up as stackUp, down as stackDown } from "./helpers/docker-stack.js";
import { startGitHttpServer, type GitHttpServerHandle } from "./helpers/git-http-server.js";
import { compoundDocsFlowSpec, restartThenFailSpec } from "./helpers/docs-flow-spec.js";
import { RpcClient } from "./helpers/rpc-client.js";
import { registerE2eFixtures } from "./helpers/register-fixtures.js";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENV_FILE = join(REPO_ROOT, ".env.e2e");
const EXPECTED_TOKEN = "test-fake-token-XYZ";

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

/** Translate the git server's loopback URL to a docker-reachable one for sidecars. */
function dockerReachable(url: string): string {
  return url.replace(/127\.0\.0\.1/, "host.docker.internal");
}

const TEMPORAL_EXTRA_ENV = {
  ARK_TEMPORAL_ORCHESTRATION: "true",
  ARK_TEMPORAL_SERVER_URL: "localhost:7234",
  ARK_TEMPORAL_NAMESPACE: "default",
  ARK_CONDUCTOR_HOSTNAME: "0.0.0.0",
  ARK_ENABLE_TEST_ACTIONS: "1",
};

describe("docs-flow e2e -- hosted (Temporal + docker isolation)", () => {
  // ── Test 1: Compound (happy path + manual gate + stop/resume) ──────────
  describe("compound", () => {
    let arkDir: string;
    let bareRepoParent: string;
    let bareRepoPath: string;
    let gitServer: GitHttpServerHandle;
    let server: ServerHandle;
    let rpc: RpcClient;

    beforeAll(async () => {
      arkDir = mkdtempSync(join(tmpdir(), "ark-hosted-compound-"));
      bareRepoParent = mkdtempSync(join(tmpdir(), "ark-hosted-compound-repo-"));
      bareRepoPath = initBareRepoWithSeed(bareRepoParent);

      await stackUp();

      // Bind to 0.0.0.0 so the docker sidecar can reach us via host.docker.internal.
      gitServer = await startGitHttpServer({
        repoPath: bareRepoPath,
        expectedToken: EXPECTED_TOKEN,
        logFile: join(arkDir, "git-auth-log.txt"),
        bindAddr: "0.0.0.0",
      });

      server = await spawnServer({
        arkDir,
        envFile: ENV_FILE,
        startupTimeoutMs: 60_000,
        extraEnv: TEMPORAL_EXTRA_ENV,
      });
      rpc = new RpcClient(server.webUrl);
      // Hosted server seeds builtins from flows/definitions/, which does not
      // include e2e fixtures. Register them via RPC so session/start can find
      // the flow and resolve its first stage. Pass failStage:null to clear any
      // leftover flag file from a prior restart-then-fail test run.
      await registerE2eFixtures(rpc, { failStage: null });
    }, 120_000);

    afterAll(async () => {
      try { await killServer(server); } catch {}
      try { await gitServer?.kill(); } catch {}
      try { await stackDown(); } catch {}
      if (arkDir && existsSync(arkDir)) rmSync(arkDir, { recursive: true, force: true });
      if (bareRepoParent && existsSync(bareRepoParent)) rmSync(bareRepoParent, { recursive: true, force: true });
    }, 60_000);

    test("plan -> implement -> review_gate -> pr completes after stop/resume + approve", async () => {
      await compoundDocsFlowSpec({
        rpc,
        repoUrl: dockerReachable(gitServer.url).replace("http://", `http://user:${EXPECTED_TOKEN}@`),
        bareRepoPath,
        arkDir,
        expectedToken: EXPECTED_TOKEN,
        isHosted: true,
      });
    }, 180_000);
  });

  // ── Test 2: Restart-then-fail (Temporal durability + AuthError) ─────────
  describe("restart-then-fail", () => {
    let arkDir: string;
    let bareRepoParent: string;
    let bareRepoPath: string;
    let gitServer: GitHttpServerHandle;
    let server: ServerHandle;
    let rpc: RpcClient;

    const FAIL_ENV = {
      ...TEMPORAL_EXTRA_ENV,
      ARK_FAKE_CLAUDE_FAIL_STAGE: "implement",
    };

    beforeAll(async () => {
      arkDir = mkdtempSync(join(tmpdir(), "ark-hosted-restartfail-"));
      bareRepoParent = mkdtempSync(join(tmpdir(), "ark-hosted-restartfail-repo-"));
      bareRepoPath = initBareRepoWithSeed(bareRepoParent);

      await stackUp();

      gitServer = await startGitHttpServer({
        repoPath: bareRepoPath,
        expectedToken: EXPECTED_TOKEN,
        logFile: join(arkDir, "git-auth-log.txt"),
        bindAddr: "0.0.0.0",
      });

      server = await spawnServer({
        arkDir,
        envFile: ENV_FILE,
        startupTimeoutMs: 60_000,
        extraEnv: FAIL_ENV,
      });
      rpc = new RpcClient(server.webUrl);
      // Inject failStage so the worker's fake-claude-code plugin emits an
      // AuthError on the implement stage. Without this, the executor sees no
      // flag and completes successfully -- the very bug that made this test
      // miss the durability assertion last run.
      await registerE2eFixtures(rpc, { failStage: "implement" });
    }, 120_000);

    afterAll(async () => {
      try { await killServer(server); } catch {}
      try { await gitServer?.kill(); } catch {}
      try { await stackDown(); } catch {}
      if (arkDir && existsSync(arkDir)) rmSync(arkDir, { recursive: true, force: true });
      if (bareRepoParent && existsSync(bareRepoParent)) rmSync(bareRepoParent, { recursive: true, force: true });
    }, 60_000);

    test("session resumes after server restart and surfaces AuthError as status=failed", async () => {
      await restartThenFailSpec({
        rpc,
        repoUrl: dockerReachable(gitServer.url).replace("http://", `http://user:${EXPECTED_TOKEN}@`),
        bareRepoPath,
        arkDir,
        expectedToken: EXPECTED_TOKEN,
        isHosted: true,
        killServer: async () => {
          server.proc.kill("SIGKILL");
          await new Promise((r) => setTimeout(r, 500));
        },
        restartServer: async () => {
          server = await spawnServer({
            arkDir,
            envFile: ENV_FILE,
            startupTimeoutMs: 60_000,
            extraEnv: FAIL_ENV,
          });
          rpc = new RpcClient(server.webUrl);
        },
      });
    }, 240_000);
  });
});
