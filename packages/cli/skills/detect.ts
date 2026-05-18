/**
 * Detection cascade for `ark skills sync` (RFC §5).
 *
 * Resolves "which harness(es) does this repo use?" via four progressively
 * less-specific signals. The first layer that produces a non-empty
 * answer wins; subsequent layers are skipped. `enabled_harnesses` in
 * the config is ALSO applied as a final filter when any layer above
 * Layer 2 produced the answer ("restrict ... even if others are
 * detected" - RFC §5 config example).
 *
 *   Layer 1 — `.claude/skills/<name>/SKILL.md` exists, `.cursor/...`,
 *              `.codex/...` etc. Walk each adapter's `readPaths()`.
 *   Layer 2 — `skills.enabled_harnesses` in `<repo>/.ark/config.yaml`.
 *   Layer 3 — `skill.default_harness` from `scoping_overrides` (server RPC).
 *   Layer 4 — interactive prompt. The caller decides whether a TTY is
 *              attached; we just invoke the supplied callback.
 *
 * Deferred from v1 per RFC §5: user-home dirs (`~/.claude/skills/`),
 * repo heuristics (`.gitignore`, `.vscode/`), and glob expansion in
 * `config.read_paths`. Add when real users hit the cascade-falls-to-prompt
 * case too often.
 *
 * Auto-persist of a Layer 4 choice to `<repo>/.ark/config.yaml` is the
 * CALLER's responsibility (`sync` command calls `writeSkillsConfig`
 * when source === "prompt"). This module stays IO-pure beyond the
 * required directory existence checks.
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { HarnessAdapter } from "../../skill-adapters/index.js";
import type { SkillsConfig } from "./config.js";

export type DetectSource = "existing-dirs" | "config" | "scoping" | "prompt";

export interface DetectResult {
  /** Resolved harness ids, filtered to those known to the registry. */
  harnesses: string[];
  /** Which cascade layer produced the result. Used for UX messaging + auto-persist decisions. */
  source: DetectSource;
}

export interface DetectOptions {
  repoRoot: string;
  /** The adapter registry from `packages/skill-adapters/index.ts`. */
  registry: HarnessAdapter[];
  /** Parsed `<repo>/.ark/config.yaml:skills` section, or null when absent. */
  config: SkillsConfig | null;
  /**
   * Layer 3: query the server for the caller's resolved
   * `skill.default_harness` scoping override. Return `null` when unset.
   * Omit when the caller wants to skip Layer 3 (e.g. offline mode).
   */
  resolveScopingDefault?: () => Promise<string | null>;
  /**
   * Layer 4: interactive prompt. Return the chosen harness id, or
   * `null` to bail out of the prompt path. Omit when the caller has
   * already decided no prompting is allowed (e.g. `--no-interactive`).
   */
  promptUser?: () => Promise<string | null>;
}

export class DetectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetectError";
  }
}

export async function detectHarnesses(opts: DetectOptions): Promise<DetectResult> {
  const { repoRoot, registry, config, resolveScopingDefault, promptUser } = opts;
  const knownHarnesses = new Set(registry.map((a) => a.harnessId));

  // Layer 1: existing skill dirs.
  const layer1: string[] = [];
  for (const adapter of registry) {
    if (adapter.readPaths(repoRoot).some(containsAnySkill)) {
      layer1.push(adapter.harnessId);
    }
  }
  if (layer1.length > 0) {
    return finalize(layer1, "existing-dirs", config, knownHarnesses);
  }

  // Layer 2: config.enabled_harnesses.
  if (config?.enabled_harnesses && config.enabled_harnesses.length > 0) {
    return finalize(config.enabled_harnesses, "config", config, knownHarnesses);
  }

  // Layer 3: scoping-override default.
  if (resolveScopingDefault) {
    const sd = await resolveScopingDefault();
    if (sd) {
      return finalize([sd], "scoping", config, knownHarnesses);
    }
  }

  // Layer 4: interactive prompt.
  if (promptUser) {
    const choice = await promptUser();
    if (choice) {
      return finalize([choice], "prompt", config, knownHarnesses);
    }
  }

  throw new DetectError(
    "no harnesses detected: no existing .claude/.cursor/.codex skill dirs, no <repo>/.ark/config.yaml:skills.enabled_harnesses, no skill.default_harness scoping override, and no interactive prompt available. Pass --harness <id> explicitly, or create <repo>/.ark/config.yaml.",
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Does this directory contain at least one `<name>/SKILL.md`? Used by
 * Layer 1 to decide "this harness is in active use." We don't care
 * about validity (parseable frontmatter, required fields) - that's
 * the adapter's parse() problem. Mere presence is enough to win the
 * layer.
 */
function containsAnySkill(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const skillDir = join(dir, entry);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(skillDir, "SKILL.md"))) return true;
  }
  return false;
}

/**
 * Drop unknown harness ids (catches typos in config / scoping value),
 * then apply `enabled_harnesses` as a hard filter when set AND the
 * result didn't originate from Layer 2 (which is already those
 * harnesses by construction).
 *
 * Empty result from filtering is still returned as `{harnesses: [], source}`
 * - the caller decides whether that's an error. (Sync would error;
 * a hypothetical "what would detect have returned?" probe would not.)
 */
function finalize(
  harnesses: string[],
  source: DetectSource,
  config: SkillsConfig | null,
  knownHarnesses: Set<string>,
): DetectResult {
  // Deduplicate + drop unknown.
  const seen = new Set<string>();
  let result: string[] = [];
  for (const h of harnesses) {
    if (!knownHarnesses.has(h)) continue;
    if (seen.has(h)) continue;
    seen.add(h);
    result.push(h);
  }
  // Apply enabled_harnesses filter for non-config sources.
  if (source !== "config" && config?.enabled_harnesses && config.enabled_harnesses.length > 0) {
    const allowed = new Set(config.enabled_harnesses);
    result = result.filter((h) => allowed.has(h));
  }
  return { harnesses: result, source };
}
