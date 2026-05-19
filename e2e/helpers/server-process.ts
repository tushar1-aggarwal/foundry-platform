/**
 * Server boot helpers for e2e tests.
 *
 * spawnServer / killServer -- subprocess-based boot for hosted/Temporal tests
 *   (e2e/temporal-control-plane.test.ts). Spawns the real `ark server start
 *   --hosted` binary and waits for /api/health.
 *
 * startLocalServer -- in-process boot for local-mode tests
 *   (e2e/local-bespoke.test.ts). Builds an AppContext directly with SQLite +
 *   local profile, calls startWebServer(), and registers test fixtures into the
 *   file-backed stores. No subprocess, no --hosted flag, no Postgres.
 */

import type { Subprocess } from "bun";
import { readFileSync, mkdirSync, appendFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { execFileSync } from "child_process";
import YAML from "yaml";
import { AppContext } from "../../packages/core/app.js";
import { loadAppConfig } from "../../packages/core/config.js";
import { startWebServer } from "../../packages/core/hosted/web.js";
import type { Executor, LaunchOpts, LaunchResult, ExecutorStatus } from "../../packages/core/executor.js";
import { handleReport } from "../../packages/core/services/channel/report-pipeline.js";
import { getStageAction } from "../../packages/core/services/flow.js";
import { depsFromApp } from "../../packages/core/services/deps.js";

/**
 * Best-effort kill of any process holding the given TCP ports. Used to
 * recover from a prior test run that crashed before tearing down the
 * server -- the volumes get wiped via `down -v` but the bun process can
 * outlive that and keep the port bound. Silent on failure: if the port
 * is already free or `lsof` is missing the next bind attempt will surface
 * the real error.
 */
async function clearStalePorts(ports: number[]): Promise<void> {
  const selfPid = process.pid;
  for (const port of ports) {
    const lsof = Bun.spawn(["lsof", "-ti", `:${port}`], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(lsof.stdout).text();
    await lsof.exited;
    const pids = out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const pid of pids) {
      const n = Number(pid);
      // CRITICAL: never SIGKILL ourselves. When startLocalServer runs
      // in-process (Bun.serve on this same process), the port we just
      // released still maps back to this PID via lsof. Killing it would
      // SIGKILL the test runner, which is exactly what was happening
      // in restart-then-fail's restartServer callback.
      if (n === selfPid) continue;
      try {
        process.kill(n, "SIGKILL");
      } catch {
        // process already gone
      }
    }
  }
  if (ports.length) await Bun.sleep(200);
}

export interface ServerHandle {
  proc: Subprocess;
  webUrl: string;
}

export interface SpawnOptions {
  /** Absolute path to a temp arkDir. Required so blobs/snapshots don't
   *  pollute the operator's ~/.ark. */
  arkDir: string;
  /** Path to .env.e2e. Read and parsed in this process; we set the keys
   *  on the child env explicitly so we have one source of truth. */
  envFile: string;
  /** ms to wait for /api/health before giving up. */
  startupTimeoutMs?: number;
  /** Extra env vars merged on top of process.env + envFile. Useful for
   *  Temporal-specific overrides (ARK_TEMPORAL_ORCHESTRATION, etc.) that
   *  differ between test suites without editing .env.e2e. */
  extraEnv?: Record<string, string>;
}

function parseEnvFile(path: string): Record<string, string> {
  const raw = readFileSync(path, "utf-8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export async function spawnServer(opts: SpawnOptions): Promise<ServerHandle> {
  const fileEnv = parseEnvFile(opts.envFile);
  const env: Record<string, string> = {
    ...process.env,
    ...fileEnv,
    ARK_DIR: opts.arkDir,
    ...(opts.extraEnv ?? {}),
  } as Record<string, string>;
  const repoRoot = resolve(import.meta.dir, "../..");

  // Free any ports left bound by a prior test run that crashed before
  // tearing down the server. Without this, EADDRINUSE on bind() kills
  // boot before /api/health is reachable.
  const portsToClear = [
    fileEnv.ARK_WEB_PORT,
    fileEnv.ARK_CONDUCTOR_PORT,
    fileEnv.ARK_ARKD_PORT,
    fileEnv.ARK_SERVER_PORT,
  ]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .map((p) => Number(p))
    .filter((n) => Number.isFinite(n));
  await clearStalePorts(portsToClear);

  const proc = Bun.spawn(["bun", "packages/cli/index.ts", "server", "start", "--hosted"], {
    cwd: repoRoot,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });

  const webPort = fileEnv.ARK_WEB_PORT ?? "8422";
  const webUrl = `http://localhost:${webPort}`;

  const deadline = Date.now() + (opts.startupTimeoutMs ?? 30_000);
  // Stage 1: wait for the lightweight /api/health probe -- proves the
  // web server is listening but says nothing about DB readiness.
  let healthy = false;
  while (!healthy && Date.now() < deadline) {
    try {
      const r = await fetch(`${webUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        healthy = true;
        break;
      }
    } catch {
      // server not up yet
    }
    await Bun.sleep(250);
  }
  if (!healthy) {
    proc.kill();
    throw new Error(`ark server health check failed at ${webUrl}/api/health within budget`);
  }
  // Stage 2: wait for a real RPC to succeed against the DB. /api/health
  // returns 200 the moment Bun.serve binds the port, but `app.boot()` (which
  // runs migrations) is still racing in the background. Hammering /api/rpc
  // before migrations finish surfaces as Drizzle "table not found" errors.
  // session/list is read-only and cheap; success here means the schema is in
  // place and the dispatcher chain is wired.
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${webUrl}/api/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "boot-probe", method: "session/list", params: { limit: 1 } }),
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) {
        const body = (await r.json()) as { error?: unknown };
        if (!body.error) return { proc, webUrl };
      }
    } catch {
      // migrations still running, retry
    }
    await Bun.sleep(500);
  }
  proc.kill();
  throw new Error(`ark server DB-ready probe failed at ${webUrl}/api/rpc session/list within budget`);
}

// ──────────────────────────────────────────────────────────────────────────
// LOCAL MODE BOOT
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build an in-process "fake claude" executor that replaces the real
 * `claude-code` executor for local e2e tests. Implements the same behaviour
 * as e2e/fixtures/fake-claude.sh but entirely in-process:
 *
 *   - Writes an audit log to <arkDir>/agent-envs/<stage>.log
 *   - If ARK_FAKE_CLAUDE_FAIL_STAGE === stage: delivers an AuthError report
 *   - On the "implement" stage: makes a git commit in workdir (NOTES.md)
 *   - Delivers a success CompletionReport through the in-process pipeline
 *
 * Registered as "claude-code" in app.pluginRegistry so it intercepts every
 * dispatch without touching PATH or spawning tmux.
 */
function buildFakeClaudeExecutor(app: AppContext, arkDir: string, failStage?: string): Executor {
  const handles = new Map<string, { done: boolean; error: string | null }>();

  return {
    name: "claude-code",

    async launch(opts: LaunchOpts): Promise<LaunchResult> {
      const sessionId = opts.sessionId;
      const stage = opts.stage ?? "unknown";
      const workdir = opts.workdir;
      const handle = `fake-${sessionId}-${stage}`;
      handles.set(handle, { done: false, error: null });

      // Run the fake-claude logic asynchronously so launch() returns quickly.
      void (async () => {
        try {
          // 1. Audit log (mirrors fake-claude.sh behaviour).
          const logDir = join(arkDir, "agent-envs");
          mkdirSync(logDir, { recursive: true });
          const env = { ...process.env, ...(opts.env ?? {}) };
          const envLines = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
          appendFileSync(join(logDir, `${stage}.log`), envLines + "\n");

          // 2. Failure injection.
          const failEnv = process.env.ARK_FAKE_CLAUDE_FAIL_STAGE ?? (opts.env as any)?.ARK_FAKE_CLAUDE_FAIL_STAGE;
          if (failEnv && failEnv === stage) {
            await handleReport(depsFromApp(app), sessionId, {
              type: "error",
              sessionId,
              stage,
              error: "AuthError: 401 Unauthorized",
            });
            handles.set(handle, { done: true, error: null });
            return;
          }

          // 3. Real git commit on implement stage.
          if (stage === "implement" && workdir && existsSync(join(workdir, ".git"))) {
            const now = new Date().toISOString();
            // Create a session-owned branch so createWorktreePR can push it.
            // branch = "ark-s-<sessionId>" matches the session-owned convention
            // in pr.ts so it gets force-pushed (single owner, no collision risk).
            const branchName = `ark-s-${sessionId}`;
            try {
              execFileSync("git", ["-C", workdir, "checkout", "-b", branchName], { stdio: "pipe" });
            } catch {
              // branch may already exist; checkout it
              execFileSync("git", ["-C", workdir, "checkout", branchName], { stdio: "pipe" });
            }
            appendFileSync(join(workdir, "NOTES.md"), `stub commit at ${now}\n`);
            execFileSync("git", ["-C", workdir, "-c", "user.email=stub@ark.local", "-c", "user.name=stub-implementer", "add", "NOTES.md"], { stdio: "pipe" });
            execFileSync("git", ["-C", workdir, "-c", "user.email=stub@ark.local", "-c", "user.name=stub-implementer", "commit", "-m", `stub-implementer: ${sessionId}`], { stdio: "pipe" });
            // Persist the branch name so createWorktreePR finds it without
            // needing to rev-parse HEAD (avoids "Cannot determine branch" failure).
            await app.sessions.update(sessionId, { branch: branchName });
          }

          // 4. Success CompletionReport.
          await handleReport(depsFromApp(app), sessionId, {
            type: "completed",
            sessionId,
            stage,
            summary: `stub completed ${stage} stage`,
            filesChanged: [],
            commits: [],
          });
          handles.set(handle, { done: true, error: null });
        } catch (err: any) {
          handles.set(handle, { done: true, error: err?.message ?? String(err) });
        }
      })();

      return { ok: true, handle, claudeSessionId: `fake-${sessionId}`, pid: 0 };
    },

    async status(handle: string): Promise<ExecutorStatus> {
      const tracked = handles.get(handle);
      if (!tracked) return { state: "not_found" as any };
      if (!tracked.done) return { state: "running" };
      if (tracked.error) return { state: "failed", error: tracked.error };
      return { state: "completed", exitCode: 0 };
    },

    async kill(): Promise<void> {},
    async terminate(): Promise<void> {},
    async send(): Promise<void> {},
    async capture(): Promise<string> { return ""; },
  } as Executor;
}

export interface LocalSpawnOptions {
  /** Absolute path to a temp arkDir. */
  arkDir: string;
  /** Optional: directory to prepend to PATH (for fake-claude.sh override). */
  pathPrefix?: string;
  /** Optional: extra env. Set ARK_FAKE_CLAUDE_FAIL_STAGE here for failure test. */
  extraEnv?: Record<string, string>;
  /** Web/API port. Default 8420. */
  webPort?: number;
}

export interface LocalServerHandle {
  webUrl: string;
  app: AppContext;
  stop: () => Promise<void>;
}

/**
 * In-process local-mode server boot. Builds an AppContext directly with
 * SQLite + local profile, calls startWebServer() for HTTP /api/rpc, and
 * registers test flow + agent fixtures into the file-backed stores.
 *
 * No subprocess, no --hosted flag, no Postgres required.
 */
/**
 * Module-level mutex for the env-mutation + loadAppConfig critical section.
 * loadAppConfig reads process.env.ARK_DIR and process.env.DATABASE_URL at
 * call time. When two startLocalServer calls run concurrently (e.g. parallel
 * beforeAll blocks), the second call can overwrite those env vars before the
 * first call's config assembly reads them, causing both AppContexts to point
 * at the wrong SQLite file. Serializing this section eliminates the race
 * without modifying production code.
 */
let _bootMutex: Promise<void> = Promise.resolve();

export async function startLocalServer(opts: LocalSpawnOptions): Promise<LocalServerHandle> {
  const webPort = opts.webPort ?? 8420;
  await clearStalePorts([webPort]);

  // Serialize the env-mutation + loadAppConfig window so concurrent beforeAll
  // blocks don't race on ARK_DIR / DATABASE_URL.
  let config: Awaited<ReturnType<typeof loadAppConfig>>;
  const prevMutex = _bootMutex;
  let releaseMutex!: () => void;
  _bootMutex = new Promise<void>((resolve) => { releaseMutex = resolve; });
  try {
    await prevMutex;

    // Set env vars that loadAppConfig / assemble() read. These MUST be set
    // inside the critical section because assemble() reads them via readEnv()
    // which calls process.env at assembly time (not at the await boundary).
    process.env.ARK_PROFILE = "local";
    process.env.ARK_DIR = opts.arkDir;
    process.env.ARK_AUTH_REQUIRE_TOKEN = "false";
    process.env.ARK_DEV_FORCE_DIRECT = "1";
    process.env.ARK_WEB_PORT = String(webPort);
    // Always set DATABASE_URL to the current arkDir's db file -- a restart
    // call with a different arkDir must update this, not keep the old value.
    process.env.DATABASE_URL = `file:${opts.arkDir}/ark.db`;
    process.env.REDIS_DISABLED = "1";
    for (const [k, v] of Object.entries(opts.extraEnv ?? {})) {
      process.env[k] = v;
    }
    if (opts.pathPrefix) {
      process.env.PATH = `${opts.pathPrefix}:${process.env.PATH ?? ""}`;
    }

    config = await loadAppConfig({ profile: "local" });
  } finally {
    releaseMutex();
  }

  const app = new AppContext(config);
  await app.boot();

  // Monkey-patch stageAdvance.advance so that when it advances to an action
  // stage (e.g. `pr` with action:create_pr) it also fires dispatchService.dispatch().
  // This is needed because gate/approve calls advance() directly without the
  // HandoffMediator wrapper that handles action-stage auto-execution. Without
  // this patch the session parks forever at status=ready after gate approval.
  // Guard: only fires when result.ok AND resulting stage is an action type.
  const origAdvance = app.stageAdvance.advance.bind(app.stageAdvance);
  app.stageAdvance.advance = async (sessionId, force, outcome, advOpts) => {
    const result = await origAdvance(sessionId, force, outcome, advOpts);
    if (result.ok) {
      try {
        const s = await app.sessions.get(sessionId);
        if (s?.status === "ready" && s?.flow && s?.stage) {
          const action = getStageAction(depsFromApp(app), s.flow, s.stage);
          if (action.type === "action") {
            void app.dispatchService.dispatch(sessionId).catch(() => {});
          }
        }
      } catch { /* best-effort -- never block the advance result */ }
    }
    return result;
  };

  // Override the real `claude-code` executor with an in-process fake so tests
  // run without tmux, PATH manipulation, or a real Anthropic API key.
  // The fake replicates fake-claude.sh: audit log, optional AuthError injection,
  // implement-stage git commit, and success CompletionReport -- all in-process.
  const failStage = opts.extraEnv?.ARK_FAKE_CLAUDE_FAIL_STAGE;
  app.pluginRegistry.register({
    kind: "executor",
    name: "claude-code",
    impl: buildFakeClaudeExecutor(app, opts.arkDir, failStage),
  });

  // Seed required runtime secrets for the default tenant. The claude-code runtime
  // requires CLAUDE_CODE_OAUTH_TOKEN at dispatch time. In tests, the fake executor
  // doesn't read it, but dispatch still validates its presence. Seeding a dummy
  // value is the same pattern AppContext.forTestAsync uses (installTestSecrets).
  try {
    await app.secrets.set("default", "CLAUDE_CODE_OAUTH_TOKEN", "e2e-test-dummy-oauth-token", { type: "env-var" });
  } catch { /* already set -- ignore */ }

  // Register test fixtures so the file-backed stores can find them during dispatch.
  const repoRoot = resolve(import.meta.dir, "../..");

  const flowDef = YAML.parse(
    readFileSync(join(repoRoot, "e2e/fixtures/flows/e2e-docs-review.yaml"), "utf-8"),
  );
  app.flows.save("e2e-docs-review", flowDef as any, "global");

  const plannerDef = YAML.parse(
    readFileSync(join(repoRoot, "e2e/fixtures/agents/stub-planner.yaml"), "utf-8"),
  );
  app.agents.save("stub-planner", plannerDef as any, "global");

  const implDef = YAML.parse(
    readFileSync(join(repoRoot, "e2e/fixtures/agents/stub-implementer.yaml"), "utf-8"),
  );
  app.agents.save("stub-implementer", implDef as any, "global");

  // Re-dispatch any sessions that were running when the server was previously
  // killed. After a restart the fake executor's in-memory state is gone; the
  // rehydrate path would start a status poller that immediately sees "completed"
  // (no handle in memory) and advance the stage forward -- wrong for the
  // restart-then-fail test that needs the fake executor's launch() to run again
  // with the failure injection. Reset running sessions to "ready" so
  // dispatchService picks them up fresh via the registered fake executor.
  try {
    // In local single-tenant mode, app.sessions covers all sessions.
    const runningSessions = await app.sessions.list({ status: "running" as any, limit: 100 });
    for (const session of runningSessions) {
      // Reset to ready so the registered fake executor's launch() fires again
      // (fake executor in-memory state was cleared when the server was killed).
      await app.sessions.update(session.id, { status: "ready", session_id: null });
      void app.dispatchService.dispatch(session.id).catch(() => {});
    }
  } catch { /* best-effort -- never block boot */ }

  // apiOnly: true skips the auto web-assets build at packages/core/hosted/web.ts:191
  // (10-30s on a fresh cache). Tests only hit /api/rpc, never the dashboard.
  const webServer = startWebServer(app, { port: webPort, apiOnly: true });
  const webUrl = `http://localhost:${webPort}`;

  // Boot probe: /api/rpc session/list returns no error => ready.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${webUrl}/api/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "boot", method: "session/list", params: {} }),
      });
      const json = (await r.json()) as { error?: unknown };
      if (!json.error) break;
    } catch { /* not up yet */ }
    await Bun.sleep(100);
  }

  return {
    webUrl,
    app,
    stop: async () => {
      // Stop accepting new RPC first, THEN close the DB. Reverse order
      // would let an in-flight request see a closed DB. Sleep gives the
      // OS time to fully unbind the port -- without it, restart's
      // Bun.serve sometimes silently fails and we poll a dead listener.
      webServer.stop();
      await Bun.sleep(2000);
      await app.shutdown();
    },
  };
}

export async function killServer(handle: ServerHandle): Promise<void> {
  // SIGTERM first -- gives the server a chance to clear timers, drain
  // SSE clients, and disconnect the postgres pool cleanly. The hosted
  // server's broadcastSessions setInterval is what holds the bun event
  // loop open, so without an explicit clear it will outlive SIGTERM if
  // the server's own SIGTERM handler is missing or slow.
  handle.proc.kill("SIGTERM");
  const graceful = Promise.race([
    handle.proc.exited,
    Bun.sleep(2000).then(() => "timeout" as const),
  ]);
  const result = await graceful;
  if (result === "timeout") {
    handle.proc.kill("SIGKILL");
    await handle.proc.exited;
  }
}
