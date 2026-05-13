/**
 * Fake claude-code executor plugin -- in-process for the temporal-worker.
 *
 * The real claude-code executor (packages/core/executors/claude-code.ts) runs
 * a heavy launch path: setupSessionWorktree, MCP server resolution, tmux
 * session creation, then attach + monitor. That whole pipeline takes well over
 * the dispatchStageActivity's 60s heartbeat timeout when running inside the
 * temporal-worker container, so the activity times out before any agent
 * completion signal can arrive.
 *
 * This plugin replaces "claude-code" with an in-process stub that does the
 * minimum to drive the e2e flow forward:
 *   - on stage = "implement": real git commit on a session-owned branch so
 *     the downstream create_pr action has something to push
 *   - delivers a CompletionReport (or AuthError if ARK_FAKE_CLAUDE_FAIL_STAGE
 *     matches) directly via the in-process channel pipeline -- no curl, no
 *     tmux, no claude binary
 *
 * Loaded by `scripts/temporal-worker-entrypoint.sh` which copies this file
 * into `$ARK_DIR/plugins/executors/claude-code.mjs`.
 */
import { execFileSync } from "child_process";
import { join } from "path";

const handles = new Map();

const executor = {
  name: "claude-code",

  async launch(opts) {
    const app = opts.app;
    if (!app) {
      return { ok: false, handle: "", message: "fake-claude-code: opts.app missing" };
    }

    const sessionId = opts.sessionId;
    const stage = opts.stage ?? "unknown";
    const workdir = opts.workdir;
    const handle = `fake-claude-${sessionId}-${stage}-${Date.now()}`;
    handles.set(handle, { done: false, error: null });

    // Lazy-import the report pipeline so this plugin doesn't have to bundle
    // it -- tsx resolves from the worker's node_modules at load time.
    const { handleReport } = await import("/app/packages/core/services/channel/report-pipeline.ts");

    // Fire the rest of the work asynchronously so launch() returns fast and
    // the dispatchStageActivity can complete inside its heartbeat budget.
    void (async () => {
      try {
        // Wait for the dispatch chain's finalizeLaunch AND the workflow's
        // projectStage(status:running) to both land BEFORE we fire the
        // completion report. Otherwise handleReport flips status to
        // "ready" first, then either finalize OR projectStage overwrites
        // it back to "running" -- awaitStageCompletionActivity polls forever
        // because the terminal status never sticks.
        // Poll until status === "running" with a 5s cap so a misbehaving
        // dispatch chain doesn't hang the activity.
        const start = Date.now();
        while (Date.now() - start < 5000) {
          try {
            const cur = await app.sessions.get(sessionId);
            if (cur?.status === "running") break;
          } catch {}
          await new Promise((r) => setTimeout(r, 50));
        }
        // Give projectStage(status:running) an extra moment to land after
        // dispatchStageActivity returns -- it runs immediately after
        // dispatch.return, so 100ms is plenty.
        await new Promise((r) => setTimeout(r, 200));

        // Failure injection. Three resolution paths, first match wins:
        //   1. /tmp/ark-fail-stage flag file (written by register-fixtures via
        //      docker exec). This is the path the restart-then-fail test uses,
        //      because the host can't set worker env vars without rebuilding
        //      the container.
        //   2. process.env (works only if the worker container was started
        //      with the env var baked in).
        //   3. opts.env (per-launch env if dispatch forwards it).
        let failStage = null;
        try {
          const fs = await import("fs");
          const flag = fs.readFileSync("/tmp/ark-fail-stage", "utf-8").trim();
          if (flag) failStage = flag;
        } catch {}
        if (!failStage) {
          failStage = process.env.ARK_FAKE_CLAUDE_FAIL_STAGE ?? opts.env?.ARK_FAKE_CLAUDE_FAIL_STAGE;
        }
        if (failStage && failStage === stage) {
          await handleReport(app, sessionId, {
            type: "error",
            sessionId,
            stage,
            error: "AuthError: 401 Unauthorized",
          });
          handles.set(handle, { done: true, error: "AuthError: 401 Unauthorized" });
          return;
        }

        // Implement stage: make a real commit on a session-owned branch so
        // create_pr has something to push.
        if (stage === "implement" && workdir) {
          try {
            const branchName = `ark-s-${sessionId}`;
            try {
              execFileSync("git", ["-C", workdir, "checkout", "-b", branchName], { stdio: "pipe" });
            } catch {
              execFileSync("git", ["-C", workdir, "checkout", branchName], { stdio: "pipe" });
            }
            const fs = await import("fs");
            fs.appendFileSync(join(workdir, "NOTES.md"), `stub commit at ${new Date().toISOString()}\n`);
            execFileSync(
              "git",
              [
                "-C",
                workdir,
                "-c",
                "user.email=stub@ark.local",
                "-c",
                "user.name=stub-implementer",
                "add",
                "NOTES.md",
              ],
              { stdio: "pipe" },
            );
            execFileSync(
              "git",
              [
                "-C",
                workdir,
                "-c",
                "user.email=stub@ark.local",
                "-c",
                "user.name=stub-implementer",
                "commit",
                "-m",
                `stub-implementer: ${sessionId}`,
              ],
              { stdio: "pipe" },
            );
            // Persist branch so createWorktreePR finds it without rev-parsing HEAD.
            await app.sessions.update(sessionId, { branch: branchName });
          } catch (e) {
            console.error(`[fake-claude-code] implement-stage commit failed: ${e?.message ?? e}`);
          }
        }

        // Deliver the CompletionReport. handleReport flips the row to
        // status="ready" which awaitStageCompletionActivity treats as
        // stage-done under Temporal.
        await handleReport(app, sessionId, {
          type: "completed",
          sessionId,
          stage,
          summary: `stub completed ${stage} stage`,
          filesChanged: [],
          commits: [],
        });
        handles.set(handle, { done: true, error: null });
      } catch (e) {
        handles.set(handle, { done: true, error: e?.message ?? String(e) });
      }
    })();

    return { ok: true, handle, claudeSessionId: `fake-${sessionId}`, pid: 0 };
  },

  async status(handle) {
    const tracked = handles.get(handle);
    if (!tracked) return { state: "not_found" };
    if (!tracked.done) return { state: "running" };
    if (tracked.error) return { state: "failed", error: tracked.error };
    return { state: "completed", exitCode: 0 };
  },

  async kill() {},
  async terminate() {},
  async send() {},
  async capture() {
    return "";
  },
};

export default executor;
