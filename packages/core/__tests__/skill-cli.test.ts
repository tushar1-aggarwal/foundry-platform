import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

const { getCtx } = withTestContext();

describe("skill create/delete via core", () => {
  it("skills.save creates a global skill and skills.get finds it", async () => {
    await getApp().skills.save(
      "test-skill",
      { name: "test-skill", description: "Test", prompt: "Do the thing" },
      "global",
    );
    const skill = await getApp().skills.get("test-skill");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("test-skill");
    expect(skill!.prompt).toBe("Do the thing");
    expect(skill!._source).toBe("global");
  });

  it("skills.delete removes a global skill", async () => {
    await getApp().skills.save("ephemeral", { name: "ephemeral", description: "tmp", prompt: "x" }, "global");
    expect(await getApp().skills.get("ephemeral")).not.toBeNull();
    await getApp().skills.delete("ephemeral", "global");
    expect(await getApp().skills.get("ephemeral")).toBeNull();
  });

  it("skills.delete on a builtin name does not remove builtins", async () => {
    const builtins = await getApp().skills.list();
    const builtinName = builtins.find((s) => s._source === "builtin")?.name;
    if (builtinName) {
      await getApp().skills.delete(builtinName, "global");
      expect(await getApp().skills.get(builtinName)).not.toBeNull();
    }
  });

  it("skills.save with tags round-trips via YAML", async () => {
    const skill = { name: "from-file", description: "From file", prompt: "multi\nline\nprompt", tags: ["test"] };
    await getApp().skills.save("from-file", skill, "global");
    const loaded = await getApp().skills.get("from-file");
    expect(loaded!.prompt).toBe("multi\nline\nprompt");
    expect(loaded!.tags).toEqual(["test"]);
  });
});
