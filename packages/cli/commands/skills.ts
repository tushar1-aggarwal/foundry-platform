/**
 * `ark skills` (plural) - tenant-scoped Skill Hub CRUD.
 *
 * Distinct from `ark skill` (singular) in `commands/skill.ts` which
 * manages the BUILTIN file-backed agent-skill store. The two share
 * a noun but live in independent namespaces:
 *
 *   ark skill  / skill/*       FileSkillStore  (agent skill-injection)
 *   ark skills / skillhub/*    SkillRepository (tenant-scoped CRUD-with-history)
 *
 * Consolidation tracked as a post-PR followup. v1 keeps them separate.
 *
 * This commit (C12) covers the basic CRUD surface:
 *   ark skills list
 *   ark skills get <id>
 *   ark skills put <path> [--harness ...] [--visibility ...] [...]
 *   ark skills delete <id>
 *
 * `ark skills sync` (the LLM-merge orchestrator) lands separately.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readdirSync, statSync } from "fs";
import { basename, join, relative, resolve, sep } from "path";
import { getArkClient } from "../app-client.js";
import { registry as adapterRegistry } from "../../skill-adapters/index.js";
import type { HarnessAdapter } from "../../skill-adapters/index.js";
import { deleteSidecar, listSidecars, readSidecar, writeSidecar } from "../skills/state.js";
import type { SkillhubPutParams, SkillhubSkill, SkillhubVisibility } from "../../types/index.js";
import { registerSkillsSyncCommand } from "./skills-sync.js";
import { registerSkillsInstallSearchCommands } from "./skills-install-search.js";
import type { LocalSkill } from "../../skill-adapters/index.js";
import type { SidecarPayload } from "../skills/state.js";

/**
 * Path-to-harness inference. The user typically runs the command
 * from a repo root: `ark skills put .claude/skills/code-review`.
 * Walk every adapter's `readPaths(repoRoot)` looking for one whose
 * declared read path is a prefix of the input path. Exactly one match
 * resolves; zero matches errors with a "pass --harness explicitly"
 * hint; multiple matches errors (would be ambiguous).
 */
