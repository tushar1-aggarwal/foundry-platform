/**
 * Tests for the client-side 3-way merge engine.
 *
 * The LLM is injected as a function, so every test passes a
 * deterministic stub - no network, no SDK boot, no flakiness.
 *
 * Coverage:
 *   - fileStrategy: extension table + per-file overrides
 *   - clientSideMerge:
 *     - file unchanged in one side -> take other side
 *     - convergent edit (both sides equal) -> take it
 *     - both changed + llm strategy -> calls llm, normalizes output
 *     - both changed + manual strategy -> requires_manual + raw three-way
 *     - llm error + retry -> recovers
 *     - llm permanently failing -> requires_manual + error captured
 *     - 2-way merge (no ancestor) -> every shared file goes to merge
 *     - asymmetric presence: added in mine only / theirs only
 *     - SKILL.md treated as a file too
 *     - strategy overrides flip the default
 */

import { describe, expect, it, mock } from "bun:test";
import {
  DEFAULT_LLM_MODEL,
  MARKDOWN_EXTENSIONS,
  clientSideMerge,
  fileStrategy,
  type CanonicalBundle,
  type LlmMergeFn,
} from "../skills/merge.js";

const ALWAYS_FAIL_LLM: LlmMergeFn = async () => ({ error: "stub: always fails" });
const NEVER_CALLED_LLM: LlmMergeFn = async () => {
  throw new Error("LLM should not have been invoked");
};

describe("fileStrategy", () => {
  it("returns llm for markdown-like extensions", () => {
    expect(fileStrategy("SKILL.md")).toBe("llm");
    expect(fileStrategy("references/spec.md")).toBe("llm");
    expect(fileStrategy("README.txt")).toBe("llm");
    expect(fileStrategy("notes.rst")).toBe("llm");
  });

  it("returns manual for code / config / asset extensions", () => {
    expect(fileStrategy("scripts/run.py")).toBe("manual");
    expect(fileStrategy("config.json")).toBe("manual");
    expect(fileStrategy("data.yaml")).toBe("manual");
    expect(fileStrategy("Makefile")).toBe("manual"); // no extension at all
    expect(fileStrategy("logo.png")).toBe("manual");
  });

  it("respects override over extension", () => {
    expect(fileStrategy("scripts/safe.py", "llm")).toBe("llm");
    expect(fileStrategy("README.md", "manual")).toBe("manual");
  });

  it("documents the markdown set explicitly (regression guard if someone changes it)", () => {
    expect([...MARKDOWN_EXTENSIONS].sort()).toEqual([".md", ".rst", ".txt"]);
  });
});

// ── clientSideMerge helpers ──────────────────────────────────────────────

const ancestorBundle: CanonicalBundle = {
  body: "# code-review\n\noriginal body\n",
  supporting_files: [
    { path: "refs/spec.md", content: "original spec\n" },
    { path: "scripts/run.py", content: "print('original')\n" },
  ],
};

describe("clientSideMerge — no-op outcomes (one side unchanged from ancestor)", () => {
  it("takes theirs when mine === ancestor", async () => {
    const mine = ancestorBundle;
    const theirs: CanonicalBundle = {
      ...ancestorBundle,
      body: "# code-review\n\nbody edited on the server\n",
    };
    const result = await clientSideMerge({
      mine,
      theirs,
      ancestor: ancestorBundle,
      harness: "claude",
      llm: NEVER_CALLED_LLM, // SKILL.md should NOT trigger the LLM here
    });
    expect(result.body).toBe(theirs.body);
    expect(result.per_file_results.find((r) => r.path === "SKILL.md")?.merged).toBe(true);
  });

  it("takes mine when theirs === ancestor", async () => {
    const mine: CanonicalBundle = { ...ancestorBundle, body: "# code-review\n\nbody edited locally\n" };
    const theirs = ancestorBundle;
    const result = await clientSideMerge({
      mine,
      theirs,
      ancestor: ancestorBundle,
      harness: "claude",
      llm: NEVER_CALLED_LLM,
    });
    expect(result.body).toBe(mine.body);
  });

  it("convergent edit (both sides agree, diverging from ancestor) takes either side without calling LLM", async () => {
    const mine: CanonicalBundle = { ...ancestorBundle, body: "# code-review\n\nshared rewrite\n" };
    const theirs: CanonicalBundle = { ...ancestorBundle, body: "# code-review\n\nshared rewrite\n" };
    const result = await clientSideMerge({
      mine,
      theirs,
      ancestor: ancestorBundle,
      harness: "claude",
      llm: NEVER_CALLED_LLM,
    });
    expect(result.body).toBe("# code-review\n\nshared rewrite\n");
  });
});

