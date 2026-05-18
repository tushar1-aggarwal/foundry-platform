/**
 * Tests for FileAgentStore - list, get, save, delete with three-tier resolution.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import YAML from "yaml";
import { FileAgentStore } from "../../stores/agent-store.js";

let store: FileAgentStore;
let builtinDir: string;
let userDir: string;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ark-agent-store-test-"));
  builtinDir = join(tempDir, "builtin");
  userDir = join(tempDir, "user");
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  store = new FileAgentStore({ builtinDir, userDir });
});

function writeAgent(dir: string, name: string, data: Record<string, unknown>): void {
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(data));
}

// ── get ─────────────────────────────────────────────────────────────────────

describe("FileAgentStore.get", () => {
  it("returns null for non-existent agent", async () => {
    expect(await store.get("does-not-exist")).toBeNull();
  });

  it("loads an agent from builtin dir with defaults", async () => {
    writeAgent(builtinDir, "test-agent", { name: "test-agent", model: "opus" });
    const agent = await store.get("test-agent");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("test-agent");
    expect(agent!.model).toBe("opus");
    expect(agent!._source).toBe("builtin");
    // Defaults should be filled
    expect(agent!.max_turns).toBe(200);
    expect(agent!.tools).toEqual(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
    expect(agent!.env).toEqual({});
  });

  it("user dir overrides builtin dir", async () => {
    writeAgent(builtinDir, "shared", { name: "shared", description: "builtin" });
    writeAgent(userDir, "shared", { name: "shared", description: "global" });
    const agent = await store.get("shared");
    expect(agent!._source).toBe("global");
    expect(agent!.description).toBe("global");
  });

  it("project dir overrides both when projectRoot is passed", async () => {
    const projRoot = join(tempDir, "project-root");
    const projAgentDir = join(projRoot, ".ark", "agents");
    mkdirSync(projAgentDir, { recursive: true });
    writeAgent(builtinDir, "shared", { name: "shared", description: "builtin" });
    writeAgent(userDir, "shared", { name: "shared", description: "global" });
    writeAgent(projAgentDir, "shared", { name: "shared", description: "project" });

    const agent = await store.get("shared", projRoot);
    expect(agent!._source).toBe("project");
    expect(agent!.description).toBe("project");
  });

  it("sets _path to the YAML file path", async () => {
    writeAgent(builtinDir, "pathed", { name: "pathed" });
    const agent = await store.get("pathed");
    expect(agent!._path).toBe(join(builtinDir, "pathed.yaml"));
  });
});

// ── list ────────────────────────────────────────────────────────────────────

describe("FileAgentStore.list", () => {
  it("returns empty when no agents exist", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("lists agents from all tiers", async () => {
    writeAgent(builtinDir, "b-agent", { name: "b-agent" });
    writeAgent(userDir, "u-agent", { name: "u-agent" });
    const agents = await store.list();
    const names = agents.map((a) => a.name);
    expect(names).toContain("b-agent");
    expect(names).toContain("u-agent");
  });

  it("user agent overrides builtin with same name", async () => {
    writeAgent(builtinDir, "overlap", { name: "overlap", description: "builtin" });
    writeAgent(userDir, "overlap", { name: "overlap", description: "global" });
    const agents = await store.list();
    const overlap = agents.filter((a) => a.name === "overlap");
    expect(overlap).toHaveLength(1);
    expect(overlap[0]._source).toBe("global");
  });

  it("project agents visible with projectRoot", async () => {
    const projRoot = join(tempDir, "project-root");
    const projAgentDir = join(projRoot, ".ark", "agents");
    mkdirSync(projAgentDir, { recursive: true });
    writeAgent(builtinDir, "b-agent", { name: "b-agent" });
    writeAgent(projAgentDir, "p-agent", { name: "p-agent" });

    const agents = await store.list(projRoot);
    const names = agents.map((a) => a.name);
    expect(names).toContain("b-agent");
    expect(names).toContain("p-agent");
  });

  it("fills defaults for agents in listing", async () => {
    writeAgent(builtinDir, "sparse", { name: "sparse" });
    const agents = await store.list();
    const sparse = agents.find((a) => a.name === "sparse");
    expect(sparse!.model).toBe("sonnet");
    expect(sparse!.max_turns).toBe(200);
  });
});

// ── save ────────────────────────────────────────────────────────────────────

describe("FileAgentStore.save", () => {
  it("saves to user dir by default", async () => {
    await store.save("new-agent", { name: "new-agent", description: "test" } as any);
    expect(existsSync(join(userDir, "new-agent.yaml"))).toBe(true);
    const loaded = await store.get("new-agent");
    expect(loaded!.name).toBe("new-agent");
    expect(loaded!._source).toBe("global");
  });

  it("saves to project dir when scope is project", async () => {
    const projRoot = join(tempDir, "proj-save");
    await store.save("proj-agent", { name: "proj-agent" } as any, "project", projRoot);
    expect(existsSync(join(projRoot, ".ark", "agents", "proj-agent.yaml"))).toBe(true);
  });

  it("strips _source and _path from saved YAML", async () => {
    await store.save("stripped", {
      name: "stripped",
      _source: "global",
      _path: "/some/path",
    } as any);
    const raw = YAML.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("fs").readFileSync(join(userDir, "stripped.yaml"), "utf-8"),
    );
    expect(raw._source).toBeUndefined();
    expect(raw._path).toBeUndefined();
  });
});

// ── delete ──────────────────────────────────────────────────────────────────

describe("FileAgentStore.delete", () => {
  it("returns false for non-existent agent", async () => {
    expect(await store.delete("ghost")).toBe(false);
  });

  it("deletes from user dir and returns true", async () => {
    writeAgent(userDir, "to-del", { name: "to-del" });
    expect(await store.delete("to-del")).toBe(true);
    expect(existsSync(join(userDir, "to-del.yaml"))).toBe(false);
  });

  it("deletes from project dir when scope is project", async () => {
    const projRoot = join(tempDir, "proj-del");
    const projAgentDir = join(projRoot, ".ark", "agents");
    mkdirSync(projAgentDir, { recursive: true });
    writeAgent(projAgentDir, "p-del", { name: "p-del" });

    expect(await store.delete("p-del", "project", projRoot)).toBe(true);
    expect(existsSync(join(projAgentDir, "p-del.yaml"))).toBe(false);
  });
});
