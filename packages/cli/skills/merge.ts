/**
 * Client-side 3-way merge for `ark skills sync` (RFC §7).
 *
 * Runs entirely in-process. The LLM call is parameterized as an
 * injected function so tests can pass a deterministic stub without
 * actually hitting Anthropic. The production wrapper at the bottom
 * of this file builds the real `@anthropic-ai/claude-agent-sdk` call.
 *
 * Per-file strategy (RFC §7 "Merge strategy by file type"):
 *   - .md / .txt / .rst        -> llm (3-way merge prompt)
 *   - everything else          -> manual (raw three-way; user resolves in editor)
 *
 * Per-file override comes from `harness_hints[harness].merge_strategy`,
 * a map of `path -> "llm" | "manual"` set at upload time.
 *
 * Outcome per file:
 *   - file unchanged in mine vs ancestor          -> take theirs (server-only edit)
 *   - file unchanged in theirs vs ancestor        -> take mine (local-only edit)
 *   - both changed AND strategy = llm             -> call llm fn; retry once on
 *                                                    error/malformed; on permanent
 *                                                    failure mark requires_manual
 *   - both changed AND strategy = manual          -> mark requires_manual + raw three-way
 *   - 2-way (no ancestor): every file with both
 *     mine + theirs is treated as "both changed"  -> same llm/manual fork as above
 *
 * The SDK output is run through the shared normalizer before being
 * accepted - inputs were canonical, but the model might re-introduce
 * harness-specific syntax in its merge. The normalizer pass keeps the
 * proposed_merge canonical so the next `sync_status` round doesn't
 * spuriously diff.
 */

import { extname } from "path";
import { normalize } from "../../core/skills/normalizer.js";
import type { HarnessId } from "../../core/skills/normalizer.js";
import type { SkillhubSupportingFile } from "../../types/index.js";

export const MARKDOWN_EXTENSIONS = new Set([".md", ".txt", ".rst"]);

export type FileStrategy = "llm" | "manual";

export interface CanonicalBundle {
  body: string;
  supporting_files: SkillhubSupportingFile[];
}

export interface RawThreeWay {
  ancestor: string;
  mine: string;
  theirs: string;
}

export interface PerFileResult {
  path: string;
  strategy: FileStrategy;
  merged: boolean;
  /** Set when merged === true. */
  content?: string;
  /** Set when merged === false (i.e. requires_manual). */
  raw?: RawThreeWay;
  /** When merged === false because LLM call failed (not because strategy=manual). */
  llm_error?: string;
  /**
   * Modify/delete conflict signal. v1 resolution policy is "keep the
   * surviving side" - we do NOT block the merge. The signal is here
   * so the CLI can surface a warning at the moment of impact ("you
   * just restored a file your teammate intentionally deleted").
   *
   *   "kept-vs-delete"   - mine kept editing, theirs deleted, ancestor had it
   *                        -> resolved to mine; user is silently overriding
   *                           an intentional server-side delete
   *   "deleted-vs-kept"  - mine deleted, theirs kept, ancestor had it
   *                        -> resolved to theirs; user's intentional local
   *                           delete is silently overridden
   *
   * Absent when one side legitimately added a brand-new file (no
   * ancestor entry) - that's a clean one-sided add, not a conflict.
   * Absent when both sides agree (convergent edits, double-deletes).
   */
  asymmetric?: "kept-vs-delete" | "deleted-vs-kept";
}

export interface ProposedMerge {
  /** Top-level SKILL.md body. May be the original mine/theirs/ancestor depending on outcome. */
  body: string;
  /** Supporting files set, post-merge. Entries with requires_manual omit `content` here; CLI uses raw. */
  supporting_files: SkillhubSupportingFile[];
  llm_model: string;
  per_file_results: PerFileResult[];
}

export interface LlmMergeInput {
  path: string;
  ancestor: string;
  mine: string;
  theirs: string;
}

export type LlmMergeFn = (input: LlmMergeInput) => Promise<{ merged: string } | { error: string }>;

export const DEFAULT_LLM_MODEL = "claude-sonnet-4-6";