describe("clientSideMerge — real conflicts", () => {
  it("calls LLM for markdown files when both sides changed", async () => {
    const llm = mock<LlmMergeFn>(async (input) => ({
      merged: `MERGED(${input.path}): ${input.mine} | ${input.theirs}`,
    }));
    const mine: CanonicalBundle = { body: "mine body", supporting_files: ancestorBundle.supporting_files };
    const theirs: CanonicalBundle = { body: "theirs body", supporting_files: ancestorBundle.supporting_files };
    const result = await clientSideMerge({
      mine,
      theirs,
      ancestor: ancestorBundle,
      harness: "claude",
      llm,
    });
    expect(llm).toHaveBeenCalledTimes(1);
    const skillFile = result.per_file_results.find((r) => r.path === "SKILL.md");
    expect(skillFile?.strategy).toBe("llm");
    expect(skillFile?.merged).toBe(true);
    expect(result.body).toContain("MERGED(SKILL.md)");
  });

  it("does NOT call LLM for non-markdown files; marks requires_manual with raw three-way", async () => {
    const llm = mock<LlmMergeFn>(async () => ({ merged: "should not be used" }));
    const mine: CanonicalBundle = {
      body: ancestorBundle.body,
      supporting_files: [
        ancestorBundle.supporting_files[0], // unchanged
        { path: "scripts/run.py", content: "print('mine edit')\n" },
      ],
    };
    const theirs: CanonicalBundle = {
      body: ancestorBundle.body,
      supporting_files: [
        ancestorBundle.supporting_files[0], // unchanged
        { path: "scripts/run.py", content: "print('theirs edit')\n" },
      ],
    };
    const result = await clientSideMerge({
      mine,
      theirs,
      ancestor: ancestorBundle,
      harness: "claude",
      llm,
    });
    const py = result.per_file_results.find((r) => r.path === "scripts/run.py");
    expect(py?.strategy).toBe("manual");
    expect(py?.merged).toBe(false);
    expect(py?.raw).toEqual({
      ancestor: "print('original')\n",
      mine: "print('mine edit')\n",
      theirs: "print('theirs edit')\n",
    });
    expect(llm).toHaveBeenCalledTimes(0);
  });

  it("retries once on LLM error, recovers on the second attempt", async () => {
    let calls = 0;
    const llm: LlmMergeFn = async () => {
      calls += 1;
      if (calls === 1) return { error: "transient failure" };
      return { merged: "second-try merged" };
    };
    const mine: CanonicalBundle = { body: "mine", supporting_files: [] };
    const theirs: CanonicalBundle = { body: "theirs", supporting_files: [] };
    const result = await clientSideMerge({
      mine,
      theirs,
      ancestor: { body: "ancestor", supporting_files: [] },
      harness: "claude",
      llm,
    });
    expect(calls).toBe(2);
    expect(result.body).toBe("second-try merged");
    expect(result.per_file_results[0].merged).toBe(true);
  });

  it("marks requires_manual + captures llm_error when both LLM attempts fail", async () => {
    const llm: LlmMergeFn = async () => ({ error: "permanent failure" });
    const mine: CanonicalBundle = { body: "mine", supporting_files: [] };
    const theirs: CanonicalBundle = { body: "theirs", supporting_files: [] };
    const result = await clientSideMerge({
      mine,
      theirs,
      ancestor: { body: "ancestor", supporting_files: [] },
      harness: "claude",
      llm,
    });
    const r = result.per_file_results[0];
    expect(r.merged).toBe(false);
    expect(r.strategy).toBe("llm");
    expect(r.llm_error).toContain("permanent failure");
    expect(r.raw).toEqual({ ancestor: "ancestor", mine: "mine", theirs: "theirs" });
  });

  it("LLM returning an empty string twice triggers requires_manual fallback (empty is treated as failure)", async () => {
    const llm: LlmMergeFn = async () => ({ merged: "   \n" });
    const mine: CanonicalBundle = { body: "mine", supporting_files: [] };
    const theirs: CanonicalBundle = { body: "theirs", supporting_files: [] };
    const result = await clientSideMerge({
      mine,
      theirs,
      ancestor: { body: "ancestor", supporting_files: [] },
      harness: "claude",
      llm,
    });
    expect(result.per_file_results[0].merged).toBe(false);
  });

  it("normalizes LLM output via the shared normalizer (claude $ARGUMENTS[0] -> canonical)", async () => {
    // The model returned text that includes Claude's $ARGUMENTS[0]
    // syntax. The normalizer rewrites this to <the first argument>
    // BEFORE we accept it as proposed_merge.body, so the next
    // sync_status doesn't see a spurious diff.
    const llm: LlmMergeFn = async () => ({ merged: "Run $ARGUMENTS[0] and report." });
    const mine: CanonicalBundle = { body: "mine", supporting_files: [] };
    const theirs: CanonicalBundle = { body: "theirs", supporting_files: [] };
    const result = await clientSideMerge({
      mine,
      theirs,
      ancestor: { body: "ancestor", supporting_files: [] },
      harness: "claude",
      llm,
    });
    expect(result.body).toBe("Run <the first argument> and report.");
  });
});

