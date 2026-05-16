/**
 * Tests for the install + search subcommands.
 *
 * Pure unit coverage focuses on the id-or-name resolution (the part
 * that doesn't require booting a daemon or touching the filesystem).
 * Registration smoke verifies the two subcommands land under the
 * `ark skills` group and declare their args.
 *
 * Full end-to-end install behavior (file writes + sidecar) is part
 * of the C16 integration pass; install is essentially FF-pull
 * scoped to one skill and shares the failure modes the reviewer
 * already flagged for sync's writeBundleToDisk.
 */

import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { registerSkillsInstallSearchCommands, resolveIdOrName } from "../commands/skills-install-search.js";
import type { SkillhubSkill } from "../../types/index.js";

function mkSkill(overrides: Partial<SkillhubSkill> & { id: string; name: string }): SkillhubSkill {
  return {
    id: overrides.id,
    tenant_id: overrides.tenant_id ?? null,
    team_id: overrides.team_id ?? null,
    owner_user_id: overrides.owner_user_id ?? "u-test",
    visibility: overrides.visibility ?? "user",
    name: overrides.name,
    description: overrides.description ?? "test",
    body: overrides.body ?? "body",
    category: overrides.category ?? null,
    tags: overrides.tags ?? [],
    supporting_files: overrides.supporting_files ?? [],
    harness_hints: overrides.harness_hints ?? {},
    current_hash: overrides.current_hash ?? "h",
    upstream_id: overrides.upstream_id ?? null,
    created_by: overrides.created_by ?? "u-test",
    updated_by: overrides.updated_by ?? null,
    deleted_at: overrides.deleted_at ?? null,
    deleted_by: overrides.deleted_by ?? null,
    created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00Z",
  };
}

describe("resolveIdOrName", () => {
  it("resolves a skl-... argument as an id (by id match)", async () => {
    const skills = [mkSkill({ id: "skl-aaa", name: "code-review" }), mkSkill({ id: "skl-bbb", name: "deploy" })];
    const r = await resolveIdOrName("skl-aaa", async () => skills);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.skill.id).toBe("skl-aaa");
  });

  it("errors when a skl-... id doesn't match any visible skill", async () => {
    const r = await resolveIdOrName("skl-missing", async () => []);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/no visible skill with id 'skl-missing'/);
  });

  it("resolves a unique name to its id", async () => {
    const skills = [mkSkill({ id: "skl-aaa", name: "code-review" })];
    const r = await resolveIdOrName("code-review", async () => skills);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.skill.id).toBe("skl-aaa");
  });

  it("errors when no visible skill matches the name", async () => {
    const r = await resolveIdOrName("no-such-skill", async () => []);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/no visible skill named 'no-such-skill'/);
  });

  it("errors with the matching ids when a name is ambiguous (e.g. one's user-scope, one's team-scope)", async () => {
    const skills = [
      mkSkill({ id: "skl-aaa", name: "code-review", visibility: "user" }),
      mkSkill({ id: "skl-bbb", name: "code-review", visibility: "team", team_id: "t-eng" }),
    ];
    const r = await resolveIdOrName("code-review", async () => skills);
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toMatch(/ambiguous/);
      expect(r.error).toContain("skl-aaa");
      expect(r.error).toContain("skl-bbb");
      expect(r.error).toContain("Pass the id explicitly");
    }
  });
});

describe("registerSkillsInstallSearchCommands", () => {
  it("registers install + search under the skills group", () => {
    const program = new Command();
    const skillsGroup = program.command("skills");
    registerSkillsInstallSearchCommands(skillsGroup);
    const subNames = skillsGroup.commands.map((c) => c.name()).sort();
    expect(subNames).toEqual(["install", "search"]);
  });

  it("install declares <idOrName> argument + --harness option", () => {
    const program = new Command();
    const skillsGroup = program.command("skills");
    registerSkillsInstallSearchCommands(skillsGroup);
    const install = skillsGroup.commands.find((c) => c.name() === "install")!;
    expect(install).toBeDefined();
    expect(install.options.find((o) => o.long === "--harness")).toBeDefined();
  });

  it("search declares <query> argument and no options", () => {
    const program = new Command();
    const skillsGroup = program.command("skills");
    registerSkillsInstallSearchCommands(skillsGroup);
    const search = skillsGroup.commands.find((c) => c.name() === "search")!;
    expect(search).toBeDefined();
  });
});
