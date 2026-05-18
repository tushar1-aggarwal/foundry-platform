/**
 * Claude adapter tests. Uses the RFC §13 worked example (code-review
 * skill) as the primary fixture so the test doubles as documentation of
 * the expected on-disk format.
 *
 * Coverage:
 *   - parse: required fields, harness-specific frontmatter routed into
 *     harnessHints.claude, supporting-files walk + sort + path
 *     normalization, missing/malformed input
 *   - render: universal frontmatter (name/description), harness-specific
 *     fields included, storage-only keys (original_body) excluded from
 *     output, body source selection (canonical vs original)
 *   - round-trip: render(canonical) -> write to tmpdir -> parse(tmpdir)
 *     reconstructs LocalSkill matching what came in (modulo server-only
 *     fields category/tags)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { claudeAdapter } from "../claude.js";
import type { CanonicalSkill, WrittenFile } from "../types.js";

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "skill-adapter-claude-"));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

// Materialize an array of WrittenFile into <skillRoot>/<rel> on disk.
function writeFiles(skillRoot: string, files: WrittenFile[]): void {
  for (const f of files) {
    const abs = join(skillRoot, f.relativePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
}

// RFC §13 worked example, trimmed to the fields the adapter touches.
function workedExampleCanonical(): CanonicalSkill {
  return {
    name: "code-review",
    description: "Reviews code changes for bugs, style, and best practices. Use when user says 'review my code'.",
    body: "# code-review\n\nReview the code changes in the current branch.\n\n## checks\n\n1. Bugs\n2. Style\n",
    supportingFiles: [
      { path: "references/severity-rubric.md", content: "# Severity rubric\n\n- **P0:** ...\n- **P1:** ...\n" },
    ],
    category: "review",
    tags: ["review", "quality"],
    harnessHints: {
      claude: {
        "disable-model-invocation": false,
        "allowed-tools": ["Bash(git *)"],
      },
      cursor: {},
      codex: {},
    },
  };
}

describe("claudeAdapter — identity + path helpers", () => {
  it("declares its harnessId and read/write paths", () => {
    expect(claudeAdapter.harnessId).toBe("claude");
    expect(claudeAdapter.readPaths("/repo")).toEqual(["/repo/.claude/skills"]);
    expect(claudeAdapter.defaultWritePath("/repo")).toBe("/repo/.claude/skills");
  });
});

describe("claudeAdapter — render", () => {
  it("emits universal + claude-specific frontmatter; excludes storage-only keys", () => {
    const canonical = workedExampleCanonical();
    const files = claudeAdapter.render(canonical);
    const skillMd = files.find((f) => f.relativePath === "SKILL.md");
    expect(skillMd).toBeDefined();
    const content = skillMd!.content;
    // Universal fields.
    expect(content).toMatch(/^---\nname: code-review\n/);
    expect(content).toContain("description:");
    // Claude-specific fields.
    expect(content).toContain("disable-model-invocation: false");
    expect(content).toContain("allowed-tools:");
    expect(content).toContain("Bash(git *)");
    // Body is included verbatim, after the frontmatter close.
    expect(content).toMatch(/---\n# code-review/);
  });

  it("includes supporting files as WrittenFile entries", () => {
    const canonical = workedExampleCanonical();
    const files = claudeAdapter.render(canonical);
    expect(files.find((f) => f.relativePath === "references/severity-rubric.md")?.content).toBe(
      "# Severity rubric\n\n- **P0:** ...\n- **P1:** ...\n",
    );
  });

  it("uses original_body when present (RFC §7 author-fidelity preservation)", () => {
    const canonical = workedExampleCanonical();
    // Simulate: server stored canonical = normalized body, but the
    // author originally wrote $ARGUMENTS[0] which got rewritten by the
    // normalizer. The raw form is preserved under harnessHints.claude.
    canonical.body = "Run <the first argument>.";
    canonical.harnessHints.claude = {
      ...canonical.harnessHints.claude,
      original_body: "Run $ARGUMENTS[0].",
    };
    const files = claudeAdapter.render(canonical);
    const skillMd = files.find((f) => f.relativePath === "SKILL.md")!.content;
    // Author sees what they wrote, not the canonical form.
    expect(skillMd).toContain("Run $ARGUMENTS[0].");
    expect(skillMd).not.toContain("Run <the first argument>.");
    // And original_body must NOT appear as a frontmatter key.
    expect(skillMd).not.toContain("original_body:");
  });

  it("uses original_supporting_files when present", () => {
    const canonical = workedExampleCanonical();
    canonical.supportingFiles = [{ path: "refs/spec.md", content: "canonical" }];
    canonical.harnessHints.claude = {
      ...canonical.harnessHints.claude,
      original_supporting_files: [{ path: "refs/spec.md", content: "raw author content" }],
    };
    const files = claudeAdapter.render(canonical);
    const spec = files.find((f) => f.relativePath === "refs/spec.md");
    expect(spec?.content).toBe("raw author content");
  });
});

describe("claudeAdapter — parse", () => {
  it("extracts name/description; routes harness-specific keys into harnessHints.claude", () => {
    writeFiles(scratchDir, [
      {
        relativePath: "SKILL.md",
        content:
          `---\nname: code-review\ndescription: Reviews code.\n` +
          `disable-model-invocation: false\nallowed-tools:\n  - Bash(git *)\n---\n` +
          `# code-review\n\nbody here.\n`,
      },
    ]);
    const local = claudeAdapter.parse(scratchDir);
    expect(local.name).toBe("code-review");
    expect(local.description).toBe("Reviews code.");
    expect(local.body).toBe("# code-review\n\nbody here.\n");
    expect(local.harnessHints.claude).toMatchObject({
      "disable-model-invocation": false,
      "allowed-tools": ["Bash(git *)"],
    });
    // category/tags are not in frontmatter; parse fills defaults.
    expect(local.category).toBeNull();
    expect(local.tags).toEqual([]);
  });

  it("walks supporting files recursively, sorts by path, skips hidden + SKILL.md", () => {
    writeFiles(scratchDir, [
      { relativePath: "SKILL.md", content: "---\nname: x\ndescription: y\n---\nbody\n" },
      { relativePath: "scripts/run.py", content: "print('ok')\n" },
      { relativePath: "references/spec.md", content: "spec\n" },
      { relativePath: "assets/logo.txt", content: "logo\n" },
    ]);
    // .git-style hidden file that should be ignored.
    writeFileSync(join(scratchDir, ".DS_Store"), "junk");

    const local = claudeAdapter.parse(scratchDir);
    expect(local.supportingFiles.map((f) => f.path)).toEqual([
      "assets/logo.txt",
      "references/spec.md",
      "scripts/run.py",
    ]);
    expect(local.supportingFiles.find((f) => f.path === "scripts/run.py")?.content).toBe("print('ok')\n");
  });

  it("throws when SKILL.md is missing", () => {
    expect(() => claudeAdapter.parse(scratchDir)).toThrow(/SKILL\.md not found/);
  });

  it("throws when required frontmatter fields are missing", () => {
    writeFiles(scratchDir, [{ relativePath: "SKILL.md", content: "---\nname: x\n---\nbody\n" }]);
    expect(() => claudeAdapter.parse(scratchDir)).toThrow(/missing.*description/);
  });

  it("rejects a file without frontmatter (no name field can be extracted)", () => {
    // Defensive: when the file doesn't start with --- AND doesn't look
    // like a YAML key-value, we don't try to be clever. parseFrontmatter
    // returns {meta:{}, body:raw} so no user content is lost; the
    // required-name check then fails loudly so the CLI can surface the
    // format problem.
    writeFiles(scratchDir, [{ relativePath: "SKILL.md", content: "no frontmatter here\n" }]);
    expect(() => claudeAdapter.parse(scratchDir)).toThrow(/missing the required 'name'/);
  });

  it("emits a targeted error when the file LOOKS like YAML but the `---` markers are missing", () => {
    // Common new-user mistake: write `name: x\ndescription: y\n...`
    // without the `---` open/close markers. Pre-fix, the user saw the
    // generic "missing the required 'name' frontmatter field" error
    // and couldn't figure out their `name:` line was being treated as
    // body. The heuristic detects the YAML-shaped first line and
    // surfaces the actual fix (add `---` markers).
    writeFiles(scratchDir, [
      {
        relativePath: "SKILL.md",
        content: "name: code-review\ndescription: reviews code\nprompt: |\n  do the thing\n",
      },
    ]);
    expect(() => claudeAdapter.parse(scratchDir)).toThrow(/`---` markers are missing/);
  });

  it("emits a targeted error when the opening `---` is present but no closing `---`", () => {
    // The author started the frontmatter block but forgot to close it.
    // Pre-fix, parseFrontmatter returned the whole-file-as-body, which
    // then surfaced as a confusing missing-name error. Now we throw a
    // direct hint pointing at the missing closing marker.
    writeFiles(scratchDir, [
      {
        relativePath: "SKILL.md",
        content: "---\nname: forgot-to-close\ndescription: oops\n\nthis is supposed to be the body\n",
      },
    ]);
    expect(() => claudeAdapter.parse(scratchDir)).toThrow(/no closing `---`/);
  });

  it("accepts CRLF line endings (Windows-authored SKILL.md)", () => {
    // Pre-fix: a Windows-authored SKILL.md with CRLF line endings
    // ("---\r\n") failed the startsWith("---\n") check, frontmatter
    // was treated as body, and the user got a confusing "missing
    // required 'name'" error rather than a signal that line endings
    // tripped the parse. Normalizer now strips CRLF up-front.
    const crlf =
      "---\r\nname: windows-skill\r\ndescription: authored on windows\r\n---\r\nbody line one\r\nbody line two\r\n";
    writeFiles(scratchDir, [{ relativePath: "SKILL.md", content: crlf }]);
    const local = claudeAdapter.parse(scratchDir);
    expect(local.name).toBe("windows-skill");
    expect(local.description).toBe("authored on windows");
    expect(local.body).toBe("body line one\nbody line two\n");
  });

  it("drops hand-authored storage-only keys (original_body, original_supporting_files)", () => {
    // Symmetric with render(): a hostile / hand-edited SKILL.md could
    // declare original_body: <anything>, which on round-trip through
    // skillhub/put would hijack what every future render emits for
    // anyone synced to this skill. Parse must filter the storage-only
    // keys, not just render.
    writeFiles(scratchDir, [
      {
        relativePath: "SKILL.md",
        content:
          `---\nname: hostile\ndescription: trying to poison the round-trip\n` +
          `original_body: malicious content\noriginal_supporting_files:\n  - path: a\n    content: b\n` +
          `disable-model-invocation: false\n---\nthe real body\n`,
      },
    ]);
    const local = claudeAdapter.parse(scratchDir);
    // Legitimate harness-specific key passes through.
    expect(local.harnessHints.claude["disable-model-invocation"]).toBe(false);
    // Storage-only keys are dropped.
    expect(local.harnessHints.claude.original_body).toBeUndefined();
    expect(local.harnessHints.claude.original_supporting_files).toBeUndefined();
  });

  it("wraps malformed YAML errors with the source path for traceability", () => {
    writeFiles(scratchDir, [
      // Unclosed quote -> yaml library throws YAMLException.
      { relativePath: "SKILL.md", content: `---\nname: x\ndescription: "unclosed\n---\nbody\n` },
    ]);
    expect(() => claudeAdapter.parse(scratchDir)).toThrow(/malformed YAML frontmatter in/);
    expect(() => claudeAdapter.parse(scratchDir)).toThrow(/SKILL\.md/);
  });

  it("rejects symlinks inside the skill directory (prevents data exfiltration)", () => {
    // The classic attack: a malicious skill dir contains a supporting
    // file that's actually a symlink to ~/.ssh/id_rsa. Without
    // protection, the unwitting teammate running `ark skills put`
    // exfiltrates their own private key to the server, where it
    // surfaces to anyone who can read the skill.
    writeFiles(scratchDir, [{ relativePath: "SKILL.md", content: "---\nname: x\ndescription: y\n---\nbody\n" }]);
    // Drop a real "secret" outside the skill dir and link to it from
    // inside.
    const secret = join(scratchDir, "..", "secret-outside-skill.txt");
    writeFileSync(secret, "shhhh\n");
    symlinkSync(secret, join(scratchDir, "exfil-link.txt"));

    expect(() => claudeAdapter.parse(scratchDir)).toThrow(/symlinks in skill directories are not supported/);
  });
});

describe("claudeAdapter — round-trip", () => {
  it("render -> write -> parse reconstructs the LocalSkill (modulo server-only fields)", () => {
    const canonical = workedExampleCanonical();
    const files = claudeAdapter.render(canonical);
    writeFiles(scratchDir, files);
    const local = claudeAdapter.parse(scratchDir);

    expect(local.name).toBe(canonical.name);
    expect(local.description).toBe(canonical.description);
    expect(local.body).toBe(canonical.body);
    expect(local.supportingFiles).toEqual(canonical.supportingFiles);
    // Claude-specific fields survive the round trip.
    expect(local.harnessHints.claude).toMatchObject({
      "disable-model-invocation": false,
      "allowed-tools": ["Bash(git *)"],
    });
    // category/tags are server-side; parse legitimately returns defaults.
    expect(local.category).toBeNull();
    expect(local.tags).toEqual([]);
  });

  it("round-trip is idempotent: re-render(parsed) produces byte-identical SKILL.md", () => {
    const canonical = workedExampleCanonical();
    const firstRender = claudeAdapter.render(canonical);
    writeFiles(scratchDir, firstRender);
    const local = claudeAdapter.parse(scratchDir);
    // Reconstruct a canonical from the parsed local + the server-side
    // fields we know live elsewhere.
    const reconstructed: CanonicalSkill = {
      ...canonical,
      body: local.body,
      supportingFiles: local.supportingFiles,
      harnessHints: { ...canonical.harnessHints, claude: local.harnessHints.claude },
    };
    const secondRender = claudeAdapter.render(reconstructed);
    expect(secondRender).toEqual(firstRender);
  });
});
