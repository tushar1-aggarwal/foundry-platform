/**
 * Sync-status classification (RFC §7).
 *
 * Pure function that maps a (server status, local hashes) pair into a
 * single CLI verdict the orchestrator can switch on. The server's
 * enum is intentionally minimal (it doesn't know the user's working
 * tree); the CLI computes the user-visible classification by combining
 * the server's verdict with two pair-equality bits: local-vs-sidecar
 * and server-vs-sidecar.
 *
 * Both bits matter because the server's `server-changed` status is a
 * NAME ARTIFACT — it really means "your local_hash differs from my
 * current_hash," not "I (server) moved." The server can detect that
 * `local_hash !== server.current_hash` but it can NOT independently
 * know whether ITS OWN current_hash has moved since the caller's last
 * sync — that information lives in the sidecar, which is client-side
 * only. So `server-changed + local!=sidecar` is ambiguous between
 * "only local moved" (local-ahead) and "both moved" (conflict) until
 * we also check `server == sidecar`.
 *
 * Verdict table (RFC §7):
 *
 *   Server status   | local==sidecar? | server==sidecar? | CLI verdict
 *   ----------------|-----------------|------------------|--------------------
 *   up-to-date      | yes             | yes              | up-to-date
 *   up-to-date      | no              | yes              | local-ahead
 *   server-changed  | yes             | no               | fast-forward-pull
 *   server-changed  | no              | yes              | local-ahead       (only local moved)
 *   server-changed  | no              | no               | conflict          (both moved)
 *   unknown         | (no sidecar)    | (n/a)            | unknown
 *   not-found       | (orphan)        | (n/a)            | orphan
 *
 * `unknown` requires a follow-up `get_with_ancestor` + ancestor-vs-local
 * comparison before the orchestrator can pick fast-forward-pull vs
 * conflict (per the RFC's "Sidecar missing" subsection). This module
 * only classifies the initial `sync_status` response; the orchestrator
 * handles the follow-up refinement.
 */

import type { SkillhubServerSyncStatus } from "../../types/index.js";

export type CliSyncVerdict =
  | "up-to-date" // skill is in sync; no further work
  | "local-ahead" // local edits exist; user should run `ark skills put`
  | "fast-forward-pull" // server has newer content; write it locally
  | "conflict" // both sides changed; needs merge or --force
  | "unknown" // no sidecar; needs get_with_ancestor + local-vs-ancestor compare
  | "orphan"; // sidecar references a skill the server doesn't have

export interface ClassifyArgs {
  /** What the server returned for this skill. */
  serverStatus: SkillhubServerSyncStatus;
  /** True when the caller sent a `local_hash` in the request (i.e. sidecar exists). */
  hasSidecar: boolean;
  /** True iff `local_hash === sidecar.current_hash`. Meaningful only when hasSidecar. */
  localHashMatchesSidecar: boolean;
  /**
   * True iff `server.current_hash === sidecar.current_hash`. The
   * orchestrator computes this by comparing the `server_hash` returned
   * in the sync_status entry against the sidecar payload it sent.
   * Meaningful only when hasSidecar AND the server returned a non-null
   * server_hash (i.e. `up-to-date` or `server-changed`).
   */
  serverHashMatchesSidecar: boolean;
}

export function classifySyncStatus(args: ClassifyArgs): CliSyncVerdict {
  const { serverStatus, hasSidecar, localHashMatchesSidecar, serverHashMatchesSidecar } = args;

  if (serverStatus === "not-found") return "orphan";

  if (!hasSidecar) {
    // The caller omitted local_hash, so the server must have returned
    // 'unknown'. (Any other status with no sidecar would be a
    // server-side bug; we fall through to 'unknown' rather than throw
    // - the orchestrator's follow-up via get_with_ancestor will
    // resolve regardless.)
    return "unknown";
  }

  if (serverStatus === "up-to-date") {
    // Server == local (it computed that). local==sidecar tells us
    // whether the user has edited locally past the synced point.
    return localHashMatchesSidecar ? "up-to-date" : "local-ahead";
  }

  if (serverStatus === "server-changed") {
    // local != server. Three sub-cases based on whether server moved
    // since the caller's last sync (server vs sidecar) AND whether
    // local moved since the last sync (local vs sidecar).
    if (localHashMatchesSidecar) {
      // local stayed at sidecar's last-synced; server moved -> pull.
      return "fast-forward-pull";
    }
    if (serverHashMatchesSidecar) {
      // server stayed at sidecar's last-synced; only local moved
      // -> the user has unpublished edits. The earlier-iteration
      // verdict ("conflict") was wrong: there is nothing to merge
      // against because the server hasn't moved.
      return "local-ahead";
    }
    // Both moved past the sidecar's last-synced point: real 3-way
    // divergence. Needs merge.
    return "conflict";
  }

  // serverStatus === "unknown" but we DID have a sidecar (so server's
  // 'unknown' is unusual - it means our sidecar's skill_id matched but
  // the server returned 'unknown' anyway). Treat as unknown for the
  // orchestrator's follow-up.
  return "unknown";
}