export interface ClientSideMergeOpts {
  mine: CanonicalBundle;
  theirs: CanonicalBundle;
  /** Ancestor bundle from `skillhub/get_with_ancestor`. `null` triggers 2-way merge. */
  ancestor: CanonicalBundle | null;
  /** Harness id (claude / cursor / codex). Drives normalizer + overrides lookup. */
  harness: HarnessId;
  /** Optional per-file strategy overrides from `harness_hints[harness].merge_strategy`. */
  strategyOverrides?: Record<string, FileStrategy>;
  /** The LLM call. Production passes `buildClaudeAgentMergeFn(token, kind)`; tests pass a stub. */
  llm: LlmMergeFn;
  /** Model label included in `proposed_merge.llm_model`. Defaults to `claude-sonnet-4-6`. */
  llmModel?: string;
}

/**
 * Resolve the strategy for one file. Override beats extension.
 */
export function fileStrategy(path: string, override?: FileStrategy): FileStrategy {
  if (override === "llm" || override === "manual") return override;
  const ext = extname(path).toLowerCase();
  return MARKDOWN_EXTENSIONS.has(ext) ? "llm" : "manual";
}

/**
 * Run the 3-way (or 2-way) merge over a canonical bundle. The bundle
 * is treated as `SKILL.md` plus supporting_files; we walk the union
 * of paths and apply the per-file outcome rules above.
 */
export async function clientSideMerge(opts: ClientSideMergeOpts): Promise<ProposedMerge> {
  const { mine, theirs, ancestor, harness, strategyOverrides, llm } = opts;
  const llmModel = opts.llmModel ?? DEFAULT_LLM_MODEL;

  const mineFiles = bundleToMap(mine);
  const theirsFiles = bundleToMap(theirs);
  const ancestorFiles = ancestor ? bundleToMap(ancestor) : new Map<string, string>();

  // Union of paths, deterministic order.
  const allPaths = new Set<string>();
  for (const k of mineFiles.keys()) allPaths.add(k);
  for (const k of theirsFiles.keys()) allPaths.add(k);
  for (const k of ancestorFiles.keys()) allPaths.add(k);
  const sortedPaths = [...allPaths].sort();

  const results: PerFileResult[] = [];
  const mergedFiles = new Map<string, string>();

  for (const path of sortedPaths) {
    const mineContent = mineFiles.get(path);
    const theirsContent = theirsFiles.get(path);
    const ancestorContent = ancestorFiles.get(path);
    const strategy = fileStrategy(path, strategyOverrides?.[path]);

    // Asymmetric presence: file in only one side. v1 keeps the
    // surviving side - but we distinguish "legitimate one-sided add"
    // (no ancestor entry) from "modify/delete conflict" (ancestor
    // had the file, one side deleted it). The latter gets an
    // `asymmetric` signal so the CLI can warn the user that they're
    // silently restoring an intentional delete.
    const ancestorHadFile = ancestor !== null && ancestorContent !== undefined;
    if (mineContent !== undefined && theirsContent === undefined) {
      mergedFiles.set(path, mineContent);
      results.push({
        path,
        strategy,
        merged: true,
        content: mineContent,
        ...(ancestorHadFile ? { asymmetric: "kept-vs-delete" as const } : {}),
      });
      continue;
    }
    if (mineContent === undefined && theirsContent !== undefined) {
      mergedFiles.set(path, theirsContent);
      results.push({
        path,
        strategy,
        merged: true,
        content: theirsContent,
        ...(ancestorHadFile ? { asymmetric: "deleted-vs-kept" as const } : {}),
      });
      continue;
    }
    if (mineContent === undefined && theirsContent === undefined) {
      // Only ancestor had it; both sides agreed to delete. Drop it.
      continue;
    }

    // Both sides have the file. Compare against ancestor when available.
    if (ancestor && mineContent === ancestorContent) {
      // Mine unchanged from ancestor -> take theirs.
      mergedFiles.set(path, theirsContent!);
      results.push({ path, strategy, merged: true, content: theirsContent });
      continue;
    }
    if (ancestor && theirsContent === ancestorContent) {
      // Theirs unchanged -> take mine.
      mergedFiles.set(path, mineContent!);
      results.push({ path, strategy, merged: true, content: mineContent });
      continue;
    }
    if (mineContent === theirsContent) {
      // Convergent edit. Both sides agree.
      mergedFiles.set(path, mineContent!);
      results.push({ path, strategy, merged: true, content: mineContent });
      continue;
    }

    // Real conflict: both sides changed.
    const ancestorForMerge = ancestorContent ?? ""; // 2-way: empty ancestor
    const raw: RawThreeWay = { ancestor: ancestorForMerge, mine: mineContent!, theirs: theirsContent! };

    if (strategy === "manual") {
      results.push({ path, strategy, merged: false, raw });
      continue;
    }

    // strategy === llm: invoke (with one retry on transient failure).
    const llmResult = await runLlmWithRetry(llm, { path, ...raw });
    if ("merged" in llmResult) {
      // Normalize the SDK output. Inputs were canonical; the model
      // could have re-introduced harness syntax. Idempotent for
      // already-canonical text.
      const normalized = normalize({ body: llmResult.merged, supporting_files: [] }, harness).body;
      mergedFiles.set(path, normalized);
      results.push({ path, strategy, merged: true, content: normalized });
    } else {
      // Permanent LLM failure -> mark requires_manual with the error so
      // CLI can surface it. Other files in the same skill still get
      // their successful merges.
      results.push({ path, strategy, merged: false, raw, llm_error: llmResult.error });
    }
  }

  return assembleProposedMerge(mergedFiles, results, llmModel);
}

