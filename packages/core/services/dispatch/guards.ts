/**
 * Pre-launch guards + short-circuits.
 *
 * Functions here fire before we commit to agent launch:
 *   - validateSessionForDispatch: status / stage / compute_name preconditions
 *   - maybeHandleActionStage:    short-circuit `action:` stages in-process
 *   - cloneRemoteRepoIfNeeded:   shallow-clone session.config.remoteRepo on first
 *                                 dispatch when no local workdir exists yet
 *   - checkPromptInjection:      scan session.summary, log + optionally abort
 *
 * All helpers are pure functions taking a narrow `DispatchDeps`-shaped object so
 * they're trivially unit-testable and don't widen the dispatcher class surface.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { execFile } from "child_process";

import { logWarn } from "../../observability/structured-log.js";
import { detectInjection } from "../../session/prompt-guard.js";
import { buildAuthedHttpsUrl } from "../git/auth-url.js";
import { depsFromApp } from "../deps.js";
import { isRepoUrl } from "../../repo-url.js";
import type { DispatchDeps, DispatchResult } from "./types.js";
import type { Session } from "../../../types/index.js";

const execFileAsync = promisify(execFile);

/**
 * Validate a session is ready to dispatch. Returns null when dispatch may
 * proceed; otherwise returns the terminal DispatchResult to propagate.
 *
 * Caller MUST check for a non-null return and bail. The session row itself is
 * returned alongside so callers don't re-fetch.
 */
export async function validateSessionForDispatch(
  deps: Pick<DispatchDeps, "sessions" | "computes">,
  sessionId: string,
): Promise<{ session: Session; early?: undefined } | { session?: undefined; early: DispatchResult }> {
  const session = await deps.sessions.get(sessionId);
  if (!session) return { early: { ok: false, message: `Session ${sessionId} not found` } };

  if (session.status === "running" && session.session_id) {
    return {
      early: {
        ok: true,
        launched: false,
        reason: "already_running",
        message: `Already running (${session.session_id})`,
      },
    };
  }
  if (session.status !== "ready" && session.status !== "blocked") {
    return {
      early: {
        ok: false,
        message: `Not ready (status: ${session.status}). Stop it first, or wait for it to finish.`,
      },
    };
  }

  if (!session.stage) {
    return { early: { ok: false, message: "No current stage. The session may have completed its flow." } };
  }

  if (session.compute_name && !(await deps.computes.get(session.compute_name))) {
    return {
      early: {
        ok: false,
        message: `Compute '${session.compute_name}' not found. Delete and recreate the session.`,
      },
    };
  }

  return { session };
}

/**
 * Short-circuit handling for `action:` stages. Returns a DispatchResult when
 * the stage is an action (regardless of success/failure) so the caller can
 * return immediately; returns null when the stage is not an action.
 */
export async function maybeHandleActionStage(
  deps: Pick<DispatchDeps, "sessions" | "getStageAction" | "executeAction">,
  session: Session,
): Promise<DispatchResult | null> {
  const sessionId = session.id;
  const stage = session.stage!;
  const earlyAction = await deps.getStageAction(session.flow, stage);
  if (earlyAction.type !== "action") return null;

  const result = await deps.executeAction(sessionId, earlyAction.action ?? "");
  if (!result.ok) {
    await deps.sessions.update(sessionId, {
      status: "failed",
      error: `Action '${earlyAction.action}' failed: ${result.message.slice(0, 200)}`,
    });
    return { ok: false, message: result.message };
  }
  // On success the Temporal workflow drives the post-action handoff.
  return {
    ok: true,
    launched: false,
    reason: "action_stage",
    message: `Executed action '${earlyAction.action}'`,
  };
}

/**
 * Clone a remote repo into the worktrees dir. Two trigger paths:
 *
 *   1. `session.config.remoteRepo` is set (the explicit `--remote-repo`
 *      CLI flag) -- the original contract.
 *   2. `session.repo` itself looks like a git URL -- the UI / curl-an-RPC
 *      caller pasted the SSH/HTTPS URL into the `repo` field. The K8s
 *      executor's cloneSource already does `remoteRepo ?? repo`, so local
 *      mode needs the same fallback to stay consistent: without it
 *      `setupSessionWorktree` `resolve()`s the URL as a relative path and
 *      persists a bogus `<cwd>/git@bitbucket.org:...` workdir that arkd's
 *      `/process/spawn` rejects with ENOENT (real incident, session
 *      `s-z7oe341ehp`).
 *
 * Noop when neither trigger fires or when `session.workdir` is already
 * populated. Mutates the in-memory session object (workdir, repo) so the
 * downstream `setupSessionWorktree` sees a valid local path and the row's
 * `repo` no longer carries the URL.
 *
 * Hosted-mode contract: the conductor process is shared across tenants and
 * its `<arkDir>/worktrees/` lives on the pod's ephemeral disk -- a clone
 * here is wasted work that disappears on pod restart. The compute target's
 * `Compute.prepareWorkspace` is responsible for the remote-side clone in
 * hosted deployments. Skipping the conductor-side clone keeps the session
 * row's `workdir` null until the worker materialises the workspace; the
 * downstream resolver already tolerates that case.
 */
