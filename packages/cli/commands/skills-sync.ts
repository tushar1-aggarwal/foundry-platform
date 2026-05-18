/**
 * `ark skills sync` - bidirectional reconciliation orchestrator (RFC §11 step 21).
 *
 * Composes everything from C11-C13:
 *   - sidecar enumeration            (skills/state.ts)
 *   - adapter parse + render          (packages/skill-adapters)
 *   - canonical bundle hashing        (packages/core/skills/hash.ts)
 *   - shared normalizer              (packages/core/skills/normalizer.ts)
 *   - sync_status + get_with_ancestor RPCs (protocol/clients/skillhub.ts)
 *   - classification                  (skills/classify.ts)
 *   - credential discovery            (skills/auth.ts)
 *   - client-side 3-way merge         (skills/merge.ts)
 *   - skillhub/put with merge_input audit blob
 *   - sidecar update on success
 *
 * Flags:
 *   --harness <id>   restrict sync to one harness (default: every harness with sidecars)
 *   --dry-run        compute classifications + (for unknown) fetch ancestor; never write
 *                    to disk, never call the LLM, never call skillhub/put
 *   --no-merge       in the conflict path, do NOT call the LLM; instead surface the
 *                    affected skills as requires-manual and leave local unchanged
 *
 * Prompts are TTY-only. Non-TTY callers must pass --no-merge or sync exits with
 * a clear error on the first conflict.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";
import { existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { hashCanonicalBundle } from "../../core/skills/hash.js";
import { normalize } from "../../core/skills/normalizer.js";
import type { HarnessId } from "../../core/skills/normalizer.js";
import { registry as adapterRegistry } from "../../skill-adapters/index.js";
import type { HarnessAdapter } from "../../skill-adapters/index.js";
import type { SkillhubGetWithAncestorResult, SkillhubPutParams, SkillhubSyncStatusEntry } from "../../types/index.js";
import { getArkClient } from "../app-client.js";
import { loadSkillsConfig } from "../skills/config.js";
import { classifySyncStatus, type CliSyncVerdict } from "../skills/classify.js";
import { discoverAnthropicCredentials, NoCredentialsError } from "../skills/auth.js";
import {
  buildClaudeAgentMergeFn,
  clientSideMerge,
  DEFAULT_LLM_MODEL,
  type CanonicalBundle,
  type LlmMergeFn,
  type ProposedMerge,
} from "../skills/merge.js";
import { listSidecars, readLastSync, type SidecarRecord, writeLastSync, writeSidecar } from "../skills/state.js";
import { planSweep, writeBundleToDisk } from "../skills/write.js";

// Re-exported so the existing `skills-sync-helpers.test.ts` import
// path doesn't break - planSweep moved to write.ts in this commit.
export { planSweep };

interface SyncOpts {
  harness?: string;
  dryRun?: boolean;
  /**
   * Commander's automatic-negation behaviour for `--no-merge` populates
   * `opts.merge` with a default of `true` and sets it to `false` when
   * the flag is passed. We check `opts.merge === false` (not
   * `opts.noMerge`) to detect the flag — using `opts.noMerge` would
   * silently always be `undefined` and the LLM-discovery dance would
   * fire even when the user explicitly opted out.
   */
  merge?: boolean;
  /** Skip the interactive "run LLM merge?" prompt and accept on every conflict. */
  yes?: boolean;
  /**
   * One-shot write-dir override. Beats `config.write_to[<harness>]` and
   * `adapter.defaultWritePath(repoRoot)`. Resolved relative to
   * `process.cwd()` (user intuition: `--dir ./local-skills` writes to
   * `<cwd>/local-skills/<skill-name>/`).
   */
  dir?: string;
}

interface PerSkillContext {
  sidecar: SidecarRecord;
  adapter: HarnessAdapter;
  localDir: string;
  localBundle: CanonicalBundle;
  localHash: string;
}

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

function adapterFor(harness: string): HarnessAdapter | undefined {
  return adapterRegistry.find((a) => a.harnessId === harness);
}

/**
 * Find the on-disk directory where this skill lives. Probes the
 * adapter's readPaths plus any custom `read_paths` from config.
 * Returns null if no matching `<readPath>/<skillName>` directory
 * exists (skill known to the server but never materialized locally).
 */