// ── helpers ───────────────────────────────────────────────────────────────

const BODY_KEY = "SKILL.md";

function bundleToMap(bundle: CanonicalBundle): Map<string, string> {
  const m = new Map<string, string>();
  m.set(BODY_KEY, bundle.body);
  for (const f of bundle.supporting_files) {
    // The body slot is reserved. A well-formed server roundtrip
    // never produces this shape (collectSupportingFiles skips
    // SKILL.md at the root, and skillhub/put normalizes body vs
    // supporting_files separately). Throwing here surfaces a
    // malformed wire response or buggy adapter loudly rather than
    // silently corrupting the merge.
    if (f.path === BODY_KEY) {
      throw new Error(
        `merge engine: supporting_files entry with path === '${BODY_KEY}' is reserved for the body slot. Refusing to overwrite. This indicates a malformed wire response or buggy adapter input.`,
      );
    }
    m.set(f.path, f.content);
  }
  return m;
}

function assembleProposedMerge(
  mergedFiles: Map<string, string>,
  results: PerFileResult[],
  llmModel: string,
): ProposedMerge {
  // Body comes from the SKILL.md slot. When SKILL.md ended up in
  // requires_manual it's not in mergedFiles - fall back to the raw
  // three-way's `mine` (the user's local body) so the CLI has a
  // sensible default to show; the per-file-result tells the CLI it
  // needs manual resolution.
  let body = mergedFiles.get(BODY_KEY);
  if (body === undefined) {
    const bodyResult = results.find((r) => r.path === BODY_KEY);
    body = bodyResult?.raw?.mine ?? "";
  }
  const supporting_files: SkillhubSupportingFile[] = [];
  // Deterministic order.
  const supportingPaths = [...mergedFiles.keys()].filter((k) => k !== BODY_KEY).sort();
  for (const path of supportingPaths) {
    supporting_files.push({ path, content: mergedFiles.get(path)! });
  }
  return { body, supporting_files, llm_model: llmModel, per_file_results: results };
}

async function runLlmWithRetry(llm: LlmMergeFn, input: LlmMergeInput): Promise<{ merged: string } | { error: string }> {
  const first = await safeCall(llm, input);
  if ("merged" in first && first.merged.trim().length > 0) return first;
  const second = await safeCall(llm, input);
  if ("merged" in second && second.merged.trim().length > 0) return second;
  // Both attempts failed. Prefer the more informative error message.
  if ("error" in second) return second;
  if ("error" in first) return first;
  return { error: "LLM returned empty content twice" };
}

