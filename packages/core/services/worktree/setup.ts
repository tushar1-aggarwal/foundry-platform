/**
 * Worktree setup -- git worktree create/copy/cleanup.
 *
 * Extracted from workspace-service.ts as part of the god-modules split.
 * All functions take app: AppContext as first arg. Pure file move, no
 * behavior change.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { promisify } from "util";
import { execFile } from "child_process";

import type { AppContext } from "../../app.js";
import type { Session, Compute } from "../../../types/index.js";
import * as claude from "../../claude/claude.js";
import { loadRepoConfig } from "../../repo-config.js";
import { logDebug, logError, logWarn } from "../../observability/structured-log.js";
import { safeAsync } from "../../safe.js";

const execFileAsync = promisify(execFile);

/**
 * Return a safe leaf filename for a user-controlled attachment name. Strips
 * any directory components and rejects traversal payloads (`..`, separators,
 * absolute paths, NULs, control chars). Throws on unsafe input rather than
 * silently sanitizing -- callers MUST treat the returned value as authoritative.
 */
export function safeAttachmentName(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("attachment name must be a non-empty string");
  }
  // Reject NUL bytes, control chars, and path separators up front so the
  // attacker never gets a chance to smuggle a traversal past `basename()`.
  if (/[\x00-\x1f]/.test(raw)) {
    throw new Error(`unsafe attachment name (control chars): ${JSON.stringify(raw)}`);
  }
  if (raw.includes("/") || raw.includes("\\")) {
    throw new Error(`unsafe attachment name (path separator): ${JSON.stringify(raw)}`);
  }
  // `basename` is belt-and-suspenders for platform-specific edge cases.
  const cleaned = basename(raw);
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    throw new Error(`unsafe attachment name: ${JSON.stringify(raw)}`);
  }
  if (cleaned !== raw) {
    throw new Error(`unsafe attachment name (normalized mismatch): ${JSON.stringify(raw)}`);
  }
  return cleaned;
}

