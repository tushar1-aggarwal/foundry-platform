/**
 * Shared parse / render helpers used by every harness adapter.
 *
 * The Agent Skills open standard (see RFC §6) gives Claude, Cursor, and
 * Codex an identical on-disk layout: a `SKILL.md` with YAML frontmatter +
 * markdown body, plus optional subdirectories. The harness-specific
 * pieces (which directory tree the harness reads from, which extra
 * frontmatter keys it understands) are passed in as arguments. The
 * file-walking, frontmatter splitting, YAML parse/serialize, and
 * canonical-body assembly logic is the same shape for every harness and
 * lives here exactly once.
 */

import { existsSync, readFileSync, readdirSync, lstatSync } from "fs";
import { join, posix, relative, sep } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { track } from "../core/observability/telemetry.js";
import type { CanonicalSkill, LocalSkill, SupportingFile, WrittenFile } from "./types.js";

/**
 * Keys inside `harnessHints[harnessId]` that exist for adapter
 * round-trip preservation (RFC §7) and MUST NOT appear in the rendered
 * SKILL.md frontmatter. Filtered out before YAML serialization, and
 * dropped on parse too (so a hand-authored or hostile `original_body`
 * in a committed SKILL.md can't poison future renders for the team).
 */
export const STORAGE_ONLY_HINT_KEYS = new Set(["original_body", "original_supporting_files"]);

export function parseFrontmatter(raw: string, sourcePath: string): { meta: Record<string, unknown>; body: string } {
  // Normalize CRLF -> LF before parsing so a Windows-authored SKILL.md
  // (which writes `---\r\n` openings) doesn't fail the marker check
  // silently. Without this, the user gets a confusing "missing required
  // 'name' frontmatter field" error from downstream rather than a
  // signal that line endings tripped the parse.
  const normalized = raw.replace(/\r\n/g, "\n");
  // SKILL.md MUST start with `---\n` (the open frontmatter marker).
  // Anything else is treated as no-frontmatter (defensive; we still
  // accept it but everything goes in `body`).
  if (!normalized.startsWith("---\n")) {
    // Heuristic: if the file's first non-empty line LOOKS like YAML
    // (`key:` or `key: value`), the author probably forgot the `---`
    // frontmatter markers. Surface that directly rather than letting it
    // fall through to a confusing "missing the required 'name' field"
    // error several lines later. Catches the most common authoring
    // mistake (forgetting `---` on either side of the YAML block).
    const firstNonEmpty = normalized.split("\n").find((l) => l.trim().length > 0) ?? "";
    if (/^[a-zA-Z][a-zA-Z0-9_-]*\s*:/.test(firstNonEmpty)) {
      throw new Error(
        `${sourcePath}: looks like YAML frontmatter but the \`---\` markers are missing. ` +
          `SKILL.md must open with \`---\` on its own line, contain the YAML, and close with \`---\` on its own line, ` +
          `followed by the markdown body. Example:\n` +
          `  ---\n  name: my-skill\n  description: when to use\n  ---\n  # body\n  ...`,
      );
    }
    return { meta: {}, body: normalized };
  }
  // Find the closing `---` on its own line. Search from index 4 (past
  // the opening `---\n`).
  const closeMarker = "\n---\n";
  const closeIdx = normalized.indexOf(closeMarker, 4);
  if (closeIdx === -1) {
    // Open marker present, close marker missing. Almost certainly the
    // author forgot the closing `---`. Throw a specific error so they
    // know to add it rather than falling through to required-field.
    throw new Error(
      `${sourcePath}: opening \`---\` frontmatter marker found but no closing \`---\` on its own line. ` +
        `Add \`---\` on its own line after the YAML keys to separate frontmatter from the markdown body.`,
    );
  }
  const yamlText = normalized.slice(4, closeIdx);
  const body = normalized.slice(closeIdx + closeMarker.length);
  let meta: Record<string, unknown>;
  try {
    meta = (parseYaml(yamlText) ?? {}) as Record<string, unknown>;
  } catch (e: unknown) {
    // Wrap with the source path so CLI users see WHICH skill is
    // malformed, not just an opaque "YAMLException at line 3".
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`malformed YAML frontmatter in ${sourcePath}: ${msg}`);
  }
  return { meta, body };
}

export function collectSupportingFiles(skillDir: string): SupportingFile[] {
  const out: SupportingFile[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      // Skip hidden files / dirs (.DS_Store, .git, etc.) and the
      // SKILL.md at the root - that's the body, not a supporting file.
      if (entry.startsWith(".")) continue;
      const abs = join(dir, entry);
      // lstatSync does NOT follow symlinks. We then reject symlinks
      // explicitly: a symlink inside a skill dir pointing at
      // ~/.ssh/id_rsa or /etc/passwd would otherwise become a
      // "supporting file" and exfiltrate to the server on `skillhub/put`.
      // Throwing (vs silent skip) makes the unsupported pattern
      // visible to the author rather than dropping their referenced
      // file silently.
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        throw new Error(`symlinks in skill directories are not supported: ${abs}`);
      }
      if (stat.isDirectory()) {
        walk(abs);
      } else if (stat.isFile()) {
        const rel = relative(skillDir, abs);
        if (rel === "SKILL.md") continue;
        // Normalize to POSIX separators so the canonical bundle hash
        // is stable across Windows / *nix.
        const path = sep === posix.sep ? rel : rel.split(sep).join(posix.sep);
        out.push({ path, content: readFileSync(abs, "utf8") });
      }
    }
  }

  walk(skillDir);
  // Sort by path - deterministic order matters for the canonical
  // bundle hash computed downstream.
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Generic parse: read SKILL.md, route harness-specific frontmatter
 * keys into `harnessHints[harnessId]` (filtering out storage-only
 * keys symmetrically with render), walk supporting files, return a
 * harness-agnostic LocalSkill.
 *
 * Throws on missing SKILL.md, missing required name/description, or
 * malformed YAML (with source path context).
 */
