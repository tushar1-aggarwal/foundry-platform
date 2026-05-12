/**
 * stub-runner executor plugin -- sidecar variant for e2e testing.
 *
 * Same name (`stub-runner`) as `stub-runner-executor.mjs`, but the launch
 * path runs `stub-agent.sh` INSIDE the session's arkd-sidecar container
 * via `ComputeHandle.spawnProcess`, instead of spawning a child process
 * on the conductor host.
 *
 * Used by T1-T5 when the test stack is configured with
 * `compute=local + isolation=docker` (the same shape T6 uses with real
 * claude). This exercises the same dispatch chain a production agent goes
 * through -- provision -> ensure-reachable -> prepare-workspace ->
 * isolation-prepare -> arkd `/process/spawn` -- while still using a stub
 * script so no LLM, no Bitbucket creds, no Keychain are needed.
 *
 * Selected at test setup by which plugin file the test copies into
 * `<arkDir>/plugins/executors/stub-runner.mjs`. Loader registers under
 * the executor's `name` field; here that's still `stub-runner` so the
 * runtime YAML (`runtime: stub-runner`) keeps working unchanged.
 */
import { spawn as nodeSpawn } from "child_process";

const STUB_SCRIPT_IN_SIDECAR = "/opt/ark/e2e/fixtures/stub-agent.sh";

/**
 * Tiny in-process bookkeeping so kill/status calls during a test don't
 * need to round-trip the compute. The stub script exits within ~1s of
 * launch, so this map's entries are short-lived.
 */
const processes = new Map();