/** Setup git worktree + Claude trust for the session working directory. */
export async function setupSessionWorktree(
  app: AppContext,
  session: Session,
  compute: Compute | null,
  onLog?: (msg: string) => void,
): Promise<string> {
  const log = onLog ?? (() => {});

  // Resolve the repo source path BEFORE deciding whether to worktree.
  // Previously we bailed out when workdir was "." or null -- that's exactly
  // the self-dogfood case (ark running on its own repo with --repo .), and
  // it's the most dangerous case to skip isolation for: without a worktree
  // the agent edits the live checkout and parallel dispatches collide.
  //
  // Prefer session.repo (stable source-of-truth for the upstream checkout);
  // fall back to workdir only when repo isn't set. This matters on resume:
  // a previous dispatch may have already set session.workdir to a worktree
  // path that cleanupSession then deleted -- using workdir as the source
  // would chase a dangling reference.
  const repoRaw = session.repo;
  const workdirRaw = session.workdir;
  const hasExplicitRepo = repoRaw && repoRaw !== "." && repoRaw.trim() !== "";
  const hasExplicitWorkdir = workdirRaw && workdirRaw !== "." && workdirRaw.trim() !== "";
  const repoSource = hasExplicitRepo ? resolve(repoRaw!) : hasExplicitWorkdir ? resolve(workdirRaw!) : resolve(".");

  let effectiveWorkdir = repoSource;

  // Create git worktree unless the registered Compute doesn't support it
  // or session config explicitly disables it. We worktree when repoSource
  // is a real git repo -- even if it resolves to the current cwd (that is
  // precisely when isolation matters most for the self-dogfood loop).
  //
  // Capability lives on `Compute.capabilities.supportsWorktree` now; we
  // read off the registered Compute keyed by the row's `compute_kind`.
  const computeImpl = compute ? app.getCompute(compute.compute_kind) : app.getCompute("local");
  const supportsWorktree = computeImpl?.capabilities.supportsWorktree === true;
  const wantWorktree = supportsWorktree && session.config?.worktree !== false;
  if (wantWorktree && existsSync(join(repoSource, ".git"))) {
    log("Setting up git worktree...");
    const wt = await setupWorktree(app, repoSource, session.id, session.branch ?? undefined);
    if (wt) {
      effectiveWorkdir = wt;
    } else {
      // Hard fail: silently falling back to the live checkout is dangerous.
      // Surface the error so the operator knows isolation was not achieved.
      throw new Error(
        `Failed to create git worktree for session ${session.id} from ${repoSource}. ` +
          `Refusing to dispatch against the live checkout. Check git worktree state (\`git worktree list\` in ${repoSource}) and retry.`,
      );
    }
  }

  // Copy untracked files + run setup from .ark.yaml worktree config
  if (effectiveWorkdir !== repoSource) {
    const repoConfig = loadRepoConfig(repoSource);
    if (repoConfig.worktree?.copy?.length) {
      log("Copying untracked files to worktree...");
      const copied = await copyWorktreeFiles(repoSource, effectiveWorkdir, repoConfig.worktree.copy);
      if (copied.length > 0) {
        log(`Copied ${copied.length} file(s): ${copied.slice(0, 5).join(", ")}${copied.length > 5 ? "..." : ""}`);
      }
    }
    if (repoConfig.worktree?.setup) {
      log("Running worktree setup script...");
      await runWorktreeSetup(effectiveWorkdir, repoConfig.worktree.setup, log);
    }
  }

  // Trust worktree for Claude
  log("Configuring Claude trust + channel...");
  claude.trustWorktree(repoSource, effectiveWorkdir);

  // Persist an ABSOLUTE workdir on the session row. The previous behaviour
  // left session.workdir as null/"." when the user passed --repo ".", which
  // tripped the transcript parser into resolving an empty path against the
  // parent process cwd and attributing the wrong jsonl file. Resolving here
  // (against the dispatching process cwd, NOT the agent cwd) gives every
  // downstream observer (parser, status poller, web UI) an unambiguous
  // absolute path. Idempotent: skip the write if the row already matches.
  const persisted = resolve(effectiveWorkdir);
  if (session.workdir !== persisted) {
    await app.sessions.update(session.id, { workdir: persisted });
    (session as { workdir: string | null }).workdir = persisted;
  }

  // Materialise attachments onto the worktree. The first time through, any
  // `{ name, content, type }` entry is uploaded to tenant-scoped BlobStore
  // and replaced on the session row with `{ name, locator, type }` -- this
  // keeps subsequent dispatches + replicas reading bytes from durable
  // storage instead of trying to find ephemeral worktree files on the right
  // container. Whichever shape we see, we end with a file at
  // `<workdir>/.ark/attachments/<name>` for the agent to open.
  await materializeAttachments(app, session, effectiveWorkdir);

  return effectiveWorkdir;
}

interface AttachmentEntry {
  name: string;
  type?: string;
  /** Raw base64 / utf-8 content (legacy / pre-upload sessions). */
  content?: string;
  /** Blob locator (post-upload). */
  locator?: string;
}

/**
 * Upload any not-yet-uploaded attachments to BlobStore and materialise every
 * attachment into `<workdir>/.ark/attachments/`. On first call the session
 * row is rewritten to carry locators instead of inline base64; subsequent
 * calls are pure reads.
 */
