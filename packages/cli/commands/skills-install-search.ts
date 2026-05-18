/**
 * `ark skills install <id|name>` and `ark skills search <query>`
 * (RFC §11 steps 22-23 / §5 CLI surface).
 *
 * install: single-skill pull. Same plumbing as sync's fast-forward-pull
 *   but scoped to one explicit skill and no sidecar requirement going
 *   in. The user identifies the skill by id (`skl-...`) or name (the
 *   CLI does a name-to-id resolution via skillhub/list when the
 *   argument doesn't look like a server id).
 *
 * search: thin wrapper over skillhub/search. Server already filters
 *   visibility and does the substring match; the CLI just formats.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { join, resolve } from "path";
import { getArkClient } from "../app-client.js";
import { registry as adapterRegistry } from "../../skill-adapters/index.js";
import type { HarnessAdapter } from "../../skill-adapters/index.js";
import { writeSidecar } from "../skills/state.js";
import { loadSkillsConfig } from "../skills/config.js";
import { writeBundleToDisk } from "../skills/write.js";
import type { SkillhubSkill, SkillhubVisibility } from "../../types/index.js";

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
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

/**
 * Resolve `<id|name>` to a SkillhubSkill via skillhub/list when the
 * argument doesn't look like a server id. Exact name match preferred;
 * ambiguous names error out with the matching ids listed so the user
 * can pick.
 */
export async function resolveIdOrName(
  arg: string,
  lookup: () => Promise<SkillhubSkill[]>,
): Promise<{ skill: SkillhubSkill } | { error: string }> {
  if (arg.startsWith("skl-")) {
    // Treat as an id. Whether it exists is a server concern - the
    // caller's subsequent skillhub/get will surface NOT_FOUND.
    const all = await lookup();
    const byId = all.find((s) => s.id === arg);
    if (!byId) return { error: `no visible skill with id '${arg}'` };
    return { skill: byId };
  }
  const all = await lookup();
  const byName = all.filter((s) => s.name === arg);
  if (byName.length === 0) {
    return { error: `no visible skill named '${arg}'` };
  }
  if (byName.length > 1) {
    const ids = byName.map((s) => `${s.id} (${s.visibility})`).join(", ");
    return {
      error: `name '${arg}' is ambiguous - multiple visible skills match: ${ids}. Pass the id explicitly.`,
    };
  }
  return { skill: byName[0] };
}

/**
 * Resolve the write directory for one harness, in precedence order:
 *   1. explicit `--dir` flag (one-shot override, beats both config + default)
 *   2. `config.write_to[<harness>]` from `<repo>/.ark/config.yaml`
 *   3. `adapter.defaultWritePath(repoRoot)`
 *
 * `--dir` paths are resolved relative to `process.cwd()` (the user's
 * intuition: `--dir ./local-skills` writes to `<cwd>/local-skills/`),
 * while config-file paths are resolved relative to the repo root (the
 * config-file's intuition: `write_to.claude: .claude/skills` is a
 * project-relative path).
 *
 * Mirrors `skills-sync.ts:resolveWriteDir` so install + sync agree on
 * where files land. The two commands SHOULD share an extraction if a
 * third caller ever appears.
 */
function resolveWriteDir(opts: { repoRoot: string; adapter: HarnessAdapter; dir?: string }): string {
  if (opts.dir) {
    return resolve(process.cwd(), opts.dir);
  }
  const config = loadSkillsConfig(opts.repoRoot);
  const override = config?.write_to?.[opts.adapter.harnessId];
  return override ? join(opts.repoRoot, override) : opts.adapter.defaultWritePath(opts.repoRoot);
}

function pickInstallHarness(explicit?: string): HarnessAdapter {
  if (explicit) {
    const adapter = adapterRegistry.find((a) => a.harnessId === explicit);
    if (!adapter) {
      fail(`unknown harness '${explicit}'. Known: ${adapterRegistry.map((a) => a.harnessId).join(", ")}.`);
    }
    return adapter;
  }
  // No explicit choice. Default to the first registered adapter
  // (claude in v1). Documented in --help so users see the default
  // without surprise; they can pass --harness to override.
  return adapterRegistry[0];
}

export function registerSkillsInstallSearchCommands(skillsCmd: Command): void {
  // ── ark skills install ─────────────────────────────────────────────────
  skillsCmd
    .command("install")
    .description(
      "Pull one server-side skill to disk in the chosen harness's format. Creates the local files + sidecar in one shot. Accepts either a skill id (`skl-...`) or a unique skill name.",
    )
    .argument("<idOrName>", "Skill id (skl-...) or unique name")
    .option(
      "--harness <id>",
      `Harness to render as (default: ${adapterRegistry[0]?.harnessId ?? "<first registered>"})`,
    )
    .option(
      "--dir <path>",
      "One-shot write-dir override (beats config.write_to + adapter default). Resolved relative to CWD.",
    )
    .action(async (arg: string, opts: { harness?: string; dir?: string }) => {
      const repoRoot = process.cwd();
      const adapter = pickInstallHarness(opts.harness);
      const ark = await getArkClient();

      const resolved = await resolveIdOrName(arg, () => ark.skillhubList());
      if ("error" in resolved) return fail(resolved.error);
      const skill = resolved.skill;

      const targetDir = resolveWriteDir({ repoRoot, adapter, dir: opts.dir });
      const skillRoot = join(targetDir, skill.name);
      // Shared write helper - same stale-file sweep + empty-dir
      // prune that sync uses on FF-pull, so re-running `install`
      // over an existing skill dir cleans up files that aren't in
      // the new bundle (prevents the false-conflict loop the C14
      // review flagged for sync's write path).
      writeBundleToDisk({
        adapter,
        targetDir,
        skillName: skill.name,
        name: skill.name,
        description: skill.description,
        category: skill.category,
        tags: skill.tags,
        body: skill.body,
        supportingFiles: skill.supporting_files,
        harnessHints: skill.harness_hints,
      });
      try {
        writeSidecar({
          repoRoot,
          harness: adapter.harnessId,
          skillName: skill.name,
          payload: { skill_id: skill.id, current_hash: skill.current_hash },
        });
      } catch (e: unknown) {
        // Non-fatal - files are on disk; the user can re-run sync to
        // bring the sidecar up to date.
        console.warn(
          chalk.yellow(`warning: skill files written but sidecar failed: ${e instanceof Error ? e.message : e}`),
        );
      }
      console.log(
        chalk.green(
          `Installed ${skill.id} (${skill.name}, ${skill.visibility}) -> ${skillRoot}/ via ${adapter.harnessId} adapter`,
        ),
      );
    });

  // ── ark skills search ──────────────────────────────────────────────────
  skillsCmd
    .command("search")
    .description("Substring search over name / description / tags within visible scope.")
    .argument("<query>", "Search string (case-insensitive substring match)")
    .action(async (query: string) => {
      const ark = await getArkClient();
      let skills: SkillhubSkill[];
      try {
        skills = await ark.skillhubSearch(query);
      } catch (e: unknown) {
        return fail(`skillhub/search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (skills.length === 0) {
        console.log(chalk.dim(`no visible skills match '${query}'`));
        return;
      }
      for (const s of skills) {
        // Pad on uncolored string then prepend chalk - same trick
        // as `ark skills list` so the column stays aligned.
        const visPadded = s.visibility.padEnd(13);
        const vis = formatVisibility(s.visibility) + visPadded.slice(s.visibility.length);
        console.log(`  ${s.id.padEnd(20)}  ${vis}  ${s.name.padEnd(28)}  ${chalk.dim(s.description)}`);
      }
    });
}
