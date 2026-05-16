/**
 * Tests for `ark skills` command surface.
 *
 * v1 scope: the pure pieces - path-to-harness inference and registration
 * smoke. End-to-end command execution (which would require booting a
 * full conductor + daemon for each test) is deferred to the integration
 * test pass (RFC §11 step 25).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  assertSkillDirNameMatchesFrontmatter,
  buildPutParams,
  findLocalSkillBundles,
  inferHarnessFromPath,
  registerSkillsCommands,
} from "../commands/skills.js";
import type { LocalSkill } from "../../skill-adapters/index.js";

const baseLocal: LocalSkill = {
  name: "code-review",
  description: "Review code changes for bugs and style.",
  body: "# code-review\n\nLook for the things.\n",
  supportingFiles: [{ path: "refs/spec.md", content: "spec\n" }],
  category: null,
  tags: [],
  harnessHints: { claude: { "disable-model-invocation": false } },
};

describe("inferHarnessFromPath", () => {
  const repoRoot = "/repo";

  it("infers 'claude' from a .claude/skills/<name> path", () => {
    expect(inferHarnessFromPath(".claude/skills/code-review", repoRoot)).toBe("claude");
  });

  it("infers 'cursor' from a .cursor/skills/<name> path", () => {
    expect(inferHarnessFromPath(".cursor/skills/deploy", repoRoot)).toBe("cursor");
  });

  it("infers 'codex' from a .codex/skills/<name> path", () => {
    expect(inferHarnessFromPath(".codex/skills/security", repoRoot)).toBe("codex");
  });

  it("infers 'codex' from a .agents/skills/<name> path (universal Agent Skills convention)", () => {
    expect(inferHarnessFromPath(".agents/skills/format", repoRoot)).toBe("codex");
  });

  it("accepts absolute paths", () => {
    expect(inferHarnessFromPath(join(repoRoot, ".claude", "skills", "x"), repoRoot)).toBe("claude");
  });

  it("throws when no adapter's read paths contain the input", () => {
    expect(() => inferHarnessFromPath(".unknown/skills/x", repoRoot)).toThrow(/could not infer harness/);
    expect(() => inferHarnessFromPath(".unknown/skills/x", repoRoot)).toThrow(/--harness/);
  });

  it("guards against prefix-overlap (.claudemate/skills should NOT match .claude/skills)", () => {
    // `.claude/skills`-prefix without a separator would otherwise
    // incorrectly accept a directory whose name BEGINS with `.claude`
    // - e.g. a hypothetical sibling tool `.claudemate/`. The
    // implementation appends a separator before the prefix check.
    expect(() => inferHarnessFromPath(".claudemate/skills/x", repoRoot)).toThrow(/could not infer/);
  });
});

describe("buildPutParams — create mode (no sidecar)", () => {
  it("defaults visibility to 'user' and uses local skill name + description", () => {
    const r = buildPutParams({
      local: baseLocal,
      harness: "claude",
      sidecar: null,
      opts: { tag: [] },
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.params.visibility).toBe("user");
    expect(r.params.name).toBe("code-review");
    expect(r.params.description).toBe("Review code changes for bugs and style.");
    expect(r.params.skill_id).toBeUndefined();
    expect(r.params.expected_current_hash).toBeUndefined();
    expect(r.params.harness).toBe("claude");
    expect(r.params.body).toBe(baseLocal.body);
    expect(r.params.supporting_files).toEqual(baseLocal.supportingFiles);
    expect(r.params.harness_hints).toEqual(baseLocal.harnessHints);
  });

  it("accepts --visibility team with --team", () => {
    const r = buildPutParams({
      local: baseLocal,
      harness: "claude",
      sidecar: null,
      opts: { visibility: "team", team: "team-eng-123", tag: [] },
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.params.visibility).toBe("team");
    expect(r.params.team_id).toBe("team-eng-123");
  });

  it("rejects --visibility team without --team", () => {
    const r = buildPutParams({
      local: baseLocal,
      harness: "claude",
      sidecar: null,
      opts: { visibility: "team", tag: [] },
    });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/--team <id> is required/);
  });

  it("rejects --visibility cross_tenant (system-admin only, not creatable in v1)", () => {
    const r = buildPutParams({
      local: baseLocal,
      harness: "claude",
      sidecar: null,
      opts: { visibility: "cross_tenant", tag: [] },
    });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/cross_tenant is reserved/);
  });

  it("rejects unknown --visibility values", () => {
    const r = buildPutParams({
      local: baseLocal,
      harness: "claude",
      sidecar: null,
      opts: { visibility: "everyone", tag: [] },
    });
    expect("error" in r).toBe(true);
  });

  it("forwards --tag (repeatable) and --category", () => {
    const r = buildPutParams({
      local: baseLocal,
      harness: "claude",
      sidecar: null,
      opts: { tag: ["a", "b", "c"], category: "review" },
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.params.tags).toEqual(["a", "b", "c"]);
    expect(r.params.category).toBe("review");
  });
});

describe("buildPutParams — update mode (sidecar present)", () => {
  const sidecar = { skill_id: "skl-abc123", current_hash: "sha256-old" };

  it("uses sidecar.skill_id + sidecar.current_hash as the CAS handshake", () => {
    const r = buildPutParams({ local: baseLocal, harness: "claude", sidecar, opts: { tag: [] } });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.params.skill_id).toBe("skl-abc123");
    expect(r.params.expected_current_hash).toBe("sha256-old");
    expect(r.params.visibility).toBeUndefined(); // never set in update mode
  });

  it("sends body, supporting_files, AND description on update so local edits propagate (description-update bug fix)", () => {
    // The reviewer-caught bug: previously, description was sent only
    // in create mode, so editing the SKILL.md frontmatter description
    // and running `ark skills put` would silently leave the server
    // value stale. Body / supporting_files had no such asymmetry.
    const edited: LocalSkill = { ...baseLocal, description: "NEW description from frontmatter edit" };
    const r = buildPutParams({ local: edited, harness: "claude", sidecar, opts: { tag: [] } });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.params.description).toBe("NEW description from frontmatter edit");
  });

  it("--description flag wins over the local frontmatter on update", () => {
    const r = buildPutParams({
      local: baseLocal,
      harness: "claude",
      sidecar,
      opts: { description: "flag override", tag: [] },
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.params.description).toBe("flag override");
  });

  it("--force omits expected_current_hash so the server's CAS doesn't fire", () => {
    const r = buildPutParams({
      local: baseLocal,
      harness: "claude",
      sidecar,
      opts: { force: true, tag: [] },
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.params.expected_current_hash).toBeUndefined();
    expect(r.params.force).toBe(true);
  });

  it("rejects --visibility on update (v1 limitation per RFC §5)", () => {
    const r = buildPutParams({
      local: baseLocal,
      harness: "claude",
      sidecar,
      opts: { visibility: "tenant", tag: [] },
    });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/cannot change visibility on update/);
  });
});

describe("registerSkillsCommands", () => {
  it("registers a 'skills' command group with the full v1 subcommand surface", () => {
    const program = new Command();
    registerSkillsCommands(program);
    const skills = program.commands.find((c) => c.name() === "skills");
    expect(skills).toBeDefined();
    const subNames = skills!.commands.map((c) => c.name()).sort();
    expect(subNames).toEqual(["delete", "get", "install", "list", "put", "search", "sync"]);
  });

  it("'sync' subcommand declares --harness, --dry-run, and --no-merge", () => {
    const program = new Command();
    registerSkillsCommands(program);
    const sync = program.commands.find((c) => c.name() === "skills")?.commands.find((c) => c.name() === "sync");
    expect(sync).toBeDefined();
    const optNames = sync!.options.map((o) => o.long).sort();
    // commander's `--no-merge` flag exposes as `--merge` with negate=true.
    expect(optNames).toContain("--harness");
    expect(optNames).toContain("--dry-run");
    expect(optNames).toContain("--no-merge");
  });

  it("'skills' group is distinct from the existing 'skill' group (namespacing)", () => {
    // Smoke-checks the namespacing decision the project memory note
    // tracks (skill/* vs skillhub/* / ark skill vs ark skills).
    const program = new Command();
    registerSkillsCommands(program);
    expect(program.commands.find((c) => c.name() === "skills")).toBeDefined();
    // The plural-group does not register a singular 'skill' command.
    expect(program.commands.find((c) => c.name() === "skill")).toBeUndefined();
  });
});

describe("findLocalSkillBundles", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "skillhub-find-bundles-"));
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeSkill(harnessReadPath: string, name: string): void {
    const dir = join(repoRoot, harnessReadPath, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\nbody\n`);
  }

  it("returns empty when the repo has no skill dirs", () => {
    expect(findLocalSkillBundles(repoRoot)).toEqual([]);
  });

  it("finds claude bundles under .claude/skills/", () => {
    writeSkill(".claude/skills", "alpha");
    writeSkill(".claude/skills", "beta");
    const found = findLocalSkillBundles(repoRoot);
    expect(found.map((b) => b.name).sort()).toEqual(["alpha", "beta"]);
    expect(found.every((b) => b.harness === "claude")).toBe(true);
  });

  it("finds bundles across multiple adapters (claude + codex)", () => {
    writeSkill(".claude/skills", "alpha");
    // Codex adapter reads from .agents/skills/ per the open-standard path.
    writeSkill(".agents/skills", "gamma");
    const found = findLocalSkillBundles(repoRoot);
    const sig = found.map((b) => `${b.harness}/${b.name}`).sort();
    expect(sig).toEqual(["claude/alpha", "codex/gamma"]);
  });

  it("skips directories without a SKILL.md", () => {
    // Subdirectory exists but lacks SKILL.md - shouldn't count.
    mkdirSync(join(repoRoot, ".claude/skills/empty-dir"), { recursive: true });
    writeSkill(".claude/skills", "real");
    const found = findLocalSkillBundles(repoRoot);
    expect(found.map((b) => b.name)).toEqual(["real"]);
  });

  it("skips hidden entries (don't surface .DS_Store, .git/, etc.)", () => {
    mkdirSync(join(repoRoot, ".claude/skills/.hidden"), { recursive: true });
    writeFileSync(join(repoRoot, ".claude/skills/.hidden/SKILL.md"), "---\nname: x\ndescription: y\n---\n");
    writeSkill(".claude/skills", "visible");
    const found = findLocalSkillBundles(repoRoot);
    expect(found.map((b) => b.name)).toEqual(["visible"]);
  });

  it("returns paths relative to repoRoot (caller renders them as user-pasteable commands)", () => {
    writeSkill(".claude/skills", "deploy-runbook");
    const found = findLocalSkillBundles(repoRoot);
    expect(found[0].relativePath).toBe(".claude/skills/deploy-runbook");
  });
});

describe("assertSkillDirNameMatchesFrontmatter", () => {
  it("accepts when dir name and frontmatter name match", () => {
    const r = assertSkillDirNameMatchesFrontmatter({
      skillDirName: "code-review",
      frontmatterName: "code-review",
      skillPathForHint: ".claude/skills/code-review",
    });
    expect(r).toEqual({ ok: true });
  });

  it("rejects when dir name and frontmatter name differ", () => {
    // Concrete case from user testing: directory authored as
    // `.claude/skills/my-first-skill/` but SKILL.md frontmatter says
    // `name: code-review`. The put would succeed, then `ark skills
    // sync` later walks `<readPath>/code-review/` and reports "no
    // local skill directory found." Catch it at put time.
    const r = assertSkillDirNameMatchesFrontmatter({
      skillDirName: "my-first-skill",
      frontmatterName: "code-review",
      skillPathForHint: ".claude/skills/my-first-skill",
    });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toContain("my-first-skill");
      expect(r.error).toContain("code-review");
      // The error names both remediations so the user picks.
      expect(r.error).toContain("renaming the directory");
      expect(r.error).toContain("changing the frontmatter");
      // The suggested mv command targets `.claude/skills/code-review`
      // (sibling of the bad dir), not somewhere accidental.
      expect(r.error).toContain(".claude/skills/code-review");
    }
  });
});