export async function materializeAttachments(app: AppContext, session: Session, workdir: string): Promise<void> {
  const raw = (session.config as any)?.attachments as AttachmentEntry[] | undefined;
  if (!raw?.length) return;

  const attachDir = join(workdir, ".ark", "attachments");
  mkdirSync(attachDir, { recursive: true });

  // Accumulate the post-upload shape so we can rewrite `config.attachments`
  // atomically at the end. If nothing needed uploading, `changed` stays false
  // and we skip the update.
  const rewritten: AttachmentEntry[] = [];
  let changed = false;

  for (const att of raw) {
    // Path-traversal guard: attacker-controlled `att.name` must not escape
    // `attachDir`. Throws on `..`, separators, absolute paths, or control
    // chars -- we log + skip rather than failing the whole dispatch.
    let safeName: string;
    try {
      safeName = safeAttachmentName(att.name);
    } catch (e: any) {
      logWarn("workspace", `skipping unsafe attachment for session ${session.id}: ${e?.message ?? e}`);
      continue;
    }

    let bytes: Buffer | null = null;
    let locator = att.locator;

    if (locator) {
      // Already uploaded: pull from BlobStore.
      try {
        const got = await app.blobStore.get(locator, session.tenant_id);
        bytes = got.bytes;
      } catch (e: any) {
        logWarn("workspace", `failed to fetch attachment ${safeName} for ${session.id}: ${e?.message ?? e}`);
        continue;
      }
    } else if (att.content) {
      // Not yet uploaded: decode, push to BlobStore, rewrite in place.
      bytes = att.content.startsWith("data:")
        ? Buffer.from(att.content.replace(/^data:[^;]+;base64,/, ""), "base64")
        : Buffer.from(att.content, "utf-8");
      const meta = await app.blobStore.put(
        { tenantId: session.tenant_id, namespace: "attachments", id: session.id, filename: safeName },
        bytes,
        { contentType: att.type },
      );
      locator = meta.locator;
      changed = true;
    } else {
      logWarn("workspace", `attachment ${safeName} has neither content nor locator; skipping`);
      continue;
    }

    writeFileSync(join(attachDir, safeName), bytes);
    rewritten.push({ name: safeName, type: att.type, locator });
  }

  if (changed) {
    // Replace the inline-content entries with locator-only entries so the
    // next dispatch + the web UI both see the same durable reference.
    // Must await: under Temporal semantics the activity can return before
    // the DB write lands, leaving the next dispatch to read the old inline
    // content. Bun resolves synchronously today but that's incidental.
    await app.sessions.mergeConfig(session.id, { attachments: rewritten });
  }
}

async function setupWorktree(
  app: AppContext,
  repoPath: string,
  sessionId: string,
  branch?: string,
): Promise<string | null> {
  const wtPath = join(app.config.dirs.worktrees, sessionId);
  if (existsSync(wtPath)) {
    await applyWorktreeGitIdentity(app, wtPath);
    return wtPath;
  }

  const branchName = branch ?? `ark-${sessionId}`;
  try {
    await execFileAsync("git", ["-C", repoPath, "worktree", "prune"], {
      encoding: "utf-8",
    });
    // Try with new branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", branchName, wtPath], {
        encoding: "utf-8",
      });
      await applyWorktreeGitIdentity(app, wtPath);
      return wtPath;
    } catch (e: any) {
      if (!String(e).includes("already exists")) {
        logError("session", `setupWorktree: new branch '${branchName}' failed: ${e?.message ?? e}`);
      }
    }
    // Try existing branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", wtPath, branchName], {
        encoding: "utf-8",
      });
      await applyWorktreeGitIdentity(app, wtPath);
      return wtPath;
    } catch (e: any) {
      if (!String(e).includes("already checked out") && !String(e).includes("already exists")) {
        logError("session", `setupWorktree: existing branch '${branchName}' failed: ${e?.message ?? e}`);
      }
    }
    // Unique branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", `ark-${sessionId}`, wtPath], {
        encoding: "utf-8",
      });
      await applyWorktreeGitIdentity(app, wtPath);
      return wtPath;
    } catch (e: any) {
      logError("session", `setupWorktree: all strategies failed for ${sessionId}: ${e?.message ?? e}`);
    }
  } catch (e: any) {
    logError("session", `setupWorktree: worktree prune failed: ${e?.message ?? e}`);
  }
  return null;
}

/**
 * The literal placeholder identity. Treated as "no override" in the resolution
 * chain because server-side hooks (e.g. Bitbucket's BB Violator) reject the
 * `agent@ark.local` email outright and rewrite the commit to a generic bot
 * author. If a user actually wants these literal values they can still get
 * them by not having any other identity configured anywhere.
 */
const ARK_PLACEHOLDER_NAME = "Ark Agent";
const ARK_PLACEHOLDER_EMAIL = "agent@ark.local";

/**
 * Read a `git config --get <key>` value from a workdir. Returns trimmed value
 * or undefined when unset / command fails. Cascades through the worktree's
 * own scope -> the repo-local scope (the parent clone's `.git/config`) ->
 * the user's `~/.gitconfig` (global) -> `/etc/gitconfig` (system).
 */
