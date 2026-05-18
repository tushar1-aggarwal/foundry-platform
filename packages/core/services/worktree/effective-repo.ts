import type { Session } from "../../../types/session.js";

/**
 * Resolve the repo identifier for a session.
 *
 * Sessions can carry a repo in two places:
 *   - `session.repo` (top-level column): set when started against an
 *     existing local checkout (`ark session start --repo ~/Code/foo`).
 *   - `session.config.remoteRepo` (JSON nested): set when started in
 *     hosted/cloud mode with a URL to clone (`session/start { remoteRepo }`).
 *
 * Clone paths everywhere already do `config.remoteRepo ?? session.repo`.
 * Action stages (`create_pr`, `merge`) and worktree-level git ops used to
 * read `session.repo` directly, which made them blind to hosted sessions
 * and produced "Session has no repo" on every hosted dispatch that
 * reached an action stage. Use this helper anywhere you need "the repo
 * identifier for THIS session, regardless of how it was started."
 */
export function effectiveRepo(session: Pick<Session, "repo" | "config">): string | null {
  const remote = (session.config as { remoteRepo?: string } | null | undefined)?.remoteRepo;
  return remote ?? session.repo ?? null;
}