describe("clientSideMerge — strategy overrides + 2-way merges", () => {
  it("applies a path-specific override to flip a .py file from manual to llm", async () => {
    const llm = mock<LlmMergeFn>(async () => ({ merged: "merged via override" }));
    const mine: CanonicalBundle = {
      body: ancestorBundle.body,
      supporting_files: [ancestorBundle.supporting_files[0], { path: "scripts/run.py", content: "mine\n" }],
    };
    const theirs: CanonicalBundle = {
      body: ancestorBundle.body,
      supporting_files: [ancestorBundle.supporting_files[0], { path: "scripts/run.py", content: "theirs\n" }],
    };
    const result = await clientSideMerge({
      mine,
      theirs,
      ancestor: ancestorBundle,
      harness: "claude",
      llm,
      strategyOverrides: { "scripts/run.py": "llm" },
    });
    expect(llm).toHaveBeenCalledTimes(1);
    const py = result.per_file_results.find((r) => r.path === "scripts/run.py");
    expect(py?.strategy).toBe("llm");
    expect(py?.merged).toBe(true);
  });

  it("2-way merge (ancestor=null) routes shared-file conflicts to the same llm/manual fork", async () => {
    // Without an ancestor we can't detect "unchanged on one side";
    // every file that exists in both mine and theirs goes through
    // the strategy table. Markdown -> LLM, scripts -> manual.
    const llm = mock<LlmMergeFn>(async () => ({ merged: "2-way merged body" }));
    const mine: CanonicalBundle = {
      body: "mine body",
      supporting_files: [{ path: "scripts/run.py", content: "mine py\n" }],
    };
    const theirs: CanonicalBundle = {
      body: "theirs body",
      supporting_files: [{ path: "scripts/run.py", content: "theirs py\n" }],
    };
    const result = await clientSideMerge({ mine, theirs, ancestor: null, harness: "claude", llm });
    expect(llm).toHaveBeenCalledTimes(1); // only SKILL.md (.py is manual)
    const body = result.per_file_results.find((r) => r.path === "SKILL.md");
    expect(body?.merged).toBe(true);
    const py = result.per_file_results.find((r) => r.path === "scripts/run.py");
    expect(py?.merged).toBe(false);
    expect(py?.raw?.ancestor).toBe(""); // 2-way uses "" as ancestor
  });
});

describe("clientSideMerge — asymmetric file presence", () => {
  it("file only in mine (added locally, never in ancestor) is kept WITHOUT asymmetric signal", async () => {
    // Distinguishes "alice newly added refs/new-local.md" from
    // "theirs deleted an existing file." Only the latter warrants
    // a warning to the user.
    const mine: CanonicalBundle = {
      body: ancestorBundle.body,
      supporting_files: [
        ...ancestorBundle.supporting_files,
        { path: "refs/new-local.md", content: "fresh local doc\n" },
      ],
    };
    const result = await clientSideMerge({
      mine,
      theirs: ancestorBundle,
      ancestor: ancestorBundle,
      harness: "claude",
      llm: NEVER_CALLED_LLM,
    });
    const file = result.supporting_files.find((f) => f.path === "refs/new-local.md");
    expect(file?.content).toBe("fresh local doc\n");
    const r = result.per_file_results.find((x) => x.path === "refs/new-local.md");
    expect(r?.asymmetric).toBeUndefined();
  });

  it("file only in theirs (added on server, never in ancestor) is kept WITHOUT asymmetric signal", async () => {
    const theirs: CanonicalBundle = {
      body: ancestorBundle.body,
      supporting_files: [
        ...ancestorBundle.supporting_files,
        { path: "refs/new-server.md", content: "fresh server doc\n" },
      ],
    };
    const result = await clientSideMerge({
      mine: ancestorBundle,
      theirs,
      ancestor: ancestorBundle,
      harness: "claude",
      llm: NEVER_CALLED_LLM,
    });
    const file = result.supporting_files.find((f) => f.path === "refs/new-server.md");
    expect(file?.content).toBe("fresh server doc\n");
    const r = result.per_file_results.find((x) => x.path === "refs/new-server.md");
    expect(r?.asymmetric).toBeUndefined();
  });

  it("file only in ancestor (deleted on both sides) is dropped", async () => {
    const ancestor: CanonicalBundle = {
      body: "body",
      supporting_files: [{ path: "deleted.md", content: "doomed\n" }],
    };
    const mine: CanonicalBundle = { body: "body", supporting_files: [] };
    const theirs: CanonicalBundle = { body: "body", supporting_files: [] };
    const result = await clientSideMerge({ mine, theirs, ancestor, harness: "claude", llm: ALWAYS_FAIL_LLM });
    expect(result.supporting_files.find((f) => f.path === "deleted.md")).toBeUndefined();
  });
});