function inferHarnessFromPath(skillPath: string, repoRoot: string): string {
  const absSkillPath = resolve(repoRoot, skillPath);
  const matches: string[] = [];
  for (const adapter of adapterRegistry) {
    for (const readPath of adapter.readPaths(repoRoot)) {
      // Path-prefix match (after both are absolute). Append a separator
      // to the prefix so `.claudemate/skills/x` doesn't match
      // `.claude/skills`.
      const prefix = readPath.endsWith(sep) ? readPath : readPath + sep;
      if (absSkillPath === readPath || absSkillPath.startsWith(prefix)) {
        matches.push(adapter.harnessId);
        break; // one match per adapter is enough
      }
    }
  }
  if (matches.length === 0) {
    throw new Error(
      `could not infer harness from path '${skillPath}' (no adapter's read paths contain it). Pass --harness <id> explicitly. Known harnesses: ${adapterRegistry.map((a) => a.harnessId).join(", ")}.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `path '${skillPath}' is ambiguous - multiple adapters claim it: ${matches.join(", ")}. Pass --harness <id> to disambiguate.`,
    );
  }
  return matches[0];
}

function getAdapter(harnessId: string): HarnessAdapter {
  const adapter = adapterRegistry.find((a) => a.harnessId === harnessId);
  if (!adapter) {
    throw new Error(`unknown harness '${harnessId}'. Known: ${adapterRegistry.map((a) => a.harnessId).join(", ")}.`);
  }
  return adapter;
}

function formatVisibility(v: SkillhubVisibility): string {
  switch (v) {
    case "user":
      return chalk.cyan("user");
    case "team":
      return chalk.blue("team");
    case "tenant":
      return chalk.magenta("tenant");
    case "cross_tenant":
      return chalk.yellow("cross_tenant");
    default:
      return v;
  }
}

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

/**
 * Enforce SKILL.md's directory-name == frontmatter-name convention.
 * Returns `{ ok: true }` when they match (or pure helper export for
 * tests), `{ error: <msg> }` when they don't.
 *
 * Why this check exists: the rest of the CLI (sync's `locateLocalSkillDir`,
 * install's `<targetDir>/<skill.name>/`) keys off the frontmatter `name`
 * for directory layout. If put accepts a mismatch, sync silently fails
 * later with "no local skill directory found at <readPath>/<name>/".
 * Catch it at put time, when the user can fix it in one step.
 */
export function assertSkillDirNameMatchesFrontmatter(args: {
  skillDirName: string;
  frontmatterName: string;
  skillPathForHint: string;
}): { ok: true } | { error: string } {
  if (args.skillDirName === args.frontmatterName) return { ok: true };
  return {
    error:
      `skill directory name '${args.skillDirName}' does not match SKILL.md frontmatter \`name: ${args.frontmatterName}\`. ` +
      `Claude Code's SKILL.md convention requires they match (the dashboard, sync, and install all key off the name). ` +
      `Fix by either:\n` +
      `  - renaming the directory:  mv ${args.skillPathForHint} ${join(args.skillPathForHint, "..", args.frontmatterName)}\n` +
      `  - or changing the frontmatter: update SKILL.md \`name: ${args.skillDirName}\``,
  };
}

/**
 * Walk every adapter's `readPaths(repoRoot)` and return the (harness,
 * skillName, relativePath) for each local skill bundle (directory
 * containing `SKILL.md`). Used by the `list` empty-state hint so users
 * with on-disk skills that haven't been uploaded to the hub get a
 * concrete "next step" instead of a confusing "No skills visible."
 *
 * Pure read-only — never touches the server. Quietly tolerates missing
 * read paths (most repos won't have all three of `.claude/skills/`,
 * `.cursor/...`, `.codex/...`).
 */
export function findLocalSkillBundles(
  repoRoot: string,
): Array<{ harness: string; name: string; relativePath: string }> {
  const out: Array<{ harness: string; name: string; relativePath: string }> = [];
  for (const adapter of adapterRegistry) {
    for (const readPath of adapter.readPaths(repoRoot)) {
      if (!existsSync(readPath)) continue;
      let entries: string[];
      try {
        entries = readdirSync(readPath);
      } catch {
        continue; // permission denied / not-a-dir — best-effort scan
      }
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const skillDir = join(readPath, entry);
        try {
          if (!statSync(skillDir).isDirectory()) continue;
          if (!existsSync(join(skillDir, "SKILL.md"))) continue;
        } catch {
          continue;
        }
        const rel = relative(repoRoot, skillDir);
        out.push({ harness: adapter.harnessId, name: entry, relativePath: rel });
      }
    }
  }
  return out;
}

export interface PutCliOpts {
  visibility?: string;
  team?: string;
  description?: string;
  category?: string;
  tag: string[];
  force?: boolean;
}

/**
 * Pure assembly of the `skillhub/put` payload from CLI inputs. Extracted
 * so we can unit-test the create-vs-update branching, the description /
 * supporting_files / harness_hints always-send invariant, and the
 * visibility-change rejection without booting a daemon.
 *
 * Returns either `{ params }` (success) or `{ error }` (a validation
 * failure the action handler converts to a `fail()` call).
 *
 * `description`, `body`, `supporting_files`, and `harness_hints` are
 * ALWAYS sent (on both create and update) so a local edit to any of
 * those fields actually propagates to the server. The server's
 * `||`-fallback for description handles the "local stripped it
 * accidentally" edge case (RFC C8 review fix).
 */
