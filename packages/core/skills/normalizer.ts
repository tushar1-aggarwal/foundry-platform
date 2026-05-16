/**
 * Deterministic regex-based body normalizer for Skill Hub.
 *
 * Per §7 of docs/skillhub-rfc.md and the Q2 decision in §9: when a user
 * uploads a harness-flavored SKILL.md (e.g. Claude with `$ARGUMENTS[0]`),
 * the server normalizes the body to a tool-neutral canonical form. The
 * raw original is preserved separately in `harness_hints.<harness>.original_body`
 * (only when normalization actually changed the body).
 *
 * Why deterministic regex (not LLM):
 *   - The CLI must reproduce the server's canonical output to compute a
 *     matching `local_hash` for skill/sync_status (else every sync looks
 *     like a conflict). LLM output is non-deterministic; CLI cannot
 *     reproduce it. Deterministic regex is portable and shared.
 *   - LLM-driven normalization is a future enhancement (would need a
 *     two-hash design — out of scope for v1).
 *
 * Idempotency:
 *   normalize(normalize(x, h), h) === normalize(x, h)
 * Guaranteed by design — patterns rewrite to placeholders that don't
 * themselves match any pattern. Tests pin this.
 */

import type { SupportingFile } from "./hash.js";

export type HarnessId = "claude" | "cursor" | "codex" | string;

export interface NormalizableBundle {
  body: string;
  supporting_files: SupportingFile[];
}

/**
 * Pattern table: one entry per harness-specific token we know how to
 * neutralize. Patterns are ordered: longer / more specific patterns
 * MUST appear before shorter ones to avoid partial matches.
 *
 * The replacement is a static string (no capture-group backreferences
 * that produce variable output); idempotency depends on this.
 */
interface NormPattern {
  // Harness this pattern applies to. The normalizer only runs patterns
  // for the source harness — Cursor patterns aren't applied to a body
  // uploaded as Claude, etc.
  harness: HarnessId;
  // Regex to match. Use a function for patterns whose replacement needs
  // numeric substitution (e.g. $ARGUMENTS[0] -> "first argument").
  pattern: RegExp;
  // Either a literal replacement string or a function taking the match.
  replace: string | ((match: RegExpExecArray) => string);
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

function indexedArgumentReplacement(match: RegExpExecArray): string {
  const n = Number.parseInt(match[1] ?? "", 10);
  if (Number.isNaN(n) || n < 0) return match[0];
  const ord = ORDINALS[n] ?? `${n + 1}th`;
  return `<the ${ord} argument>`;
}

const PATTERNS: NormPattern[] = [
  // Claude indexed-argument syntax: $ARGUMENTS[N] -> "<the (N+1)-th argument>"
  { harness: "claude", pattern: /\$ARGUMENTS\[(\d+)\]/g, replace: indexedArgumentReplacement },
  // Claude shorthand: $N (where N is a digit) -> same.
  // Anchored so it doesn't match $NAME, $foo, etc. — only $0, $1, ...$9.
  // Word-boundary check on the right; left side is a non-letter/digit/$.
  { harness: "claude", pattern: /(?<![A-Za-z0-9$_])\$(\d)\b/g, replace: indexedArgumentReplacement },
  // Claude runtime variables.
  { harness: "claude", pattern: /\$\{CLAUDE_SESSION_ID\}/g, replace: "<the session id>" },
  { harness: "claude", pattern: /\$\{CLAUDE_SKILL_DIR\}/g, replace: "<the skill directory>" },
  { harness: "claude", pattern: /\$\{CLAUDE_EFFORT\}/g, replace: "<the effort level>" },
];

/**
 * Apply all patterns for the given harness to a single text blob.
 * Pure function: no mutation, no I/O.
 */
function normalizeText(text: string, harness: HarnessId): string {
  let result = text;
  for (const p of PATTERNS) {
    if (p.harness !== harness) continue;
    if (typeof p.replace === "string") {
      result = result.replace(p.pattern, p.replace);
    } else {
      // String.prototype.replace passes positional args:
      //   (match, ...captureGroups, offset, fullString, namedGroupsObj?)
      // We synthesize a real RegExpExecArray with the actual offset so
      // future patterns reading match.index see truthful data, not a
      // placeholder zero.
      result = result.replace(p.pattern, (match: string, ...rest: unknown[]) => {
        // Last arg is fullString (or namedGroupsObj if regex has named groups).
        // Second-to-last is the offset. We don't use named groups, so it's
        // always (...groups, offset, fullString).
        const offset = rest[rest.length - 2] as number;
        const fullString = rest[rest.length - 1] as string;
        const groups = rest.slice(0, -2) as string[];
        const execLike: RegExpExecArray = Object.assign([match, ...groups] as unknown as RegExpExecArray, {
          index: offset,
          input: fullString,
        });
        return (p.replace as (m: RegExpExecArray) => string)(execLike);
      });
    }
  }
  return result;
}

/**
 * Normalize a full bundle (body + supporting files).
 *
 * For supporting files, the normalizer is applied to every entry's
 * `content` regardless of file extension. In practice this is a no-op
 * for non-markdown files (`.py`, `.json`, etc.) because the Claude-token
 * patterns almost never match outside markdown prose.
 *
 * Returns a NEW bundle; inputs are never mutated.
 */
export function normalize(bundle: NormalizableBundle, harness: HarnessId): NormalizableBundle {
  return {
    body: normalizeText(bundle.body, harness),
    supporting_files: bundle.supporting_files.map((f) => ({
      path: f.path,
      content: normalizeText(f.content, harness),
    })),
  };
}

/**
 * Convenience: check if a bundle is already canonical (idempotent point).
 * Useful for the "preserve raw only if normalization changed something"
 * decision in skill/put.
 */
export function isAlreadyCanonical(bundle: NormalizableBundle, harness: HarnessId): boolean {
  const out = normalize(bundle, harness);
  if (out.body !== bundle.body) return false;
  if (out.supporting_files.length !== bundle.supporting_files.length) return false;
  for (let i = 0; i < out.supporting_files.length; i += 1) {
    const a = out.supporting_files[i];
    const b = bundle.supporting_files[i];
    if (!a || !b) return false;
    if (a.path !== b.path || a.content !== b.content) return false;
  }
  return true;
}
