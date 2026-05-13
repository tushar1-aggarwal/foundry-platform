#!/usr/bin/env bun
/**
 * Pod-isolation PR stage. Reproduces the production push-and-parse path that
 * `createWorktreePR` (packages/core/services/worktree/pr.ts) runs for
 * non-GitHub hosts, WITHOUT constructing an AppContext. It re-uses the same
 * pure helpers (`detectGitHost`, `parseCreatePrUrl`, `fallbackBranchUrl`) so
 * the URL the pod records is byte-identical to what the production CP would
 * surface for the same push stderr.
 *
 * Why not just call `createWorktreePR` directly: that function pulls in
 * AppContext, sessions, events, compute-resolver, repo-config, REST-API
 * clients -- none of which exist or are needed inside the isolation pod.
 * The PR-creation logic that actually matters for Bitbucket (push + parse +
 * fallback) is three pure functions. We import those.
 *
 * Inputs (env):
 *   ARK_WORKDIR        path to the git checkout to push from
 *   ARK_BRANCH         branch name (e.g. iso-XXXX)
 *   ARK_AUTHED_URL     https://x-bitbucket-api-token-auth:<token>@host/owner/repo
 *   ARK_ORIGINAL_URL   the pre-auth https://host/owner/repo (used for host detection
 *                      and the recorded pr_url; the authed URL contains the token)
 *   ARK_PR_MODULE      (optional) absolute path to pr.ts -- defaults to
 *                      /app/packages/core/services/worktree/pr.ts (pod layout).
 *                      Mirrors render-prompt.ts's ARK_TEMPLATE_MODULE pattern.
 *
 * Outputs (stdout JSON):
 *   { pr_url, host, branch, push_exit, terminal_reason }
 *
 * Push stdout+stderr are echoed on this process's stderr so the caller's
 * stderr.log captures them for debugging.
 */
import { spawnSync } from "child_process";

const PR_MODULE = process.env.ARK_PR_MODULE ?? "/app/packages/core/services/worktree/pr.ts";
const { detectGitHost, parseCreatePrUrl, fallbackBranchUrl } = (await import(PR_MODULE)) as {
  detectGitHost: (url: string | null | undefined) => "github" | "bitbucket" | "gitlab" | "unknown";
  parseCreatePrUrl: (stderr: string) => string | null;
  fallbackBranchUrl: (
    host: "github" | "bitbucket" | "gitlab" | "unknown",
    remoteUrl: string | null,
    branch: string,
  ) => string | null;
};

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