function locateLocalSkillDir(opts: { repoRoot: string; adapter: HarnessAdapter; skillName: string }): string | null {
  const candidates = opts.adapter.readPaths(opts.repoRoot);
  for (const base of candidates) {
    const candidate = join(base, opts.skillName);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Read the local skill, normalize, and hash. Returns null when the
 * skill directory doesn't exist on disk - the orchestrator treats
 * this as "sidecar exists but local files are gone," asks the user
 * whether to re-materialize from the server.
 */
function readLocalBundleAndHash(adapter: HarnessAdapter, localDir: string): { bundle: CanonicalBundle; hash: string } {
  const localSkill = adapter.parse(localDir);
  const canonical = normalize(
    { body: localSkill.body, supporting_files: localSkill.supportingFiles },
    adapter.harnessId as HarnessId,
  );
  return { bundle: canonical, hash: hashCanonicalBundle(canonical) };
}

/**
 * Resolve the target directory for sync writes, in precedence order:
 *   1. explicit `--dir` flag (one-shot override; resolved relative to CWD)
 *   2. `config.write_to[<harness>]` from `<repo>/.ark/config.yaml`
 *      (resolved relative to repo root)
 *   3. `adapter.defaultWritePath(repoRoot)`
 *
 * Mirrors `skills-install-search.ts:resolveWriteDir` so the two commands
 * agree on where files land.
 */
function resolveWriteDir(opts: { repoRoot: string; adapter: HarnessAdapter; dir?: string }): string {
  if (opts.dir) {
    return resolve(process.cwd(), opts.dir);
  }
  const config = loadSkillsConfig(opts.repoRoot);
  const override = config?.write_to?.[opts.adapter.harnessId];
  if (override) {
    // Config paths are relative to repo root.
    return join(opts.repoRoot, override);
  }
  return opts.adapter.defaultWritePath(opts.repoRoot);
}

/**
 * Pure helper: which paths in a proposed_merge per_file_results were
 * left unresolved? When non-empty, the sync orchestrator refuses to
 * push (would silently delete files from the server-side bundle).
 * Exported for unit-testing the guard.
 */
export function unresolvedPaths(perFileResults: Array<{ path: string; merged: boolean }>): string[] {
  return perFileResults.filter((r) => !r.merged).map((r) => r.path);
}

async function promptYesNo(question: string): Promise<boolean> {
  // Non-TTY callers can't be prompted - the orchestrator's caller is
  // responsible for not reaching this in non-interactive contexts.
  if (!process.stdout.isTTY) {
    throw new Error("interactive prompt not available (stdout is not a TTY)");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return ans.trim().toLowerCase() === "y" || ans.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

// ── per-verdict handlers ──────────────────────────────────────────────────

async function handleFastForwardPull(opts: {
  ctx: PerSkillContext;
  ancestor: SkillhubGetWithAncestorResult;
  repoRoot: string;
  dryRun: boolean;
  dir?: string;
}): Promise<void> {
  const { ctx, ancestor, repoRoot, dryRun, dir } = opts;
  console.log(chalk.cyan(`fast-forward-pull: ${ctx.adapter.harnessId}/${ctx.sidecar.skill_name}`));
  if (dryRun) {
    console.log(chalk.dim("  (dry-run: would write server content + update sidecar)"));
    return;
  }
  const targetDir = resolveWriteDir({ repoRoot, adapter: ctx.adapter, dir });
  writeBundleToDisk({
    adapter: ctx.adapter,
    targetDir,
    skillName: ctx.sidecar.skill_name,
    name: ancestor.server_name,
    description: ancestor.server_description,
    category: ancestor.server_category,
    tags: ancestor.server_tags,
    body: ancestor.server_body,
    supportingFiles: ancestor.server_supporting_files,
    harnessHints: ancestor.server_harness_hints,
  });
  writeSidecar({
    repoRoot,
    harness: ctx.adapter.harnessId,
    skillName: ctx.sidecar.skill_name,
    payload: { skill_id: ctx.sidecar.payload.skill_id, current_hash: ancestor.server_hash },
  });
  console.log(chalk.green(`  wrote ${targetDir}/${ctx.sidecar.skill_name}/ + updated sidecar`));
}

async function handleConflict(opts: {
  ctx: PerSkillContext;
  ancestor: SkillhubGetWithAncestorResult;
  repoRoot: string;
  llm: LlmMergeFn | null; // null when --no-merge
  dryRun: boolean;
  /** Auto-accept the LLM merge prompt (CI / non-TTY callers). */
  autoYes: boolean;
  /** One-shot write-dir override (from `--dir`). */
  dir?: string;
}): Promise<void> {
  const { ctx, ancestor, repoRoot, llm, dryRun, autoYes, dir } = opts;
  const label = `${ctx.adapter.harnessId}/${ctx.sidecar.skill_name}`;
  console.log(chalk.yellow(`conflict: ${label}`));

  if (llm === null) {
    console.log(chalk.dim("  --no-merge: skipped LLM merge. Resolve manually and run `ark skills put`."));
    return;
  }
  if (dryRun) {
    console.log(chalk.dim("  (dry-run: would prompt for LLM merge)"));
    return;
  }

  let wantsMerge: boolean;
  if (autoYes) {
    console.log(chalk.dim("  --yes: auto-accepting LLM merge"));
    wantsMerge = true;
  } else {
    wantsMerge = await promptYesNo(`  run LLM merge for ${label}?`);
  }
  if (!wantsMerge) {
    console.log(chalk.dim("  skipped by user"));
    return;
  }

  const theirsBundle: CanonicalBundle = {
    body: ancestor.server_body,
    supporting_files: ancestor.server_supporting_files,
  };
  const ancestorBundle: CanonicalBundle | null =
    ancestor.ancestor_body !== undefined
      ? {
          body: ancestor.ancestor_body,
          supporting_files: ancestor.ancestor_supporting_files ?? [],
        }
      : null;

  let proposed: ProposedMerge;
  try {
    proposed = await clientSideMerge({
      mine: ctx.localBundle,
      theirs: theirsBundle,
      ancestor: ancestorBundle,
      harness: ctx.adapter.harnessId as HarnessId,
      llm,
    });
  } catch (e: unknown) {
    console.error(chalk.red(`  merge engine error: ${e instanceof Error ? e.message : String(e)}`));
    return;
  }

  // Surface per-file outcomes including the asymmetric modify/delete signal.
  for (const r of proposed.per_file_results) {
    if (r.merged) {
      if (r.asymmetric === "kept-vs-delete") {
        console.log(
          chalk.yellow(
            `  ⚠  ${r.path}: server deleted this file; keeping local version. Was that an intentional server-side delete?`,
          ),
        );
      } else if (r.asymmetric === "deleted-vs-kept") {
        console.log(
          chalk.yellow(
            `  ⚠  ${r.path}: you deleted this file locally; server still has it. Re-adding the server's version.`,
          ),
        );
      } else {
        console.log(chalk.dim(`  ✓ ${r.path}: merged via ${r.strategy}`));
      }
    } else {
      console.log(chalk.red(`  ✗ ${r.path}: requires manual resolution (strategy=${r.strategy})`));
      if (r.llm_error) console.log(chalk.red(`    llm error: ${r.llm_error}`));
    }
  }

  // Refuse to push when any file is unresolved. Without this guard,
  // accepting a "partial merge" would silently DELETE the unresolved
  // files from the server's bundle (clientSideMerge omits unmerged
  // files from proposed.supporting_files), and other teammates would
  // lose those files on their next sync. v1 pushes the work back to
  // the user: resolve in your editor, then re-run sync.
  const unresolved = unresolvedPaths(proposed.per_file_results);
  if (unresolved.length > 0) {
    console.log(
      chalk.red(`  cannot push: ${unresolved.length} file(s) require manual resolution: ${unresolved.join(", ")}`),
    );
    console.log(chalk.dim("  resolve them locally (in your editor) and re-run `ark skills sync`"));
    return;
  }

  let accept: boolean;
  if (autoYes) {
    console.log(chalk.dim("  --yes: auto-accepting the merge result; pushing to server"));
    accept = true;
  } else {
    accept = await promptYesNo(`  accept this merge and push to server?`);
  }
  if (!accept) {
    console.log(chalk.dim("  rejected; nothing written"));
    return;
  }

  // Write merged bundle locally + push to server with merge_input audit.
  // NOTE: harness_hints are preserved from the server (other harnesses'
  // entries survive losslessly), but local-only edits to
  // harness_hints[harness] (e.g. user added a new `paths:` value) are
  // overwritten by the server's version. Merging frontmatter is a
  // separate scope from body merge - documented as a v1 limitation
  // for the conflict path. The user has the chance to back out at the
  // accept prompt.
  const targetDir = resolveWriteDir({ repoRoot, adapter: ctx.adapter, dir });
  writeBundleToDisk({
    adapter: ctx.adapter,
    targetDir,
    skillName: ctx.sidecar.skill_name,
    name: ancestor.server_name,
    description: ancestor.server_description,
    category: ancestor.server_category,
    tags: ancestor.server_tags,
    body: proposed.body,
    supportingFiles: proposed.supporting_files,
    harnessHints: ancestor.server_harness_hints,
  });

  const perFileStrategies = Object.fromEntries(proposed.per_file_results.map((r) => [r.path, r.strategy]));
  const mergeInput = {
    ancestor_hash: ancestor.ancestor_hash ?? null,
    mine_hash: ctx.localHash,
    theirs_hash: ancestor.server_hash,
    llm_model: proposed.llm_model,
    per_file_strategies: perFileStrategies,
    accepted_by: "cli",
  };
  const putParams: SkillhubPutParams = {
    skill_id: ctx.sidecar.payload.skill_id,
    expected_current_hash: ancestor.server_hash, // CAS against the server-current we just merged against
    harness: ctx.adapter.harnessId,
    body: proposed.body,
    supporting_files: proposed.supporting_files,
    harness_hints: ancestor.server_harness_hints,
    merge_input: mergeInput,
  };
  const ark = await getArkClient();
  try {
    const result = await ark.skillhubPut(putParams);
    writeSidecar({
      repoRoot,
      harness: ctx.adapter.harnessId,
      skillName: ctx.sidecar.skill_name,
      payload: { skill_id: result.skill.id, current_hash: result.skill.current_hash },
    });
    console.log(chalk.green(`  pushed; new current_hash ${result.skill.current_hash.slice(0, 12)}...`));
  } catch (e: unknown) {
    console.error(chalk.red(`  skillhub/put failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}

// ── entry point ───────────────────────────────────────────────────────────

export function registerSkillsSyncCommand(skillsCmd: Command): void {
  skillsCmd
    .command("sync")
    .description(
      "Reconcile local skills with the server: pull server changes, surface conflicts, optionally run a client-side LLM merge.",
    )
    .option("--harness <id>", "Restrict sync to one harness (claude | cursor | codex)")
    .option(
      "--dir <path>",
      "One-shot write-dir override (beats config.write_to + adapter default). Resolved relative to CWD.",
    )
    .option("--dry-run", "Compute classifications but write nothing and never call the LLM")
    .option("--no-merge", "Skip LLM merge on conflicts; surface them as requires-manual instead")
    .option(
      "--yes",
      "Auto-accept the LLM merge on every conflict (skips the interactive prompt; required for non-TTY callers like CI)",
    )
    .action(async (opts: SyncOpts) => {
      const repoRoot = process.cwd();

      const sidecars = listSidecars({ repoRoot, harness: opts.harness });
      if (sidecars.length === 0) {
        console.log(chalk.dim("no sidecars found - nothing to sync"));
        return;
      }

      // Resolve adapters + read local bundles for each sidecar.
      const contexts: PerSkillContext[] = [];
      for (const sidecar of sidecars) {
        const adapter = adapterFor(sidecar.harness);
        if (!adapter) {
          console.log(chalk.yellow(`skipping ${sidecar.harness}/${sidecar.skill_name}: unknown harness`));
          continue;
        }
        const localDir = locateLocalSkillDir({ repoRoot, adapter, skillName: sidecar.skill_name });
        if (!localDir) {
          console.log(
            chalk.yellow(
              `skipping ${adapter.harnessId}/${sidecar.skill_name}: sidecar present but no local skill directory found ` +
                `at any of ${adapter
                  .readPaths(repoRoot)
                  .map((p) => `${p}/${sidecar.skill_name}/`)
                  .join(", ")}`,
            ),
          );
          console.log(
            chalk.dim(
              `  hint: sync walks <readPath>/<skill-name>/SKILL.md. If you renamed the directory or changed ` +
                `the frontmatter \`name\`, the two have drifted. Fix by renaming the directory back to ` +
                `'${sidecar.skill_name}', or use \`ark skills install ${sidecar.skill_name}\` to re-materialize from the server.`,
            ),
          );
          continue;
        }
        let parsed;
        try {
          parsed = readLocalBundleAndHash(adapter, localDir);
        } catch (e: unknown) {
          console.log(
            chalk.yellow(
              `skipping ${adapter.harnessId}/${sidecar.skill_name}: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
          continue;
        }
        contexts.push({ sidecar, adapter, localDir, localBundle: parsed.bundle, localHash: parsed.hash });
      }

      if (contexts.length === 0) {
        console.log(chalk.dim("no syncable skills after filtering - exiting"));
        return;
      }

      const ark = await getArkClient();

      // Discovery banner (RFC §11 step 24): surface newly visible
      // skills since this repo's last successful sync. Best-effort -
      // any failure here is informational only and doesn't block
      // the actual sync below.
      try {
        const knownIds = new Set(contexts.map((c) => c.sidecar.payload.skill_id));
        const since = readLastSync(repoRoot) ?? "1970-01-01T00:00:00.000Z";
        const newlyPublished = await ark.skillhubPublishedAfter(since);
        const fresh = newlyPublished.filter((s) => !knownIds.has(s.id));
        if (fresh.length > 0) {
          console.log(chalk.cyan(`${fresh.length} new skill(s) available since last sync:`));
          for (const s of fresh.slice(0, 5)) {
            console.log(chalk.dim(`  ${s.id}  ${s.name}  ${s.description}`));
          }
          if (fresh.length > 5) console.log(chalk.dim(`  ... and ${fresh.length - 5} more`));
          console.log(chalk.dim(`Run \`ark skills install <id|name>\` to materialize one locally.`));
          console.log("");
        }
      } catch (e: unknown) {
        // Banner failure shouldn't block sync. Surface dim so a
        // genuinely broken server isn't completely silent.
        console.log(chalk.dim(`(discovery banner skipped: ${e instanceof Error ? e.message : String(e)})`));
      }

      let statusResult;
      try {
        statusResult = await ark.skillhubSyncStatus(
          contexts.map((c) => ({ skill_id: c.sidecar.payload.skill_id, local_hash: c.localHash })),
        );
      } catch (e: unknown) {
        fail(`skillhub/sync_status failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const byId = new Map<string, SkillhubSyncStatusEntry>(statusResult.results.map((r) => [r.skill_id, r]));

      // Lazy credential discovery - only when we hit our first
      // conflict that actually wants the LLM. Cached for the rest of
      // the run so subsequent conflicts don't re-prompt the user.
      // Short-circuited in dry-run + --no-merge mode so we don't
      // touch the user's credentials when we wouldn't have called
      // the LLM anyway.
      let cachedLlm: LlmMergeFn | null | undefined;
      const resolveLlm = async (): Promise<LlmMergeFn | null> => {
        if (cachedLlm !== undefined) return cachedLlm;
        if (opts.merge === false || opts.dryRun) {
          cachedLlm = null;
          return null;
        }
        try {
          const creds = await discoverAnthropicCredentials({
            readSecret: async (name) => {
              try {
                // Lazy import so failure doesn't break --no-merge runs.
                return (await ark.secretGet(name)) ?? null;
              } catch {
                return null;
              }
            },
          });
          console.log(chalk.dim(`  (using ${creds.sourceDetail} for LLM merge)`));
          cachedLlm = buildClaudeAgentMergeFn(creds.token, creds.kind, DEFAULT_LLM_MODEL);
        } catch (e: unknown) {
          if (e instanceof NoCredentialsError) {
            console.error(chalk.red(e.message));
            console.error(chalk.red(""));
            console.error(chalk.red("Falling back to --no-merge for the rest of this sync."));
            cachedLlm = null;
          } else {
            throw e;
          }
        }
        return cachedLlm;
      };

      // Process each skill.
      for (const ctx of contexts) {
        const entry = byId.get(ctx.sidecar.payload.skill_id);
        if (!entry) {
          console.log(
            chalk.yellow(`${ctx.adapter.harnessId}/${ctx.sidecar.skill_name}: server returned no status (unexpected)`),
          );
          continue;
        }
        const verdict: CliSyncVerdict = classifySyncStatus({
          serverStatus: entry.status,
          hasSidecar: true,
          localHashMatchesSidecar: ctx.localHash === ctx.sidecar.payload.current_hash,
          // Server's response includes server_hash; comparing it to the
          // sidecar's last-synced hash tells classify whether server
          // actually moved or just sees a different local body. Without
          // this bit, server-changed + local-diverged ambiguously meant
          // "conflict" even for the local-ahead case.
          serverHashMatchesSidecar:
            entry.server_hash !== null && entry.server_hash === ctx.sidecar.payload.current_hash,
        });
        const label = `${ctx.adapter.harnessId}/${ctx.sidecar.skill_name}`;

        if (verdict === "up-to-date") {
          console.log(chalk.dim(`up-to-date: ${label}`));
          continue;
        }
        if (verdict === "local-ahead") {
          console.log(
            chalk.cyan(`local-ahead: ${label}`) + chalk.dim(` (run \`ark skills put ${ctx.localDir}\` to publish)`),
          );
          continue;
        }
        if (verdict === "orphan") {
          console.log(
            chalk.yellow(
              `orphan: ${label} - server doesn't know this skill anymore (deleted?). Sidecar can be removed manually.`,
            ),
          );
          continue;
        }

        // The remaining verdicts (fast-forward-pull, conflict, unknown)
        // all need the bundles from get_with_ancestor.
        let ancestor: SkillhubGetWithAncestorResult;
        try {
          ancestor = await ark.skillhubGetWithAncestor({
            skill_id: ctx.sidecar.payload.skill_id,
            ancestor_hash: ctx.sidecar.payload.current_hash,
          });
        } catch (e: unknown) {
          console.error(
            chalk.red(
              `  skillhub/get_with_ancestor failed for ${label}: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
          continue;
        }

        if (verdict === "fast-forward-pull") {
          await handleFastForwardPull({ ctx, ancestor, repoRoot, dryRun: !!opts.dryRun, dir: opts.dir });
          continue;
        }

        if (verdict === "conflict" || verdict === "unknown") {
          // For unknown, refine: if local bundle equals server, it's
          // a fast-forward-pull (just write the sidecar); else it's
          // a 2-way conflict (no ancestor available).
          if (verdict === "unknown") {
            const sameAsServer = ctx.localHash === ancestor.server_hash;
            if (sameAsServer) {
              const annotation = opts.dryRun ? " (dry-run: would write fresh sidecar)" : " (writing fresh sidecar)";
              console.log(chalk.green(`unknown -> up-to-date: ${label}${annotation}`));
              if (!opts.dryRun) {
                writeSidecar({
                  repoRoot,
                  harness: ctx.adapter.harnessId,
                  skillName: ctx.sidecar.skill_name,
                  payload: { skill_id: ctx.sidecar.payload.skill_id, current_hash: ancestor.server_hash },
                });
              }
              continue;
            }
            // Fall through to conflict handling (2-way merge; ancestor will be absent).
          }
          const llm = await resolveLlm();
          await handleConflict({
            ctx,
            ancestor,
            repoRoot,
            llm,
            dryRun: !!opts.dryRun,
            autoYes: !!opts.yes,
            dir: opts.dir,
          });
          continue;
        }
      }

      // Bump the last-sync timestamp so the next run's discovery
      // banner only surfaces skills published since now. Dry-run
      // doesn't bump - we didn't actually reconcile anything.
      if (!opts.dryRun) {
        try {
          writeLastSync(repoRoot, new Date().toISOString());
        } catch (e: unknown) {
          console.log(
            chalk.dim(`(could not update last-sync timestamp: ${e instanceof Error ? e.message : String(e)})`),
          );
        }
      }
    });
}