export function buildPutParams(args: {
  local: LocalSkill;
  harness: string;
  sidecar: SidecarPayload | null;
  opts: PutCliOpts;
}): { params: SkillhubPutParams } | { error: string } {
  const { local, harness, sidecar, opts } = args;
  const isCreate = sidecar === null;

  const params: SkillhubPutParams = {
    harness,
    body: local.body,
    supporting_files: local.supportingFiles,
    harness_hints: local.harnessHints,
    // Always send description: a local edit (e.g. typo fix in the
    // SKILL.md frontmatter) must propagate on update too, not just on
    // create. Server-side `params.description?.trim() || existing`
    // handles the empty-string edge defensively.
    description: opts.description ?? local.description,
    name: local.name,
  };
  if (opts.category !== undefined) params.category = opts.category;
  if (opts.tag.length > 0) params.tags = opts.tag;
  if (opts.force) params.force = true;

  if (isCreate) {
    const visibility = (opts.visibility ?? "user") as SkillhubVisibility;
    if (visibility !== "user" && visibility !== "team" && visibility !== "tenant") {
      return {
        error:
          "--visibility must be one of user | team | tenant (cross_tenant is reserved for system-admin and not creatable in v1)",
      };
    }
    params.visibility = visibility;
    if (visibility === "team") {
      if (!opts.team) return { error: "--team <id> is required when --visibility=team" };
      params.team_id = opts.team;
    }
  } else {
    params.skill_id = sidecar.skill_id;
    if (!opts.force) {
      params.expected_current_hash = sidecar.current_hash;
    }
    if (opts.visibility) {
      return {
        error:
          "cannot change visibility on update in v1 (per RFC §5 visibility-change limitation). Delete and recreate to change visibility.",
      };
    }
  }

  return { params };
}

