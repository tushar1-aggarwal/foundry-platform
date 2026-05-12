/**
 * stub-runner executor plugin -- e2e testing only.
 *
 * This file is copied to <arkDir>/plugins/executors/stub-runner.js before the
 * e2e server boots so the server discovers it via loadPluginExecutors.
 *
 * The executor launches e2e/fixtures/stub-agent.sh, injecting the session
 * context env vars (ARK_SESSION_ID, ARK_STAGE, ARK_CONDUCTOR_URL) that
 * the built-in subprocess executor does not inject automatically.
 *
 * No tmux is involved -- the script runs as a plain child process. The test
 * exercises the full dispatch chain (DispatchService -> CoreDispatcher ->
 * executor.launch -> process -> channel HTTP -> applyReport -> StageAdvancer)
 * without requiring an LLM or a real agent runtime.
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn as nodeSpawn } from "child_process";

// Derive the repo root from this file's location.
// At e2e time this file lives at:
//   <arkDir>/plugins/executors/stub-runner.js
// The source file lives at:
//   <repoRoot>/e2e/fixtures/stub-runner-executor.js
// The server is spawned with cwd=repoRoot, so process.cwd() is repoRoot.
const STUB_SCRIPT = join(process.cwd(), "e2e", "fixtures", "stub-agent.sh");

/** Minimal in-memory tracking so status/kill/capture work if called. */
const processes = new Map();

const executor = {
  name: "stub-runner",

  async launch(opts) {
    const { sessionId, env: secretEnv = {} } = opts;
    // session.stage is the authoritative stage for this dispatch -- read from
    // opts.stage (LaunchOpts) which dispatch-core.ts sets from session.stage.
    const stage = opts.stage ?? "";
    // ARK_CONDUCTOR_URL takes precedence so containerised executors can
    // reach the conductor on the docker host (e.g. host.docker.internal).
    // Falls back to localhost+port for the local-mode executor.
    const conductorPort = process.env.ARK_CONDUCTOR_PORT ?? "19102";
    const conductorUrl = process.env.ARK_CONDUCTOR_URL ?? `http://localhost:${conductorPort}`;

    const env = {
      ...process.env,
      ...secretEnv,
      ARK_SESSION_ID: sessionId,
      ARK_STAGE: stage,
      ARK_CONDUCTOR_URL: conductorUrl,
    };

    const handle = `stub-${sessionId}-${Date.now()}`;

    // Use Node's child_process.spawn so the executor runs unchanged under
    // both Bun (local mode) and Node (Temporal worker container). Bun also
    // implements the `child_process` shim so `nodeSpawn` works there.
    let proc;
    try {
      proc = nodeSpawn("bash", [STUB_SCRIPT], {
        cwd: process.cwd(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return { ok: false, handle: "", message: `stub-runner spawn failed: ${err?.message ?? err}` };
    }

    const tracked = { proc, exited: false, exitCode: null };

    proc.on("exit", (code) => {
      tracked.exited = true;
      tracked.exitCode = code;
      // Auto-cleanup after 5 minutes.
      setTimeout(() => processes.delete(handle), 5 * 60 * 1000);
    });

    processes.set(handle, tracked);
    return { ok: true, handle, pid: proc.pid };
  },

  async kill(handle) {
    const tracked = processes.get(handle);
    if (!tracked || tracked.exited) return;
    try {
      tracked.proc.kill();
    } catch {
      // already gone
    }
    setTimeout(() => processes.delete(handle), 1000);
  },

  async status(handle) {
    const tracked = processes.get(handle);
    if (!tracked) return { state: "not_found" };
    if (!tracked.exited) return { state: "running", pid: tracked.proc.pid };
    if (tracked.exitCode === 0) return { state: "completed", exitCode: 0 };
    return { state: "failed", error: `Exit code ${tracked.exitCode}` };
  },

  async send(_handle, _message) {
    // No stdin interaction for the stub script.
  },

  async capture(handle, lines) {
    // Output is not captured for this minimal stub.
    return "";
  },
};

export default executor;