async function readGitConfigValue(cwd: string, key: string, scope?: "global"): Promise<string | undefined> {
  try {
    const args = scope === "global" ? ["config", "--global", "--get", key] : ["-C", cwd, "config", "--get", key];
    const { stdout } = await execFileAsync("git", args, { encoding: "utf-8", timeout: 5_000 });
    const v = stdout.trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the agent's commit identity for a worktree. Resolution chain (first
 * non-empty wins):
 *
 *   1. Explicit override -- `ARK_GIT_AUTHOR_NAME` / `ARK_GIT_AUTHOR_EMAIL` env
 *      var, or `git.authorName` / `git.authorEmail` in the YAML config. The
 *      literal placeholder ("Ark Agent" / "agent@ark.local") is treated as
 *      "no override" so it never out-prioritises a real identity below.
 *   2. Effective git config inside the worktree -- `git config --get user.name`
 *      cascades through worktree -> repo-local -> global -> system. This is
 *      where the OS user's `~/.gitconfig` is picked up automatically in local-
 *      compute mode (laptop dev), AND where any prior `applyWorktreeGitIdentity`
 *      write on this worktree would show up. We skip values that match the
 *      placeholder so a previous default-write doesn't pin the placeholder
 *      forever even after the user adds an env override.
 *   3. Global git config -- a belt-and-braces second probe for the user's
 *      identity even when steps 1 and 2 only see the placeholder. Useful when
 *      ark already wrote the placeholder once and the worktree's repo-local
 *      scope is now "Ark Agent"; without this probe we'd never escape.
 *   4. Ark's placeholder default -- only when nothing else exists. This is
 *      the BB-Violator-incompatible fallback we want to avoid in practice.
 */
async function resolveAuthorIdentity(app: AppContext, wtPath: string): Promise<{ name: string; email: string }> {
  const explicitName = app.config.git?.authorName;
  const explicitEmail = app.config.git?.authorEmail;
  const isPlaceholderName = !explicitName || explicitName === ARK_PLACEHOLDER_NAME;
  const isPlaceholderEmail = !explicitEmail || explicitEmail === ARK_PLACEHOLDER_EMAIL;

  let name = !isPlaceholderName ? explicitName! : ARK_PLACEHOLDER_NAME;
  let email = !isPlaceholderEmail ? explicitEmail! : ARK_PLACEHOLDER_EMAIL;

  if (isPlaceholderName) {
    const effective = await readGitConfigValue(wtPath, "user.name");
    if (effective && effective !== ARK_PLACEHOLDER_NAME) {
      name = effective;
    } else {
      const global = await readGitConfigValue(wtPath, "user.name", "global");
      if (global && global !== ARK_PLACEHOLDER_NAME) name = global;
    }
  }
  if (isPlaceholderEmail) {
    const effective = await readGitConfigValue(wtPath, "user.email");
    if (effective && effective !== ARK_PLACEHOLDER_EMAIL) {
      email = effective;
    } else {
      const global = await readGitConfigValue(wtPath, "user.email", "global");
      if (global && global !== ARK_PLACEHOLDER_EMAIL) email = global;
    }
  }

  return { name, email };
}

/**
 * Pin `user.name` / `user.email` on the worktree's local git config so the
 * agent's commits inherit a stable identity. Prefers (in order): explicit
 * env/YAML override, the OS user's effective git config, the user's global
 * `~/.gitconfig`, and finally ark's placeholder. The placeholder is rejected
 * by server-side hooks (e.g. Bitbucket BB Violator) so the cascade gives the
 * laptop dev experience a real identity without any operator action.
 *
 * Non-fatal: we log and continue if the underlying `git config` writes fail.
 */
export async function applyWorktreeGitIdentity(app: AppContext, wtPath: string): Promise<void> {
  const { name, email } = await resolveAuthorIdentity(app, wtPath);
  try {
    await execFileAsync("git", ["-C", wtPath, "config", "user.name", name], { encoding: "utf-8" });
    await execFileAsync("git", ["-C", wtPath, "config", "user.email", email], { encoding: "utf-8" });
  } catch (e: any) {
    logWarn("session", `applyWorktreeGitIdentity: failed to set author on ${wtPath}: ${e?.message ?? e}`);
  }
}

/**
 * Copy untracked files matching glob patterns from source repo into worktree.
 * Only copies files that exist in the source but NOT in the worktree (avoids
 * overwriting tracked files that git already placed).
 */
export async function copyWorktreeFiles(
  sourceRepo: string,
  worktreeDir: string,
  patterns: string[],
): Promise<string[]> {
  const copied: string[] = [];
  for (const pattern of patterns) {
    if (pattern.includes("..")) continue;

    const glob = new Bun.Glob(pattern);
    for await (const relPath of glob.scan({ cwd: sourceRepo, dot: true })) {
      const target = join(worktreeDir, relPath);
      if (existsSync(target)) continue;

      const source = join(sourceRepo, relPath);
      mkdirSync(dirname(target), { recursive: true });
      const content = readFileSync(source);
      writeFileSync(target, content);
      copied.push(relPath);
    }
  }
  return copied;
}

/**
 * Run a setup script in the worktree directory after file copy.
 * Times out after 60 seconds. Errors are logged but do not fail dispatch.
 */
export async function runWorktreeSetup(
  worktreeDir: string,
  command: string,
  onLog?: (msg: string) => void,
): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
      cwd: worktreeDir,
      timeout: 60_000,
      encoding: "utf-8",
    });
    if (stdout?.trim()) onLog?.(`setup stdout: ${stdout.trim().slice(0, 500)}`);
    if (stderr?.trim()) onLog?.(`setup stderr: ${stderr.trim().slice(0, 500)}`);
  } catch (e: any) {
    onLog?.(`Worktree setup script failed (non-fatal): ${e?.message ?? e}`);
  }
}

