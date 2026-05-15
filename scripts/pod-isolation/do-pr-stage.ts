#!/usr/bin/env bun
/**
 * Pod-isolation PR stage. Reproduces the production push-and-parse path that
 * `createWorktreePR` (packages/core/services/worktree/pr.ts) runs for
 * non-GitHub hosts, WITHOUT constructing an AppContext. The three pure
 * helpers (`detectGitHost`, `parseCreatePrUrl`, `fallbackBranchUrl`) are
 * VERBATIM copies of the production code -- not a re-implementation -- so
 * the URL the pod records is byte-identical to what the production CP
 * surfaces for the same push stderr.
 *
 * Why inline instead of dynamically importing from /app/packages/core/...
 *   1. Avoid pulling in pr.ts's transitive deps (AppContext, sessions,
 *      compute-resolver, repo-config, REST-API clients) which don't exist
 *      and aren't needed inside an isolation pod.
 *   2. Decouple from the running image's source tree: the ConfigMap-mounted
 *      script becomes the source of truth per run, no image rebuild needed
 *      when the helpers evolve (matches the documented "edit in pod" debug
 *      preference).
 * If pr.ts diverges, update the inlined helpers below -- they are simple
 * pure functions with no side effects.
 *
 * Inputs (env):
 *   ARK_WORKDIR        path to the git checkout to push from
 *   ARK_BRANCH         branch name (e.g. iso-XXXX)
 *   ARK_AUTHED_URL     https://x-bitbucket-api-token-auth:<token>@host/owner/repo
 *   ARK_ORIGINAL_URL   the pre-auth https://host/owner/repo (used for host detection
 *                      and the recorded pr_url; the authed URL contains the token)
 *
 * Outputs (stdout JSON):
 *   { pr_url, host, branch, push_exit, terminal_reason }
 *
 * Push stdout+stderr are echoed on this process's stderr so the caller's
 * stderr.log captures them for debugging.
 */
import { spawnSync } from "child_process";

// ── inlined from packages/core/services/worktree/pr.ts ──────────────────────
// Source-of-truth: pr.ts:54-61 (detectGitHost), pr.ts:238-247 (parseCreatePrUrl),
// pr.ts:255-276 (fallbackBranchUrl). VERBATIM -- update here if pr.ts diverges.

type GitHost = "github" | "bitbucket" | "gitlab" | "unknown";

function detectGitHost(repoUrl: string | null | undefined): GitHost {
  if (!repoUrl) return "unknown";
  const lower = repoUrl.toLowerCase();
  if (lower.includes("github.com")) return "github";
  if (lower.includes("bitbucket.org")) return "bitbucket";
  if (lower.includes("gitlab.com")) return "gitlab";
  return "unknown";
}

function parseCreatePrUrl(pushStderr: string): string | null {
  if (!pushStderr) return null;
  const lines = pushStderr.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes("remote:")) continue;
    const m = line.match(/https?:\/\/[^\s)>\]"']+/);
    if (m) return m[0];
  }
  return null;
}

function fallbackBranchUrl(host: GitHost, remoteUrl: string | null, branch: string): string | null {
  if (!remoteUrl) return null;
  let normalized = remoteUrl;
  const sshMatch = normalized.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (sshMatch) normalized = `https://${sshMatch[1]}/${sshMatch[2]}`;
  normalized = normalized.replace(/\.git$/, "");
  if (host === "bitbucket") return `${normalized}/branch/${encodeURIComponent(branch)}`;
  if (host === "gitlab") return `${normalized}/-/tree/${encodeURIComponent(branch)}`;
  if (host === "github") return null;
  return normalized;
}

// ── stage logic ─────────────────────────────────────────────────────────────

interface Envelope {
  pr_url: string | null;
  host: string;
  branch: string;
  push_exit: number;
  terminal_reason: string;
}

function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`do-pr-stage: missing env ${name}`);
    process.exit(2);
  }
  return v;
}

function runGit(workdir: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("git", ["-C", workdir, ...args], {
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
    status: typeof r.status === "number" ? r.status : 1,
  };
}

function main(): void {
  const workdir = envOrDie("ARK_WORKDIR");
  const branch = envOrDie("ARK_BRANCH");
  const authedUrl = envOrDie("ARK_AUTHED_URL");
  const originalUrl = envOrDie("ARK_ORIGINAL_URL");

  // Mirror production: rewrite origin to authed URL so push carries auth.
  // The token is only in the in-memory git config of this pod; the pod is
  // destroyed at end of run, so no restore is necessary.
  const setUrl = runGit(workdir, ["remote", "set-url", "origin", authedUrl]);
  if (setUrl.status !== 0) {
    console.error(`do-pr-stage: remote set-url failed (exit ${setUrl.status}): ${setUrl.stderr}`);
    process.exit(3);
  }

  // Push and capture stderr (where Bitbucket emits the Create-PR hint).
  // `--no-verify` + `-u` mirror production pushArgs in createWorktreePR.
  const push = runGit(workdir, ["push", "--no-verify", "-u", "origin", branch]);

  if (push.stdout) process.stderr.write(`[push stdout]\n${push.stdout}\n`);
  if (push.stderr) process.stderr.write(`[push stderr]\n${push.stderr}\n`);

  const host = detectGitHost(originalUrl);
  // Production fallback chain: parse Create-PR URL from push stderr first,
  // then host-aware branch fallback. Returns null for GitHub-no-PR (which
  // doesn't apply here -- BB is our target host).
  const prUrl = parseCreatePrUrl(push.stderr) ?? fallbackBranchUrl(host, originalUrl, branch);

  let terminal_reason = "ok";
  if (push.status !== 0) terminal_reason = "push_failed";
  else if (!prUrl) terminal_reason = "no_pr_url";

  const envelope: Envelope = {
    pr_url: prUrl,
    host,
    branch,
    push_exit: push.status,
    terminal_reason,
  };
  process.stdout.write(JSON.stringify(envelope, null, 2));
  process.stdout.write("\n");
}

main();