const executor = {
  name: "stub-runner",

  async launch(opts) {
    const app = opts.app;
    if (!app) {
      return { ok: false, handle: "", message: "stub-runner-sidecar: opts.app missing" };
    }
    const session = await app.sessions.get(opts.sessionId);
    if (!session) {
      return { ok: false, handle: "", message: `Session ${opts.sessionId} not found` };
    }

    const stage = opts.stage ?? session.stage ?? "";
    const handle = `stub-${session.id}-${Date.now()}`;

    // Conductor URL the SIDECAR curls back to. The script runs INSIDE the
    // arkd-sidecar container, so `localhost` resolves to the sidecar itself
    // (no conductor there). It has to reach the HOST -- which is
    // `host.docker.internal` on Docker Desktop (Mac/Windows) and via the
    // docker0 bridge on Linux when host-gateway is mapped.
    //
    // The worker process inherits ARK_CONDUCTOR_URL=http://localhost:8422
    // from its own env, but that's a HOST-side url that's wrong inside the
    // sidecar. Rewrite any localhost/127.0.0.1 in the inherited URL to
    // host.docker.internal so the sidecar-side curl can reach the host.
    const inheritedConductorUrl = process.env.ARK_CONDUCTOR_URL;
    const fallbackPort = process.env.ARK_WEB_PORT ?? app.config?.ports?.conductor ?? 19102;
    const conductorUrl = inheritedConductorUrl
      ? inheritedConductorUrl.replace(/\/\/(?:localhost|127\.0\.0\.1)(?=[:/])/, "//host.docker.internal")
      : `http://host.docker.internal:${fallbackPort}`;

    // Resolve compute target + handle. Mirrors what claude-agent.ts does --
    // the executor owns running the lifecycle (provision / ensure-reachable /
    // prepare-workspace / isolation-prepare / launch-agent) before it spawns
    // the script via /process/spawn.
    const repoRoot = process.cwd();
    let resolveTargetAndHandle;
    let runTargetLifecycle;
    try {
      // Use .js extension to match the codebase's ESM convention -- Bun
      // resolves .js -> .ts source when running from a TypeScript checkout
      // (every dev / e2e invocation goes through `bun run`).
      ({ resolveTargetAndHandle } = await import(`${repoRoot}/packages/core/services/dispatch/target-resolver.js`));
      ({ runTargetLifecycle } = await import(`${repoRoot}/packages/core/services/dispatch/target-lifecycle.js`));
    } catch (err) {
      return {
        ok: false,
        handle: "",
        message: `stub-runner-sidecar: dispatch helpers import failed (${err?.message ?? err})`,
      };
    }

    const { target, handle: computeHandle } = await resolveTargetAndHandle(app, session);
    if (!target || !computeHandle) {
      return {
        ok: false,
        handle: "",
        message: `stub-runner-sidecar: no compute target for session.compute_name='${session.compute_name ?? "(none)"}'`,
      };
    }

    // Fall back to host-side nodeSpawn when the compute kind doesn't support
    // /process/spawn -- happens when the test stack still has
    // `isolation=direct`. Keeps the plugin a drop-in replacement for the
    // host-spawn version, so flipping the compute row toggles execution
    // surface without a code change.
    if (!computeHandle.spawnProcess) {
      return launchOnHost(opts, conductorUrl, handle, session, stage);
    }

    const env = {
      ARK_SESSION_ID: session.id,
      ARK_STAGE: stage,
      ARK_CONDUCTOR_URL: conductorUrl,
      // Pass through any secrets the dispatcher resolved (e.g. ANTHROPIC_*).
      // The stub script ignores them, but downstream stages may run inside
      // the same sidecar and need them in the process env.
      ...(opts.env ?? {}),
    };

    try {
      await runTargetLifecycle(
        app,
        session.id,
        target,
        computeHandle,
        // Legacy LaunchOpts fields -- launchOverride below replaces the
        // terminal step so these are inert. Kept on the call to satisfy the
        // type signature.
        { tmuxName: handle, workdir: "/tmp", launcherContent: "", ports: [] },
        {
          prepareCtx: { workdir: "/tmp", onLog: opts.onLog },
          launchOverride: async () => {
            // Route through the SIDECAR'S arkd, not the host arkd. The host
            // arkd's `/process/spawn` would run bash on the host, where
            // `/opt/ark/...` doesn't exist. `handle.meta.docker.arkdUrl`
            // is the loopback-host port DockerIsolation.prepare() mapped
            // to the sidecar container's arkd:19300, so a fresh ArkdClient
            // there reaches arkd-inside-sidecar -> stub-agent.sh runs in
            // the sidecar (where /opt/ark is the mounted repo).
            //
            // computeHandle.spawnProcess is wired via attachComputeMethods
            // against LocalCompute.getArkdUrl which returns the HOST arkd
            // -- we deliberately bypass it.
            const sidecarUrl = computeHandle?.meta?.docker?.arkdUrl;
            if (!sidecarUrl) {
              throw new Error(
                `stub-runner-sidecar: handle.meta.docker.arkdUrl missing -- DockerIsolation.prepare did not run or did not set the sidecar URL`,
              );
            }
            const { ArkdClient } = await import(`${repoRoot}/packages/arkd/client/index.js`);
            const arkdClient = new ArkdClient(sidecarUrl);
            await arkdClient.spawnProcess({
              handle,
              cmd: "/bin/bash",
              args: [STUB_SCRIPT_IN_SIDECAR],
              workdir: "/tmp",
              env,
            });
            // Return a minimal AgentHandle. The conductor stores the
            // sessionName in session_id and tracks lifecycle via
            // ComputeHandle.statusProcess (queried by status-poller). None
            // of the AgentHandle methods are exercised in T1-T5; tmux-style
            // capture/kill paths run on real runtimes only.
            return {
              sessionName: handle,
              kill: async () => {},
              captureOutput: async () => "",
              checkAlive: async () => true,
              sendUserMessage: async () => ({ delivered: false }),
            };
          },
        },
      );
    } catch (err) {
      return {
        ok: false,
        handle: "",
        message: `stub-runner-sidecar: launch failed (${err?.message ?? err})`,
      };
    }

    processes.set(handle, { computeHandle, exited: false, exitCode: null });
    return { ok: true, handle };
  },

  async kill(handle) {
    const tracked = processes.get(handle);
    if (!tracked || tracked.exited) return;
    try {
      if (tracked.computeHandle?.killProcess) {
        await tracked.computeHandle.killProcess(handle);
      } else if (tracked.proc) {
        tracked.proc.kill();
      }
    } catch {
      // best-effort -- process may already be gone
    }
    setTimeout(() => processes.delete(handle), 1000);
  },

  async status(handle) {
    // Return "idle" so the runtime-agnostic status-poller falls through to
    // the compute's `statusProcess` (queried via `probeStatus` when defined,
    // or via `AgentHandle.checkAlive` otherwise). Either way the canonical
    // signal -- session row flips to completed/failed -- comes from the
    // channel/deliver report the stub script posts, not from this poll.
    const tracked = processes.get(handle);
    if (!tracked) return { state: "not_found" };
    return { state: "idle" };
  },

  async send(_handle, _message) {
    // No stdin interaction for the stub script.
  },

  async capture(_handle, _lines) {
    // Output is not captured for this stub. arkd's /file/read could surface
    // stdio.log if a test wants it, but T1-T5 don't.
    return "";
  },
};

/**
 * Direct-mode fallback: spawn `stub-agent.sh` on the conductor host. Mirrors
 * the original stub-runner-executor.mjs so this plugin can drop in when
 * isolation=direct without forcing the test to keep two plugins around.
 */
function launchOnHost(opts, conductorUrl, handle, session, stage) {
  // process.cwd() is the repo root for both `make test-e2e-*` and `bun test`
  // invocations -- the conductor child process inherits cwd from the spawner.
  const stubScript = `${process.cwd()}/e2e/fixtures/stub-agent.sh`;
  const env = {
    ...process.env,
    ...(opts.env ?? {}),
    ARK_SESSION_ID: session.id,
    ARK_STAGE: stage,
    ARK_CONDUCTOR_URL: conductorUrl,
  };
  let proc;
  try {
    proc = nodeSpawn("bash", [stubScript], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return { ok: false, handle: "", message: `stub-runner-sidecar host fallback failed: ${err?.message ?? err}` };
  }
  const tracked = { proc, exited: false, exitCode: null };
  proc.on("exit", (code) => {
    tracked.exited = true;
    tracked.exitCode = code;
    setTimeout(() => processes.delete(handle), 5 * 60 * 1000);
  });
  processes.set(handle, tracked);
  return { ok: true, handle, pid: proc.pid };
}

export default executor;