export function registerSkillsCommands(program: Command): void {
  const skillsCmd = program
    .command("skills")
    .description("Skill Hub - tenant-scoped skill registry (distinct from `ark skill` builtin store)");

  // ── ark skills list ────────────────────────────────────────────────────
  skillsCmd
    .command("list")
    .description("List skills visible to caller (user-scope + accessible team/tenant rows)")
    .action(async () => {
      const ark = await getArkClient();
      let skills: SkillhubSkill[];
      try {
        skills = await ark.skillhubList();
      } catch (e: unknown) {
        fail(`skillhub/list failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!skills.length) {
        // Helpful empty-state: distinguish "no skills on the server AND none
        // on disk" (author your first skill) from "no skills on the server
        // BUT on-disk bundles exist" (you have local files; here's how to
        // upload them). Without this hint, users coming from Claude Code
        // (who naturally have `.claude/skills/...` in their repos) see a
        // bare "No skills visible." and assume the registry is broken.
        const repoRoot = process.cwd();
        const local = findLocalSkillBundles(repoRoot);
        if (local.length === 0) {
          console.log(chalk.dim("No skills uploaded yet, and no local skill bundles found in this directory."));
          console.log(
            chalk.dim(
              "  Author a skill at .claude/skills/<name>/SKILL.md (or your harness's read path), then `ark skills put` to upload.",
            ),
          );
          return;
        }
        console.log(chalk.dim("No skills uploaded yet."));
        console.log();
        console.log(`Local skill bundles found in this directory (not yet uploaded to the hub):`);
        for (const b of local) {
          console.log(`  ${chalk.cyan(b.harness)}/${b.name}   ${chalk.dim(b.relativePath)}`);
        }
        console.log();
        console.log(chalk.bold("Upload one:"));
        console.log(`  ark skills put ${local[0].relativePath}`);
        console.log(chalk.bold("Upload all:"));
        console.log(
          `  for d in ${local[0].relativePath.split("/").slice(0, -1).join("/")}/*/; do ark skills put "$d"; done`,
        );
        return;
      }
      for (const s of skills) {
        // Pad on the uncolored string THEN colorize - chalk adds
        // ~10 invisible ANSI characters that padEnd would otherwise
        // count toward width, breaking column alignment.
        const visPadded = s.visibility.padEnd(13);
        const vis = formatVisibility(s.visibility) + visPadded.slice(s.visibility.length);
        console.log(`  ${s.id.padEnd(20)}  ${vis}  ${s.name.padEnd(28)}  ${chalk.dim(s.description)}`);
      }
    });

  // ── ark skills get ─────────────────────────────────────────────────────
  skillsCmd
    .command("get")
    .description("Read one skill (canonical bundle) by id; prints JSON to stdout")
    .argument("<id>", "Skill id (e.g. skl-abc123def456)")
    .action(async (id: string) => {
      const ark = await getArkClient();
      let skill: SkillhubSkill;
      try {
        skill = await ark.skillhubGet(id);
      } catch (e: unknown) {
        fail(`skillhub/get failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      console.log(JSON.stringify(skill, null, 2));
    });

  // ── ark skills delete ──────────────────────────────────────────────────
  skillsCmd
    .command("delete")
    .description("Soft-delete a skill by id (visibility-aware: user-scope=ownership, team/tenant=admin)")
    .argument("<id>", "Skill id")
    .action(async (id: string) => {
      const ark = await getArkClient();
      try {
        const { ok } = await ark.skillhubDelete(id);
        if (!ok) {
          console.log(chalk.yellow(`skill '${id}' was already deleted or not found`));
          // Sidecar cleanup still runs (idempotent) - the local repo
          // might still have a stale sidecar pointing at this id even
          // if the server already forgot it.
        } else {
          console.log(chalk.green(`Deleted skill: ${id}`));
        }
        // Always sweep matching local sidecars. Without this, the next
        // `ark skills put` over the same local dir reads the stale
        // sidecar, treats it as an UPDATE, and fails with NOT_FOUND
        // (the server filters deleted rows out of `getById`). Mirror
        // semantics on both branches above so a repeat-delete still
        // cleans up an orphan sidecar that a prior failed delete left
        // behind.
        const repoRoot = process.cwd();
        const matching = listSidecars({ repoRoot }).filter((s) => s.payload.skill_id === id);
        for (const s of matching) {
          deleteSidecar({ repoRoot, harness: s.harness, skillName: s.skill_name });
          console.log(chalk.dim(`  removed stale sidecar: ${s.harness}/${s.skill_name}`));
        }
      } catch (e: unknown) {
        fail(`skillhub/delete failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

  // ── ark skills put ─────────────────────────────────────────────────────
  skillsCmd
    .command("put")
    .description(
      "Upload a skill from a local directory. Auto-infers harness from the path when unambiguous. " +
        "Renaming a skill (changing the `name` field in SKILL.md frontmatter) creates a NEW server-side skill instead of renaming the existing one - " +
        "the sidecar lookup is keyed by name, so a rename produces a fresh create. " +
        "Use `ark skills delete <old-id>` afterward to remove the stale original.",
    )
    .argument("<path>", "Path to skill directory (containing SKILL.md)")
    .option("--harness <id>", "Override harness inference (claude | cursor | codex)")
    .option(
      "--visibility <scope>",
      "Create-mode visibility (user | team | tenant). Defaults to 'user'. Cannot change visibility on update.",
    )
    .option("--team <id>", "Required when --visibility=team (create mode)")
    .option("--description <text>", "Override description (defaults to SKILL.md frontmatter)")
    .option("--category <cat>", "Optional category for grouping")
    .option(
      "--tag <tag>",
      "Add tag (repeatable). Tags are server-side metadata, NOT in SKILL.md frontmatter.",
      (val: string, prev: string[] = []) => prev.concat(val),
      [],
    )
    .option("--force", "Bypass optimistic-lock CAS on update (visibility-aware: user=ownership, team/tenant=admin)")
    .action(
      async (
        skillPath: string,
        opts: {
          harness?: string;
          visibility?: string;
          team?: string;
          description?: string;
          category?: string;
          tag: string[];
          force?: boolean;
        },
      ) => {
        const repoRoot = process.cwd();

        // Resolve harness: explicit --harness wins, else infer from path.
        let harness: string;
        try {
          harness = opts.harness ?? inferHarnessFromPath(skillPath, repoRoot);
        } catch (e: unknown) {
          return fail(e instanceof Error ? e.message : String(e));
        }
        const adapter = getAdapter(harness);

        // Parse the local skill directory.
        const absSkillPath = resolve(repoRoot, skillPath);
        const local = (() => {
          try {
            return adapter.parse(absSkillPath);
          } catch (e: unknown) {
            return fail(`adapter.parse failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        })();

        const nameCheck = assertSkillDirNameMatchesFrontmatter({
          skillDirName: basename(absSkillPath),
          frontmatterName: local.name,
          skillPathForHint: skillPath,
        });
        if ("error" in nameCheck) return fail(nameCheck.error);

        // Create vs update determined by sidecar presence (under
        // <repo>/.ark/skills-state/<harness>-<name>.json).
        const sidecar = (() => {
          try {
            return readSidecar({ repoRoot, harness, skillName: local.name });
          } catch (e: unknown) {
            return fail(`sidecar read failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        })();
        const isCreate = sidecar === null;

        // Build the put payload (pure helper, unit-tested).
        const built = buildPutParams({ local, harness, sidecar, opts });
        if ("error" in built) return fail(built.error);
        const params = built.params;

        // Submit.
        const ark = await getArkClient();
        let result;
        try {
          result = await ark.skillhubPut(params);
        } catch (e: unknown) {
          // Stale-sidecar recovery: the sidecar's skill_id pointed at
          // a skill the server doesn't have any more (deleted, hard-
          // removed, or never visible to this caller). Clean up the
          // stale sidecar and tell the user to re-run as a CREATE.
          // We don't silently auto-CREATE because the original skill
          // might have been team / tenant scope, and recreating as
          // user-scope without confirmation would quietly change the
          // sharing model. Better to let the user re-issue the put
          // with explicit visibility flags.
          const msg = e instanceof Error ? e.message : String(e);
          if (!isCreate && /not found/i.test(msg)) {
            try {
              deleteSidecar({ repoRoot, harness, skillName: local.name });
            } catch {
              // Best-effort - if sidecar cleanup itself fails the user
              // sees the original error message anyway.
            }
            return fail(
              `skillhub/put failed: the sidecar referenced skill '${sidecar!.skill_id}' but the server no longer has it ` +
                `(deleted on the server, or this caller no longer has visibility). ` +
                `Cleaned up the stale sidecar. Re-run \`ark skills put ${skillPath}\` ` +
                `(optionally with --visibility / --team flags) to create a fresh skill.`,
            );
          }
          return fail(`skillhub/put failed: ${msg}`);
        }

        // Persist the sidecar so future syncs / puts have ancestry.
        try {
          writeSidecar({
            repoRoot,
            harness,
            skillName: result.skill.name,
            payload: { skill_id: result.skill.id, current_hash: result.skill.current_hash },
          });
        } catch (e: unknown) {
          // Non-fatal - the server-side write succeeded; warn but don't
          // exit non-zero.
          console.warn(
            chalk.yellow(`warning: skill saved but sidecar write failed: ${e instanceof Error ? e.message : e}`),
          );
        }

        // Three update outcomes:
        //   - new version row inserted             -> "Updated"
        //   - body unchanged from expected hash    -> "Updated (metadata only)"
        //   - body reverted to a prior version     -> "Reverted to prior version"
        // The repo's `versionWritten` flag distinguishes (1) from (2)+(3);
        // a hash-change despite versionWritten=false indicates a revert
        // (the existing skill_versions row was reused via onConflictDoNothing).
        const isMetadataOnly =
          !isCreate && !result.version_written && params.expected_current_hash === result.skill.current_hash;
        const isRevert =
          !isCreate && !result.version_written && params.expected_current_hash !== result.skill.current_hash;
        const action = isCreate
          ? "Created"
          : isRevert
            ? "Reverted to prior version of"
            : isMetadataOnly
              ? "Updated (metadata only)"
              : "Updated";
        console.log(
          chalk.green(
            `${action} skill: ${result.skill.id} (${result.skill.name}, ${result.skill.visibility}, hash ${result.skill.current_hash.slice(0, 12)}...)`,
          ),
        );
      },
    );

  // sync subcommand lives in skills-sync.ts to keep this file focused.
  registerSkillsSyncCommand(skillsCmd);
  // install + search live in skills-install-search.ts.
  registerSkillsInstallSearchCommands(skillsCmd);
}

// Exported for unit testing - the path inference is the part most worth
// covering without spinning up a full daemon.
export { inferHarnessFromPath };