/**
 * Remove the worktree directory for a session, if it exists.
 * Provider-independent -- called from stop() and deleteSessionAsync() so
 * worktrees are always cleaned up regardless of compute provider availability.
 */
export async function removeSessionWorktree(app: AppContext, session: Session): Promise<void> {
  const wtPath = join(app.config.dirs.worktrees, session.id);
  if (!existsSync(wtPath)) return;

  // Try git worktree remove first (cleans up .git/worktrees metadata)
  const repo = session.repo ?? session.workdir;
  if (repo) {
    try {
      await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", wtPath], {
        encoding: "utf-8",
      });
      return;
    } catch {
      logDebug("session", "fall through to rmSync");
    }
  }

  // Fallback: direct removal (no repo context or git worktree remove failed)
  await safeAsync(`removeSessionWorktree: rmSync ${session.id}`, async () => {
    rmSync(wtPath, { recursive: true, force: true });
  });
}

/** Find orphaned worktrees -- worktree dirs with no matching session. */
export async function findOrphanedWorktrees(app: AppContext): Promise<string[]> {
  const wtDir = app.config.dirs.worktrees;
  if (!existsSync(wtDir)) return [];

  const sessionIds = new Set((await app.sessions.list({ limit: 1000 })).map((s) => s.id));
  const orphans: string[] = [];

  try {
    for (const entry of readdirSync(wtDir)) {
      if (!sessionIds.has(entry)) {
        orphans.push(entry);
      }
    }
  } catch {
    logDebug("session", "worktrees dir may not exist -- no orphans to report");
  }

  return orphans;
}

/** Remove orphaned worktrees. Returns count of removed. */
export async function cleanupWorktrees(app: AppContext): Promise<{ removed: number; errors: string[] }> {
  const orphans = await findOrphanedWorktrees(app);
  let removed = 0;
  const errors: string[] = [];

  for (const id of orphans) {
    const wtPath = join(app.config.dirs.worktrees, id);
    try {
      // Try git worktree remove first
      await execFileAsync("git", ["worktree", "remove", wtPath, "--force"], {
        encoding: "utf-8",
      });
      removed++;
    } catch {
      // Fallback: just remove the directory
      try {
        rmSync(wtPath, { recursive: true, force: true });
        removed++;
      } catch (e: any) {
        errors.push(`${id}: ${e.message}`);
      }
    }
  }

  return { removed, errors };
}