export function parseSkillAsHarness(harnessId: string, skillDir: string): LocalSkill {
  const mdPath = join(skillDir, "SKILL.md");
  if (!existsSync(mdPath)) {
    throw new Error(`${harnessId} adapter: SKILL.md not found at ${mdPath}`);
  }
  const raw = readFileSync(mdPath, "utf8");
  const { meta, body } = parseFrontmatter(raw, mdPath);

  const name = typeof meta.name === "string" ? meta.name : "";
  const description = typeof meta.description === "string" ? meta.description : "";
  if (!name) {
    throw new Error(`${harnessId} adapter: SKILL.md at ${mdPath} is missing the required 'name' frontmatter field`);
  }
  if (!description) {
    throw new Error(
      `${harnessId} adapter: SKILL.md at ${mdPath} is missing the required 'description' frontmatter field`,
    );
  }

  // Everything in the frontmatter besides name / description is
  // harness-specific - stash under harnessHints[harnessId] for lossless
  // round-trips through the server. Storage-only keys are filtered
  // out symmetrically with render(): a hand-authored `original_body:
  // ...` in SKILL.md would otherwise propagate to the server and
  // hijack what every future sync of this skill renders for everyone.
  const hints: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "name" || k === "description") continue;
    if (STORAGE_ONLY_HINT_KEYS.has(k)) continue;
    hints[k] = v;
  }

  return {
    name,
    description,
    body,
    supportingFiles: collectSupportingFiles(skillDir),
    // category and tags live only in the canonical server record;
    // the CLI sets them at upload time via flags. Parse fills defaults.
    category: null,
    tags: [],
    harnessHints: { [harnessId]: hints },
  };
}

/**
 * Generic render: emit a SKILL.md with universal frontmatter (name +
 * description) plus this harness's specific extensions, followed by
 * every supporting file.
 *
 * Body / supporting-files source selection follows RFC §7
 * author-fidelity: when the upload normalizer changed something,
 * the raw originals are stored under `harnessHints[harnessId].
 * original_body` / `.original_supporting_files`. Render prefers those
 * when present so the original author's harness reproduces what they
 * wrote.
 */
export function renderSkillForHarness(harnessId: string, skill: CanonicalSkill): WrittenFile[] {
  const hints = skill.harnessHints[harnessId] ?? {};

  const body = typeof hints.original_body === "string" ? hints.original_body : skill.body;
  const supportingFiles = Array.isArray(hints.original_supporting_files)
    ? (hints.original_supporting_files as SupportingFile[])
    : skill.supportingFiles;

  // Universal keys always come first.
  const fm: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };
  for (const [k, v] of Object.entries(hints)) {
    if (STORAGE_ONLY_HINT_KEYS.has(k)) continue;
    fm[k] = v;
  }

  const yamlStr = stringifyYaml(fm);
  // `yaml`'s stringify already ends with `\n`, so the closing marker
  // sits on its own line. Then exactly one `\n` separates frontmatter
  // from body, matching what parseFrontmatter expects.
  const skillMd = `---\n${yamlStr}---\n${body}`;

  const out: WrittenFile[] = [{ relativePath: "SKILL.md", content: skillMd }];
  for (const f of supportingFiles) {
    out.push({ relativePath: f.path, content: f.content });
  }
  return out;
}

/**
 * Telemetry hook for the §9 Q2 decision (RFC). Non-Claude adapters
 * call this from `render()` before emitting files. Fires when the
 * canonical record carries a non-empty `harnessHints.claude` — meaning
 * the skill was authored through Claude AND has EITHER Claude-specific
 * frontmatter (e.g. `disable-model-invocation`, `allowed-tools`) OR
 * storage-only keys (`original_body` / `original_supporting_files`,
 * present when normalize-on-upload rewrote the body). A cursor / codex
 * render of that skill is exactly the cross-harness consumption that
 * justifies the normalize-on-upload policy. If this counter stays near
 * zero, option (a) "store as-is" becomes a defensible simplification.
 *
 * Counter only - no payload, no PII. Buffered + dropped silently when
 * telemetry is disabled (per the existing `track` semantics).
 *
 * **Adapter implementer checklist:** every non-Claude adapter's
 * `render()` MUST call this before delegating to `renderSkillForHarness`,
 * passing its own `harnessId` as `targetHarness`. Claude's adapter
 * deliberately does NOT call it — rendering a Claude-authored skill
 * back to Claude is a self-render, not cross-harness consumption.
 */
export function emitCrossHarnessTelemetryIfClaudeOrigin(skill: CanonicalSkill, targetHarness: string): void {
  const claudeHints = skill.harnessHints.claude;
  if (claudeHints && Object.keys(claudeHints).length > 0) {
    track("skillhub.cross_harness_render", {
      source_harness: "claude",
      target_harness: targetHarness,
    });
  }
}
