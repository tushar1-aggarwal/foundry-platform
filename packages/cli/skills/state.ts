/**
 * Sync-state sidecar I/O for `ark skills sync`.
 *
 * RFC §7 spec. One JSON file per (harness, skill_name) pair under
 * `<repo>/.ark/skills-state/`. The payload binds a local on-disk skill
 * to its server-side identity (`skill_id`) and the canonical hash at
 * the last successful sync (`current_hash`).
 *
 *   <repo>/.ark/skills-state/
 *     claude-code-review.json   { "skill_id": "skl-abc...", "current_hash": "sha256-..." }
 *     cursor-deploy.json        { "skill_id": "skl-xyz...", "current_hash": "sha256-..." }
 *
 * `sync_status` reads `current_hash` to populate `local_hash` in the
 * server request; `get_with_ancestor` reads `skill_id` to populate the
 * `ancestor_hash` argument. Missing sidecar (fresh clone, machine wipe)
 * is a normal state and degrades sync to the unknown-status path per
 * RFC §7 "When the sidecar is missing".
 *
 * Gitignore: the repo's root `.gitignore` ships with `.ark/skills-state/`
 * excluded by default. Sidecars are per-user-per-machine state binding a
 * local skill dir to its server-side `current_hash`; sharing across users
 * via git would cause false-conflict reports on the next sync (each
 * user's local body wouldn't match the committed sidecar's hash).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

// Module-level flag: warn at most once per process when the consuming
// repo's .gitignore doesn't exclude the skills-state directory. Avoids
// spamming the user across every put/sync within the same CLI run.
let _gitignoreWarningEmitted = false;

export interface SidecarPayload {
  skill_id: string;
  current_hash: string;
}

export interface SidecarRecord {
  harness: string;
  skill_name: string;
  payload: SidecarPayload;
}

export class SidecarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidecarError";
  }
}

/**
 * `<harness>` and `<skill_name>` flow into a filename, so we require
 * filesystem-safe characters. Two distinct regexes:
 *
 *   - Harness ids MUST NOT contain hyphens. The sidecar filename is
 *     `<harness>-<skill>.json` and `listSidecars` splits on the FIRST
 *     hyphen. A future harness named `claude-code` would otherwise
 *     write `claude-code-myskill.json`, which would silently parse as
 *     `{harness: "claude", skillName: "code-myskill"}` and route
 *     `sync_status` to the wrong server skill. Asserting at write time
 *     makes the convention machine-checkable (claude / cursor / codex
 *     all pass; a hypothetical `claude-code` fails here, not silently
 *     later).
 *
 *   - Skill names DO allow hyphens (kebab-case is the dominant
 *     convention: code-review, skill-name-with-words).
 *
 * Both regexes reject `.` `/` ` ` so a hostile or accidental name can
 * neither escape the state dir nor collide with the `.json` suffix.
 */
const SAFE_HARNESS_RE = /^[a-zA-Z0-9_]+$/;
const SAFE_SKILL_RE = /^[a-zA-Z0-9_-]+$/;

function assertSafeKey(label: string, value: string, re: RegExp): void {
  if (!re.test(value)) {
    throw new SidecarError(
      `${label} '${value}' contains characters outside ${re.source}; this would either break the sidecar filename or escape the state directory`,
    );
  }
}

/** Absolute path of the sidecar directory for a given repo. */
export function sidecarDir(repoRoot: string): string {
  return join(repoRoot, ".ark", "skills-state");
}

/** Absolute path of the sidecar file for one (harness, skill_name). */
export function sidecarPath(opts: { repoRoot: string; harness: string; skillName: string }): string {
  assertSafeKey("harness", opts.harness, SAFE_HARNESS_RE);
  assertSafeKey("skill name", opts.skillName, SAFE_SKILL_RE);
  return join(sidecarDir(opts.repoRoot), `${opts.harness}-${opts.skillName}.json`);
}

/** Read one sidecar. Returns `null` when the file does not exist. */
export function readSidecar(opts: { repoRoot: string; harness: string; skillName: string }): SidecarPayload | null {
  const path = sidecarPath(opts);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SidecarError(`malformed JSON in sidecar ${path}: ${msg}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SidecarError(`sidecar ${path} is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.skill_id !== "string" || typeof obj.current_hash !== "string") {
    throw new SidecarError(`sidecar ${path} missing required fields { skill_id, current_hash }`);
  }
  return { skill_id: obj.skill_id, current_hash: obj.current_hash };
}

/** Write one sidecar, creating the directory if needed. */
export function writeSidecar(opts: {
  repoRoot: string;
  harness: string;
  skillName: string;
  payload: SidecarPayload;
}): void {
  const path = sidecarPath(opts);
  mkdirSync(sidecarDir(opts.repoRoot), { recursive: true });
  writeFileSync(path, JSON.stringify(opts.payload, null, 2) + "\n", "utf8");
  warnIfSidecarNotGitignored(opts.repoRoot);
}