describe("clientSideMerge — malformed input guards", () => {
  it("throws when supporting_files contains an entry with path === 'SKILL.md' (body slot is reserved)", async () => {
    // Well-formed wire responses never produce this - the server-
    // side normalizer routes the body separately. But the merge
    // engine is the defense boundary for malformed responses /
    // buggy adapters; silent overwrite of the body slot would
    // corrupt the merge with no warning.
    const malformed: CanonicalBundle = {
      body: "real body",
      supporting_files: [{ path: "SKILL.md", content: "hijack attempt" }],
    };
    await expect(
      clientSideMerge({
        mine: malformed,
        theirs: ancestorBundle,
        ancestor: ancestorBundle,
        harness: "claude",
        llm: NEVER_CALLED_LLM,
      }),
    ).rejects.toThrow(/reserved for the body slot/);
  });
});

describe("clientSideMerge — modify/delete conflicts (asymmetric signal)", () => {
  it("kept-vs-delete: mine kept the file, theirs deleted it, ancestor had it -> resolves to mine + asymmetric signal", async () => {
    // The dangerous case: theirs deleted scripts/run.py intentionally
    // (security issue, deprecated feature), the user's local edit
    // silently survives. v1 keeps mine but emits the `asymmetric`
    // signal so the CLI can warn the user they're potentially
    // restoring an intentional server-side delete.
    const ancestor: CanonicalBundle = {
      body: "body",
      supporting_files: [{ path: "scripts/run.py", content: "print('original')\n" }],
    };
    const mine: CanonicalBundle = {
      body: "body",
      supporting_files: [{ path: "scripts/run.py", content: "print('mine edited')\n" }],
    };
    const theirs: CanonicalBundle = { body: "body", supporting_files: [] };
    const result = await clientSideMerge({ mine, theirs, ancestor, harness: "claude", llm: NEVER_CALLED_LLM });
    const py = result.per_file_results.find((r) => r.path === "scripts/run.py");
    expect(py?.merged).toBe(true);
    expect(py?.content).toBe("print('mine edited')\n");
    expect(py?.asymmetric).toBe("kept-vs-delete");
  });

  it("deleted-vs-kept: mine deleted the file, theirs kept it, ancestor had it -> resolves to theirs + asymmetric signal", async () => {
    // The mirror failure mode: alice deletes scripts/dangerous.py
    // locally for a reason, theirs's version reappears post-sync,
    // alice's intentional delete is silently overridden. Symmetric
    // signal so the CLI can warn.
    const ancestor: CanonicalBundle = {
      body: "body",
      supporting_files: [{ path: "scripts/dangerous.py", content: "exec(input())\n" }],
    };
    const mine: CanonicalBundle = { body: "body", supporting_files: [] };
    const theirs: CanonicalBundle = {
      body: "body",
      supporting_files: [{ path: "scripts/dangerous.py", content: "exec(input())\n" }],
    };
    const result = await clientSideMerge({ mine, theirs, ancestor, harness: "claude", llm: NEVER_CALLED_LLM });
    const py = result.per_file_results.find((r) => r.path === "scripts/dangerous.py");
    expect(py?.merged).toBe(true);
    expect(py?.content).toBe("exec(input())\n");
    expect(py?.asymmetric).toBe("deleted-vs-kept");
  });
});

describe("clientSideMerge — assembled output", () => {
  it("labels llm_model in the proposed_merge (default + override)", async () => {
    const r1 = await clientSideMerge({
      mine: ancestorBundle,
      theirs: ancestorBundle,
      ancestor: ancestorBundle,
      harness: "claude",
      llm: NEVER_CALLED_LLM,
    });
    expect(r1.llm_model).toBe(DEFAULT_LLM_MODEL);

    const r2 = await clientSideMerge({
      mine: ancestorBundle,
      theirs: ancestorBundle,
      ancestor: ancestorBundle,
      harness: "claude",
      llm: NEVER_CALLED_LLM,
      llmModel: "test-model-id",
    });
    expect(r2.llm_model).toBe("test-model-id");
  });

  it("returns supporting files in sorted-path order", async () => {
    const mine: CanonicalBundle = {
      body: "body",
      supporting_files: [
        { path: "z-last.md", content: "z\n" },
        { path: "a-first.md", content: "a\n" },
        { path: "m-middle.md", content: "m\n" },
      ],
    };
    const result = await clientSideMerge({
      mine,
      theirs: mine,
      ancestor: mine,
      harness: "claude",
      llm: NEVER_CALLED_LLM,
    });
    expect(result.supporting_files.map((f) => f.path)).toEqual(["a-first.md", "m-middle.md", "z-last.md"]);
  });
});