async function safeCall(llm: LlmMergeFn, input: LlmMergeInput): Promise<{ merged: string } | { error: string }> {
  try {
    return await llm(input);
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Production SDK wrapper ────────────────────────────────────────────────

/**
 * Build the real LLM merge function backed by `@anthropic-ai/claude-agent-sdk`.
 *
 * `token` is supplied separately (we read process.env elsewhere via
 * the discovery module). The SDK has no per-call key-injection option,
 * so we MUTATE the relevant env var around each call (the one the SDK
 * reads natively for this token kind) and restore the previous value
 * in the `finally` block. `kind` selects the env var:
 *   - "api-key"      -> ANTHROPIC_API_KEY      (direct Anthropic API)
 *   - "oauth-token"  -> CLAUDE_CODE_OAUTH_TOKEN (Claude Code Max sub)
 *
 * **The returned function is SERIAL-ONLY.** Calling it concurrently
 * within the same process (e.g. `Promise.all` over a per-file array)
 * is unsafe: each call captures a `previous` env value other calls
 * may have already mutated, and the env's final state after all
 * calls complete could be wrong. Today's caller (`ark skills sync`
 * in C14) iterates skills + files serially, so the save / restore
 * dance is safe by construction. If a future change parallelizes
 * sync, switch this to a serialization mutex (~15 LoC) before
 * un-serializing the caller. See review.md / commit 13's notes.
 *
 * The cross-account billing scenario is unlikely to be observable in
 * practice: the Anthropic SDK typically caches the auth at construct
 * time, so the env mutation only affects which token the NEXT call
 * sees, not in-flight HTTP requests. The hazard is "env ends in the
 * wrong state after both calls complete," which is invisible for a
 * one-shot CLI that exits soon after.
 *
 * Caller's responsibility to have run `discoverAnthropicCredentials`
 * first and obtained a real credential.
 */
export function buildClaudeAgentMergeFn(
  token: string,
  kind: "api-key" | "oauth-token" = "api-key",
  model: string = DEFAULT_LLM_MODEL,
): LlmMergeFn {
  const envVar = kind === "oauth-token" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
  // The SDK reads both env vars; if both are set in the caller's
  // environment it applies an internal tiebreaker that may not match
  // the discovery layer's choice. To make the SDK see exactly the
  // credential discovery picked, clear the OTHER var around the call
  // (save + restore so the caller's env is untouched after we return).
  const otherVar = kind === "oauth-token" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN";
  return async (input: LlmMergeInput) => {
    const previousChosen = process.env[envVar];
    const previousOther = process.env[otherVar];
    process.env[envVar] = token;
    delete process.env[otherVar];
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const prompt = buildMergePrompt(input);
      const q = query({ prompt, options: { model } });
      for await (const msg of q as AsyncIterable<{ type: string; subtype?: string; result?: string }>) {
        if (msg.type !== "result") continue;
        if (msg.subtype === "success" && typeof msg.result === "string") {
          return { merged: stripWrapper(msg.result) };
        }
        return { error: `SDK returned non-success result: subtype=${msg.subtype ?? "unknown"}` };
      }
      return { error: "SDK stream ended without a result message" };
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (previousChosen === undefined) delete process.env[envVar];
      else process.env[envVar] = previousChosen;
      if (previousOther === undefined) delete process.env[otherVar];
      else process.env[otherVar] = previousOther;
    }
  };
}

function buildMergePrompt(input: LlmMergeInput): string {
  // A deliberately tight prompt: just the three-way merge task, no
  // tool use, no multi-turn. Return only the merged text - we strip
  // any wrapping fences after.
  return [
    `You are performing a three-way text merge on a skill file named '${input.path}'.`,
    "Three versions are provided: the common ancestor (the previous shared version), the local edits (mine), and the remote edits (theirs).",
    "Produce a single merged version that reconciles both sets of edits. Preserve every meaningful change from BOTH sides.",
    "Return only the merged file content. Do NOT include markdown code fences, explanations, or commentary.",
    "",
    "=== ANCESTOR ===",
    input.ancestor,
    "=== MINE ===",
    input.mine,
    "=== THEIRS ===",
    input.theirs,
    "=== MERGED ===",
  ].join("\n");
}

function stripWrapper(text: string): string {
  // Belt-and-suspenders: if the model returned a markdown code fence
  // despite the instruction, peel it off. Otherwise pass through.
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:[\w]+)?\n([\s\S]*?)\n```$/);
  if (fenceMatch) return fenceMatch[1];
  return text;
}
