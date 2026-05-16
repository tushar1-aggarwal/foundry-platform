/**
 * Shared helper for `Compute.prepareWorkspace`.
 *
 * Every Compute kind whose worktree lives away from the conductor's
 * filesystem (EC2, k8s, firecracker, kata) needs the same two arkd ops to
 * set up a per-session worktree: mkdir the parent, then git clone into the
 * leaf. Factored here so a future change (idempotency probe, shallow-clone
 * flags, alternative git transport) lands in one place.
 */

import { ArkdClient } from "../../arkd/client/index.js";

export interface RemoteCloneOpts {
  /** Conductor-reachable arkd URL for the target compute (`getArkdUrl(handle)`). */
  arkdUrl: string;
  /** Optional bearer token for arkd. Pass `process.env.ARK_ARKD_TOKEN ?? null`. */
  arkdToken: string | null;
  /** Source URL or path the remote `git clone` will pull from. */
  source: string;
  /** Absolute path on the compute the worktree should live at. */
  remoteWorkdir: string;
  /**
   * Optional branch to check out after clone. When set, issues a third
   * arkd op: `git -C <remoteWorkdir> checkout -b <branch>`. Lets every
   * remote-compute session land on its own branch without requiring the
   * agent to remember the `git checkout -b` step. Caller is responsible
   * for resolving the effective name (typically `session.branch ??
   * "ark-<sessionId>"`). Omit/undefined to skip the checkout entirely.
   */
  branch?: string;
  /**
   * Optional commit-author identity. When BOTH authorName AND authorEmail
   * are set, two additional arkd ops are issued after the checkout to
   * pin the identity on the cloned repo:
   *   git -C <wd> config user.name <authorName>
   *   git -C <wd> config user.email <authorEmail>
   * Without this, the sandbox pod has no git config and the agent invents
   * one at commit time, which Bitbucket's BB Violator rewrites away.
   * Partial sets (only name or only email) are ignored entirely -- the
   * caller is expected to resolve a coherent pair via
   * `resolveAgentIdentityForRemoteCompute`.
   */
  authorName?: string;
  authorEmail?: string;
}

/**
 * `mkdir -p <parent>` + `git clone <source> <remoteWorkdir>` via arkd
 * HTTP. Used by every Compute kind whose worktree lives away from the
 * conductor's filesystem.
 *
 * Idempotency: the dispatcher's `Compute.resolveWorkdir` embeds the
 * session id into the path (`Projects/<sid>/<repo>`), so the leaf is
 * fresh per dispatch. The mkdir is also idempotent. We don't probe
 * "is this already cloned?" because the path is fresh; if a future
 * impl re-uses the path across dispatches, add a `git status` probe
 * here.
 *
 * Timeouts: 15s for mkdir, 120s for clone. Bumping clone past 120s
 * has historically masked broken-network sessions; lowering it
 * regresses sessions cloning large repos over slow links.
 */
export async function cloneWorkspaceViaArkd(opts: RemoteCloneOpts): Promise<void> {
  const client = new ArkdClient(opts.arkdUrl, opts.arkdToken ? { token: opts.arkdToken } : undefined);
  const parent = opts.remoteWorkdir.replace(/\/[^/]+$/, "");
  await client.run({ command: "mkdir", args: ["-p", parent], timeout: 15_000 });
  await client.run({ command: "git", args: ["clone", opts.source, opts.remoteWorkdir], timeout: 120_000 });
  if (opts.branch) {
    // -B (uppercase) creates the branch if missing, or moves it to current
    // HEAD if it already exists. Idempotent across retries of this step --
    // -b (lowercase) would fail with "branch already exists" on attempt 2.
    // Note: only the branch ref is idempotent here; the preceding `git clone`
    // still fails on retry-after-partial-success because the target dir is
    // non-empty. A full retry-safe path would probe `<wd>/.git` first; not
    // done here to keep the helper to one transaction.
    await client.run({
      command: "git",
      args: ["-C", opts.remoteWorkdir, "checkout", "-B", opts.branch],
      timeout: 15_000,
    });
  }
  if (opts.authorName && opts.authorEmail) {
    // Pin the agent's commit identity so the implement-stage commit, the
    // auto-commit rescue path, and the PR-stage rebase+push all carry the
    // same author. `git config` writes to the repo-local config and is
    // idempotent. Sequenced (name then email) because both are cheap.
    await client.run({
      command: "git",
      args: ["-C", opts.remoteWorkdir, "config", "user.name", opts.authorName],
      timeout: 15_000,
    });
    await client.run({
      command: "git",
      args: ["-C", opts.remoteWorkdir, "config", "user.email", opts.authorEmail],
      timeout: 15_000,
    });
  }
}
