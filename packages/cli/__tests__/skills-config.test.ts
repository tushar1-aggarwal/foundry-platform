/**
 * Tests for `<repo>/.ark/config.yaml` skills-section parser/writer.
 *
 * Coverage:
 *   - load: missing file, missing skills section, valid shape,
 *     wrong-shape rejection, malformed YAML rejection
 *   - write: creates file + parent dir, preserves other top-level
 *     sections, round-trip
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SkillsConfigError, configPath, loadSkillsConfig, writeSkillsConfig } from "../skills/config.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "skillhub-cli-config-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function writeFile(rel: string, contents: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(join(repoRoot, ".ark"), { recursive: true });
  writeFileSync(abs, contents, "utf8");
}

describe("configPath", () => {
  it("resolves to <repo>/.ark/config.yaml", () => {
    expect(configPath("/repo")).toBe("/repo/.ark/config.yaml");
  });
});

describe("loadSkillsConfig", () => {
  it("returns null when the file does not exist", () => {
    expect(loadSkillsConfig(repoRoot)).toBeNull();
  });

  it("returns null when the file exists but has no skills section", () => {
    writeFile(".ark/config.yaml", "other_feature:\n  some_key: value\n");
    expect(loadSkillsConfig(repoRoot)).toBeNull();
  });

  it("returns the parsed skills section when present and well-formed", () => {
    writeFile(
      ".ark/config.yaml",
      [
        "skills:",
        "  read_paths:",
        "    - .foundry/skills",
        "  write_to:",
        "    claude: .claude/skills",
        "    cursor: .agents/skills",
        "  enabled_harnesses: [claude, cursor]",
        "",
      ].join("\n"),
    );
    const cfg = loadSkillsConfig(repoRoot);
    expect(cfg).toEqual({
      read_paths: [".foundry/skills"],
      write_to: { claude: ".claude/skills", cursor: ".agents/skills" },
      enabled_harnesses: ["claude", "cursor"],
    });
  });

  it("accepts an empty skills section (everything optional)", () => {
    writeFile(".ark/config.yaml", "skills: {}\n");
    expect(loadSkillsConfig(repoRoot)).toEqual({});
  });

  it("throws SkillsConfigError when skills.read_paths is not an array of strings", () => {
    writeFile(".ark/config.yaml", "skills:\n  read_paths: not-an-array\n");
    expect(() => loadSkillsConfig(repoRoot)).toThrow(SkillsConfigError);
    expect(() => loadSkillsConfig(repoRoot)).toThrow(/read_paths must be an array of strings/);
  });

  it("throws SkillsConfigError when skills.write_to is not a mapping", () => {
    writeFile(".ark/config.yaml", "skills:\n  write_to:\n    - claude\n    - cursor\n");
    expect(() => loadSkillsConfig(repoRoot)).toThrow(/write_to must be a mapping/);
  });

  it("throws SkillsConfigError when a write_to value is not a string", () => {
    writeFile(".ark/config.yaml", "skills:\n  write_to:\n    claude: 123\n");
    expect(() => loadSkillsConfig(repoRoot)).toThrow(/write_to.claude must be a string/);
  });

  it("throws SkillsConfigError when enabled_harnesses contains a non-string", () => {
    writeFile(".ark/config.yaml", "skills:\n  enabled_harnesses: [claude, 7]\n");
    expect(() => loadSkillsConfig(repoRoot)).toThrow(/enabled_harnesses must be an array of strings/);
  });

  it("throws SkillsConfigError when the file is not valid YAML", () => {
    writeFile(".ark/config.yaml", "skills: [\n  unclosed");
    expect(() => loadSkillsConfig(repoRoot)).toThrow(/malformed YAML/);
  });
});

describe("writeSkillsConfig", () => {
  it("creates the file and parent directory when neither exists", () => {
    expect(existsSync(join(repoRoot, ".ark"))).toBe(false);
    writeSkillsConfig(repoRoot, { enabled_harnesses: ["claude"] });
    expect(existsSync(configPath(repoRoot))).toBe(true);
    expect(loadSkillsConfig(repoRoot)).toEqual({ enabled_harnesses: ["claude"] });
  });

  it("round-trips through loadSkillsConfig", () => {
    const original = {
      read_paths: [".foundry/skills", ".custom/path"],
      write_to: { claude: ".claude/skills", cursor: ".cursor/skills", codex: ".codex/skills" },
      enabled_harnesses: ["claude", "cursor", "codex"],
    };
    writeSkillsConfig(repoRoot, original);
    expect(loadSkillsConfig(repoRoot)).toEqual(original);
  });

  it("preserves other top-level sections when overwriting", () => {
    writeFile(
      ".ark/config.yaml",
      ["other_feature:", "  some_key: value", "  nested:", "    a: 1", "skills: {}", ""].join("\n"),
    );
    writeSkillsConfig(repoRoot, { enabled_harnesses: ["claude"] });
    const raw = readFileSync(configPath(repoRoot), "utf8");
    // Other section survives.
    expect(raw).toContain("other_feature:");
    expect(raw).toContain("some_key: value");
    expect(raw).toContain("a: 1");
    // Skills section was replaced.
    expect(loadSkillsConfig(repoRoot)).toEqual({ enabled_harnesses: ["claude"] });
  });

  it("refuses to clobber a malformed-YAML file (surfaces the parse error)", () => {
    writeFile(".ark/config.yaml", "skills: [\n  unclosed");
    expect(() => writeSkillsConfig(repoRoot, { enabled_harnesses: ["claude"] })).toThrow(
      /cannot rewrite.*malformed YAML/,
    );
  });
});
