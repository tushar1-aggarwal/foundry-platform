/**
 * Shared E2E test setup -- full isolation from production state.
 *
 * Browser e2e drives an out-of-process `ark web` subprocess (spawned by
 * web-server.ts). That subprocess is the Bun process: it owns its own
 * AppContext, SQLite DB, and HTTP server. All test state is seeded over
 * HTTP via `ws.rpc(...)` against it -- nothing here runs in-process.
 *
 * So this fixture must stay Node-runnable (Playwright always runs the test
 * runner under Node). It only provides:
 * - An isolated temp arkDir passed to the subprocess as ARK_TEST_DIR
 *   (the subprocess resolves config.dirs.ark from it -- see
 *   packages/core/config/env-source.ts -- so its DB lives at
 *   `${arkDir}/ark.db`, which a couple specs poke directly via sqlite3).
 * - An isolated temp workdir with a git repo (specs pass it as `repo`).
 * - Teardown that rm -rf's both temp dirs and prunes leaked worktrees.
 *
 * Importing AppContext here would pull `bun:sqlite` / `Bun.serve` into the
 * Node runner and hang the whole suite -- do not reintroduce it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

export interface E2EEnv {
  /** Isolated temp arkDir handed to the `ark web` subprocess via ARK_TEST_DIR */
  arkDir: string;
  /** Isolated temp workdir -- use instead of process.cwd() */
  workdir: string;
  /** Track tmux sessions for cleanup */
  tmuxSessions: string[];
  /** Track session IDs for cleanup */
  sessionIds: string[];
  /** Tear everything down */
  teardown: () => Promise<void>;
}

/** Kill any tmux session matching the given name (no-op if absent). */
function killTmuxSession(name: string): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", name], { stdio: "pipe", timeout: 5_000 });
  } catch {
    /* session already gone or tmux server down */
  }
}

/**
 * Boot a fully isolated E2E environment.
 * Call teardown() in afterAll.
 */
export async function setupE2E(): Promise<E2EEnv> {
  // 1. Isolated arkDir for the subprocess. Empty dir -- the subprocess
  //    creates ark.db on boot.
  const arkDir = mkdtempSync(join(tmpdir(), "ark-e2e-home-"));

  // 2. Isolated workdir with a git repo (some tests need .git)
  const workdir = mkdtempSync(join(tmpdir(), "ark-e2e-repo-"));
  try {
    execFileSync("git", ["init", workdir], { stdio: "pipe" });
    writeFileSync(join(workdir, ".gitkeep"), "");
    execFileSync("git", ["-C", workdir, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", workdir, "commit", "-m", "init", "--allow-empty"], { stdio: "pipe" });
  } catch {
    // git init failed -- workdir still usable for non-git tests
  }

  const env: E2EEnv = {
    arkDir,
    workdir,
    tmuxSessions: [],
    sessionIds: [],
    teardown: async () => {
      for (const name of env.tmuxSessions) {
        killTmuxSession(name);
      }

      for (const dir of [workdir, arkDir]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* cleanup */
        }
      }

      // Prune any leaked worktrees pointing to our temp dir. Cap wall-clock
      // so a rare flock contention can't push us past the afterAll ceiling.
      try {
        execFileSync("git", ["worktree", "prune"], { stdio: "pipe", cwd: process.cwd(), timeout: 5_000 });
      } catch {
        /* cleanup */
      }
    },
  };

  return env;
}