export async function cloneRemoteRepoIfNeeded(
  deps: Pick<DispatchDeps, "sessions" | "events" | "config" | "getApp">,
  session: Session,
  log: (msg: string) => void,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // Pick the source URL: explicit config.remoteRepo wins; otherwise treat
  // session.repo as a URL when it looks like one. Local paths (the
  // existing-checkout use case) skip the clone entirely.
  const repoField = typeof session.repo === "string" ? session.repo : "";
  const remoteUrl =
    (session.config?.remoteRepo as string | undefined) ?? (repoField && isRepoUrl(repoField) ? repoField : undefined);
  if (!remoteUrl || session.workdir) return { ok: true };

  // Hosted dispatch ALWAYS defers cloning to the compute target. The dispatcher
  // pod is a coordinator, not a workspace owner: its filesystem is ephemeral,
  // potentially multi-replica, and shared across tenants. The agent runs in a
  // separate compute pod whose in-pod arkd performs the clone with tenant
  // auth injected (see executors/claude-agent.ts + executors/claude-code.ts
  // cloneSource handling).
  if (deps.getApp().mode.kind === "hosted") {
    log("Skipping conductor-side remote-repo clone in hosted mode (deferred to compute target)");
    return { ok: true };
  }
  const sessionId = session.id;
  const tmpDir = join(deps.config.dirs.ark, "worktrees", sessionId);

  // Retry-safe: a prior dispatch may have left tmpDir behind (partial clone,
  // or full clone that never persisted `session.workdir` due to a crash
  // between `git clone` and the DB update). Reuse only when the clone is
  // fully landed (HEAD resolves to a commit); otherwise wipe and re-clone.
  // `git clone` refuses non-empty destinations with "fatal: destination
  // path '...' already exists and is not an empty directory."
  if (existsSync(tmpDir)) {
    let reusable = false;
    if (existsSync(join(tmpDir, ".git"))) {
      try {
        await execFileAsync("git", ["-C", tmpDir, "rev-parse", "--verify", "HEAD"], { timeout: 5_000 });
        reusable = true;
      } catch {
        // .git exists but HEAD doesn't resolve -- partial / interrupted clone.
      }
    }
    if (reusable) {
      log(`Reusing existing clone at ${tmpDir} (skipping re-clone)`);
      // Update BOTH workdir and repo so setupSessionWorktree's later
      // `resolve(session.repo)` lands on the cloned dir instead of
      // re-resolving the URL as a path (mirrors the clone-success branch).
      await deps.sessions.update(sessionId, { workdir: tmpDir, repo: tmpDir });
      const updated = await deps.sessions.get(sessionId);
      if (updated) {
        (session as { workdir: string | null }).workdir = updated.workdir;
        (session as { repo: string | null }).repo = updated.repo;
      }
      return { ok: true };
    }
    try {
      if (readdirSync(tmpDir).length > 0) {
        log(`Removing stale / partial clone contents at ${tmpDir} before re-clone`);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (e: any) {
      logWarn("session", `cloneRemoteRepoIfNeeded: failed to clean ${tmpDir}: ${e?.message ?? e}`);
    }
  }

  log(`Cloning remote repo: ${remoteUrl}`);
  try {
    mkdirSync(tmpDir, { recursive: true });
    // Inject tenant-scoped basic-auth creds (BITBUCKET_TOKEN/USERNAME,
    // GITHUB_TOKEN) into the URL for hosts we know how to authenticate.
    // Non-https URLs and unknown hosts pass through unchanged.
    const clonedUrl = await buildAuthedHttpsUrl(depsFromApp(deps.getApp()), session, remoteUrl);
    await execFileAsync("git", ["clone", "--depth", "1", clonedUrl, tmpDir], { timeout: 120_000 });
    // Update BOTH workdir and repo so setupSessionWorktree's later
    // `resolve(session.repo)` lands on the cloned dir (a real local git
    // repo) instead of re-resolving the URL as a path.
    await deps.sessions.update(sessionId, { workdir: tmpDir, repo: tmpDir });
    const updated = await deps.sessions.get(sessionId);
    if (updated) {
      (session as { workdir: string | null }).workdir = updated.workdir;
      (session as { repo: string | null }).repo = updated.repo;
    }
    log(`Cloned remote repo to ${tmpDir}`);
    await deps.events.log(sessionId, "remote_repo_cloned", {
      actor: "system",
      data: { url: remoteUrl, dir: tmpDir },
    });
    return { ok: true };
  } catch (e: any) {
    // Strip basic-auth userinfo from any URL in the error before surfacing.
    // Git's "fatal: ... https://x-token-auth:TOKEN@host/..." messages would
    // otherwise leak the token into session.error / event logs.
    const raw = typeof e?.message === "string" ? e.message : String(e);
    const safe = raw.replace(/https:\/\/[^@\s/]+@/g, "https://***@");
    return { ok: false, message: `Failed to clone remote repo: ${safe}` };
  }
}

/**
 * Prompt-injection scan on session.summary. High-severity matches abort
 * dispatch; lower severity only logs a warning. Errors during detection are
 * swallowed so a broken regex or guard helper never blocks dispatch.
 */
export async function checkPromptInjection(
  deps: Pick<DispatchDeps, "events">,
  session: Session,
): Promise<{ blocked: boolean; message?: string }> {
  try {
    const injection = detectInjection(session.summary ?? "");
    if (injection.severity === "high") {
      await deps.events.log(session.id, "prompt_injection_blocked", {
        actor: "system",
        data: { patterns: injection.patterns, context: "dispatch" },
      });
      return { blocked: true, message: "Dispatch blocked: potential prompt injection in task summary" };
    }
    if (injection.detected) {
      await deps.events.log(session.id, "prompt_injection_warning", {
        actor: "system",
        data: { patterns: injection.patterns, severity: injection.severity, context: "dispatch" },
      });
    }
  } catch (err: any) {
    // Don't disable injection blocking silently if the regex throws --
    // surface so a bug here is visible in the structured log.
    logWarn("session", `prompt-injection guard failed: ${err?.message ?? err}`);
  }
  return { blocked: false };
}
