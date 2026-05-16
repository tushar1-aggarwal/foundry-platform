/**
 * Boots an `ark web` subprocess for Playwright tests.
 *
 * Playwright always runs its test runner (and therefore this fixture) under
 * Node, so this file must stay Node-only -- no `bun` import, no Bun.* APIs.
 * The subprocess itself IS Bun (`bun packages/cli/index.ts web`) and owns
 * its own AppContext + DB; we only seed state over HTTP via rpc().
 *
 * - Calls setupE2E() to get an isolated temp arkDir + workdir
 * - Builds web frontend via `bun run packages/web/build.ts` (cached per-process)
 * - Spawns `bun <cli> web --port <random>` with ARK_TEST_DIR=<arkDir>
 * - Polls /api/rpc + GET / until the server is ready (30s timeout)
 * - Returns { port, baseUrl, env, serverProcess, teardown, rpc, rpcRaw }
 *
 * Teardown contract: must complete within TEARDOWN_BUDGET_MS even if the
 * subprocess ignores signals. The Playwright `afterAll` hook has a 60s
 * timeout -- if ours ever exceeds that, the worker gets SIGKILLed,
 * Playwright fails the whole suite with "Timed out waiting 300s for the
 * teardown for test suite to run", and downstream specs that would have run
 * on the same worker are reported as "did not run".
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setupE2E, type E2EEnv } from "./app.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
// Invoke the Bun CLI entry point directly rather than going through the
// `ark` bash wrapper. The wrapper spawns `bun` as a child of `bash`, and
// bash does NOT forward signals to children -- so serverProcess.kill()
// terminated bash but left bun reparented to launchd/init. That was the
// dominant source of "orphan ark web process" warnings at the end of each
// run. Spawning bun directly means SIGTERM lands on the process we care
// about, and the `exit` event fires promptly.
const ARK_CLI = join(REPO_ROOT, "packages", "cli", "index.ts");
const WEB_DIST = join(REPO_ROOT, "packages", "web", "dist", "index.html");

// Per-process build cache. 19 spec files each call setupWebServer() in
// beforeAll; without this guard Vite rebuilds the web bundle 19 times per
// worker, burning 3-5 minutes of wall-clock that's pure overhead on CI.
let buildPromise: Promise<void> | null = null;

// Track every spawned server so we can reap orphans on host exit.
// Without this, a Playwright worker that dies mid-test leaks `ark web`
// subprocesses to launchd (they survive as immortal zombies until the
// box reboots -- we've seen 100+ accumulate over a day of flaky runs).
const LIVE_SERVERS = new Set<ChildProcess>();
let exitHookInstalled = false;

// Upper bound on how long teardown() may take. Must stay strictly below the
// Playwright afterAll hook timeout (60s) or the worker gets SIGKILLed before
// we can clean up -- which is exactly the "did not run" failure mode we're
// protecting against.
const TEARDOWN_BUDGET_MS = 20_000;

/** Resolves once the child has exited (immediately if it already has). */
function exited(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => proc.once("exit", () => resolve()));
}

function killServer(proc: ChildProcess): void {
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  LIVE_SERVERS.delete(proc);
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const reap = () => {
    for (const proc of LIVE_SERVERS) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    LIVE_SERVERS.clear();
  };
  process.on("exit", reap);
  process.on("SIGINT", () => {
    reap();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    reap();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    reap();
    throw err;
  });
}

/** Read a child stream fully to a string (returns "" if the stream is absent). */
function drain(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise((resolve) => {
    let buf = "";
    stream.on("data", (c) => {
      buf += String(c);
    });
    stream.on("end", () => resolve(buf));
    stream.on("error", () => resolve(buf));
  });
}

/**
 * Build the web frontend once per worker process. Subsequent calls await the
 * same promise, so N concurrent spec setups share a single build.
 *
 * We always rebuild at least once so the dist reflects the current source,
 * but we skip the build entirely if the dist already exists AND the caller
 * has opted into reuse via ARK_E2E_REUSE_WEB_BUILD. That env var is off by
 * default to keep CI runs reproducible; local iteration sets it to save time.
 */
