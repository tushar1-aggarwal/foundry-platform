/**
 * Tests for skill store -- CRUD, three-tier resolution.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

const { getCtx } = withTestContext();

describe("skill CRUD", () => {
  it("skills.list returns builtin skills", async () => {
    const skills = await getApp().skills.list();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some((s) => s.name === "code-review")).toBe(true);
  });

  it("skills.get returns a skill by name", async () => {
    const skill = await getApp().skills.get("code-review");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("code-review");
    expect(skill!.description).toBeDefined();
    expect(skill!.prompt).toBeDefined();
  });

  it("skills.get returns null for unknown skill", async () => {
    expect(await getApp().skills.get("nonexistent")).toBeNull();
  });

  it("skills.save creates a global skill", async () => {
    await getApp().skills.save("my-skill", { name: "my-skill", description: "test", prompt: "do the thing" }, "global");
    const skill = await getApp().skills.get("my-skill");
    expect(skill).not.toBeNull();
    expect(skill!._source).toBe("global");
  });

  it("skills.delete removes a global skill", async () => {
    await getApp().skills.save("to-delete", { name: "to-delete", description: "tmp", prompt: "x" }, "global");
    expect(await getApp().skills.get("to-delete")).not.toBeNull();
    await getApp().skills.delete("to-delete", "global");
    expect(await getApp().skills.get("to-delete")).toBeNull();
  });

  it("project skills override global", async () => {
    const projectRoot = getCtx().arkDir;
    await getApp().skills.save(
      "override-test",
      { name: "override-test", description: "global", prompt: "global" },
      "global",
    );
    await getApp().skills.save(
      "override-test",
      { name: "override-test", description: "project", prompt: "project" },
      "project",
      projectRoot,
    );
    const skill = await getApp().skills.get("override-test", projectRoot);
    expect(skill!._source).toBe("project");
    expect(skill!.description).toBe("project");
  });
});