/**
 * Best-effort check: when the consuming repo has a `.gitignore` but
 * doesn't exclude `.ark/skills-state/`, warn once per process. Committing
 * sidecars across users causes false-conflict reports on the next sync
 * (each user's local body wouldn't match the committed `current_hash`).
 *
 * Silently does nothing when:
 *   - the consuming repo has no `.gitignore` (not a git repo, fresh init);
 *     letting the missing-gitignore case slide here matches user
 *     expectations — `ark skills` shouldn't gate on git infra.
 *   - the gitignore already excludes either `.ark/` (broad exclusion) or
 *     `.ark/skills-state/` (specific), including with a trailing wildcard.
 *   - we've already warned once this process (module-level flag).
 *
 * Exported for testability; production callers go through `writeSidecar`.
 */
export function warnIfSidecarNotGitignored(repoRoot: string): void {
  if (_gitignoreWarningEmitted) return;
  const gitignorePath = join(repoRoot, ".gitignore");
  if (!existsSync(gitignorePath)) return;
  let contents: string;
  try {
    contents = readFileSync(gitignorePath, "utf8");
  } catch {
    return; // unreadable .gitignore is not our problem
  }
  // Match common forms: `.ark/`, `.ark`, `.ark/skills-state/`,
  // `.ark/skills-state`, `.ark/*`. Negated patterns (`!.ark/...`)
  // technically un-exclude but realistic users don't do that here.
  const lines = contents
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  const excluded = lines.some((line) => {
    if (line.startsWith("!")) return false;
    return (
      line === ".ark" ||
      line === ".ark/" ||
      line === ".ark/*" ||
      line === ".ark/**" ||
      line === ".ark/skills-state" ||
      line === ".ark/skills-state/" ||
      line === ".ark/skills-state/*" ||
      line === ".ark/skills-state/**"
    );
  });
  if (excluded) return;
  _gitignoreWarningEmitted = true;
  // Console-warn so the message reaches both TTY and piped output. We
  // don't use chalk here to keep state.ts dependency-free; the CLI
  // commands are free to wrap subsequent output in chalk.
  console.warn(
    `warning: .ark/skills-state/ is not excluded by ${gitignorePath}.\n` +
      `         Sidecars are per-user-per-machine; committing them will cause\n` +
      `         false-conflict reports on the next sync. Add this line:\n` +
      `             .ark/skills-state/`,
  );
}

/** Reset the once-per-process warning flag. Test-only. */
export function _resetGitignoreWarningForTests(): void {
  _gitignoreWarningEmitted = false;
}

/** Delete one sidecar; no-op when absent (idempotent). Returns whether a file existed. */
export function deleteSidecar(opts: { repoRoot: string; harness: string; skillName: string }): boolean {
  const path = sidecarPath(opts);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/**
 * Per-repo "last successful sync" timestamp. Used by `ark skills sync`'s
 * discovery banner: at the start of the run we ask the server for
 * `skillhub/published_after(last_sync_at)` and surface the count as
 * "N new skills available since last sync." At the end of the run, on
 * success, we bump the timestamp to "now."
 *
 * Lives at `<repo>/.ark/skills-state/last-sync.json`. Absence means
 * "never synced from this repo" - banner falls back to epoch so the
 * first run shows every visible skill.
 */
export function lastSyncPath(repoRoot: string): string {
  return join(sidecarDir(repoRoot), "last-sync.json");
}

export function readLastSync(repoRoot: string): string | null {
  const path = lastSyncPath(repoRoot);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const ts = (parsed as Record<string, unknown>).last_sync_at;
  return typeof ts === "string" ? ts : null;
}

export function writeLastSync(repoRoot: string, isoTimestamp: string): void {
  const path = lastSyncPath(repoRoot);
  mkdirSync(sidecarDir(repoRoot), { recursive: true });
  writeFileSync(path, JSON.stringify({ last_sync_at: isoTimestamp }, null, 2) + "\n", "utf8");
}

/**
 * Enumerate every sidecar under `<repo>/.ark/skills-state/`. Used by
 * `sync_status` to assemble `local_versions[]`. Optionally filter by
 * harness (e.g. when sync is scoped to claude only).
 *
 * Malformed sidecars are SKIPPED with no error - a corrupt single file
 * shouldn't break a 50-skill sync. (The handler / CLI surfaces a
 * warning aggregated across the list.)
 */
export function listSidecars(opts: { repoRoot: string; harness?: string }): SidecarRecord[] {
  const dir = sidecarDir(opts.repoRoot);
  if (!existsSync(dir)) return [];
  const out: SidecarRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const stem = entry.slice(0, -".json".length);
    // Split on the FIRST hyphen separator: harness names are
    // single-token (claude/cursor/codex) by convention, while skill
    // names commonly contain hyphens (kebab-case).
    const sepIdx = stem.indexOf("-");
    if (sepIdx === -1) continue;
    const harness = stem.slice(0, sepIdx);
    const skillName = stem.slice(sepIdx + 1);
    if (!harness || !skillName) continue;
    if (opts.harness && harness !== opts.harness) continue;
    let payload: SidecarPayload | null;
    try {
      payload = readSidecar({ repoRoot: opts.repoRoot, harness, skillName });
    } catch {
      continue; // skip corrupt sidecar
    }
    if (payload) out.push({ harness, skill_name: skillName, payload });
  }
  return out;
}