function buildWebOnce(): Promise<void> {
  if (buildPromise) return buildPromise;
  if (process.env.ARK_E2E_REUSE_WEB_BUILD === "1" && existsSync(WEB_DIST)) {
    buildPromise = Promise.resolve();
    return buildPromise;
  }
  buildPromise = (async () => {
    const buildResult = spawn("bun", ["run", "packages/web/build.ts"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrPromise = drain(buildResult.stderr);
    const code: number | null = await new Promise((resolve) => buildResult.once("exit", (c) => resolve(c)));
    if (code !== 0) {
      const stderr = await stderrPromise;
      // Reset so a later retry can re-attempt the build instead of sticking
      // on the cached failure.
      buildPromise = null;
      throw new Error(`Web build failed: ${stderr}`);
    }
  })();
  return buildPromise;
}

export interface WebServerEnv {
  port: number;
  baseUrl: string;
  env: E2EEnv;
  serverProcess: ChildProcess;
  teardown: () => Promise<void>;
  /** Send a JSON-RPC request to the web server and return the parsed result. */
  rpc: <T = any>(method: string, params?: Record<string, unknown>) => Promise<T>;
  /** Send a JSON-RPC request and return the raw response (for status checks). */
  rpcRaw: (method: string, params?: Record<string, unknown>) => Promise<Response>;
}

function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

/** Resolves to `value` after `ms`. Used to bound hangs with Promise.race. */
function deadline<T>(ms: number, value: T): Promise<T> {
  return new Promise((r) => setTimeout(() => r(value), ms));
}

async function pollReady(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const stop = Date.now() + timeoutMs;
  let apiReady = false;
  let htmlReady = false;
  while (Date.now() < stop) {
    if (!apiReady) {
      try {
        const res = await fetch(`${baseUrl}/api/rpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "status/get", params: {} }),
        });
        if (res.ok) apiReady = true;
      } catch {
        // server not up yet
      }
    }
    if (apiReady && !htmlReady) {
      // Static-serve path is initialized separately from the RPC route.
      // Probing the document root catches the race where the API is live
      // but `GET /` still 404s, which makes page.goto() retry for the
      // entire navigation timeout (30s default) and burns our test budget.
      try {
        const res = await fetch(`${baseUrl}/`, { method: "GET" });
        if (res.ok) {
          htmlReady = true;
          return;
        }
      } catch {
        // static handler not yet attached
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Web server did not become ready within ${timeoutMs}ms (api=${apiReady}, html=${htmlReady})`);
}

export async function setupWebServer(): Promise<WebServerEnv> {
  installExitHook();
  const env = await setupE2E();

  // Build web frontend (cached per worker process).
  await buildWebOnce();

  const port = randomPort();
  const baseUrl = `http://localhost:${port}`;

  const serverProcess = spawn("bun", [ARK_CLI, "web", "--port", String(port)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ARK_TEST_DIR: env.arkDir,
      // Belt-and-suspenders against orphan leak: if Playwright SIGKILLs this
      // worker (timeout, whole-run abort), our in-process reap hooks do not
      // fire. The child's parent-death watchdog notices ppid -> 1 and exits.
      ARK_WATCH_PARENT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain child stdio so a full pipe buffer can't wedge the subprocess.
  serverProcess.stdout?.resume();
  serverProcess.stderr?.resume();
  LIVE_SERVERS.add(serverProcess);

  try {
    await pollReady(baseUrl);
  } catch (err) {
    killServer(serverProcess);
    // Bound env.teardown() on the failure path too -- a hang here is the
    // single most common cause of "Timed out waiting 300s for the test suite
    // to run", because the spec hook never gets to run its own afterAll.
    await Promise.race([env.teardown(), deadline(TEARDOWN_BUDGET_MS, undefined)]);
    throw err;
  }

  let rpcId = 0;

  async function rpcRaw(method: string, params: Record<string, unknown> = {}): Promise<Response> {
    return fetch(`${baseUrl}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
  }

  async function rpc<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await rpcRaw(method, params);
    const data = (await res.json()) as any;
    if (data.error) throw new Error(data.error.message || "RPC error");
    return data.result as T;
  }

  return {
    port,
    baseUrl,
    env,
    serverProcess,
    rpc,
    rpcRaw,
    teardown: async () => {
      // Total teardown budget. No single phase may block forever -- each uses
      // Promise.race against `deadline`. Exceeding 60s here would SIGKILL the
      // worker and cascade into "did not run" on later specs.
      const overallDeadline = Date.now() + TEARDOWN_BUDGET_MS;
      const remaining = () => Math.max(0, overallDeadline - Date.now());

      // SIGTERM first for a clean shutdown, then SIGKILL after 500ms if the
      // subprocess is hung mid-boot or ignoring signals.
      try {
        serverProcess.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      const termed = await Promise.race([exited(serverProcess).then(() => true), deadline(500, false)]);
      if (!termed) {
        try {
          serverProcess.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        // After SIGKILL the kernel should reap within milliseconds. Wait but
        // do not block forever -- if `exit` never fires (pid table wedged)
        // we still want to release the worker.
        await Promise.race([exited(serverProcess), deadline(1_000, undefined)]);
      }
      LIVE_SERVERS.delete(serverProcess);

      // env.teardown() rm -rf's the temp arkDir + workdir and prunes
      // worktrees. Any of those can hang under pressure (fs lock, flock
      // contention). Bound the total.
      await Promise.race([env.teardown(), deadline(remaining(), undefined)]);
    },
  };
}
