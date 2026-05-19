/**
 * Tests for agent.ts -- CRUD, template resolution, CLI arg building.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { resolveAgent, buildClaudeArgs, findProjectRoot, type AgentDefinition } from "../agent/agent.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

const { getCtx } = withTestContext();

const agentDir = () => join(getApp().config.dirs.ark, "agents");

function writeAgentYaml(name: string, data: Record<string, unknown>) {
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(join(agentDir(), `${name}.yaml`), YAML.stringify(data));
}

const projectDir = () => getCtx().arkDir;

function writeProjectAgentYaml(name: string, data: Record<string, unknown>) {
  const dir = join(projectDir(), ".ark", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(data));
}

beforeEach(() => {
  // Clean user agent dir to prevent leaking between tests
  rmSync(agentDir(), { recursive: true, force: true });
});

// ── loadAgent ────────────────────────────────────────────────────────────────

describe("loadAgent", () => {
  it("returns null for non-existent agent", async () => {
    expect(await getApp().agents.get("does-not-exist")).toBeNull();
  });

  it("loads a user agent from YAML", async () => {
    writeAgentYaml("my-agent", {
      name: "my-agent",
      description: "A test agent",
      model: "opus",
      system_prompt: "You are helpful.",
    });

    const agent = await getApp().agents.get("my-agent");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("my-agent");
    expect(agent!.description).toBe("A test agent");
    expect(agent!.model).toBe("opus");
    expect(agent!.system_prompt).toBe("You are helpful.");
  });

  it("fills defaults for missing fields", async () => {
    writeAgentYaml("minimal", { name: "minimal" });

    const agent = await getApp().agents.get("minimal");
    expect(agent).not.toBeNull();
    expect(agent!.model).toBe("sonnet");
    expect(agent!.max_turns).toBe(200);
    expect(agent!.tools).toEqual(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
    expect(agent!.mcp_servers).toEqual([]);
    expect(agent!.skills).toEqual([]);
    expect(agent!.memories).toEqual([]);
    expect(agent!.context).toEqual([]);
    expect(agent!.permission_mode).toBe("bypassPermissions");
    expect(agent!.env).toEqual({});
    expect(agent!.description).toBe("");
    expect(agent!.system_prompt).toBe("");
  });

  it("marks global agents with _source 'global'", async () => {
    writeAgentYaml("tagged", { name: "tagged" });

    const agent = await getApp().agents.get("tagged");
    expect(agent!._source).toBe("global");
  });

  it("sets _path to the YAML file path", async () => {
    writeAgentYaml("pathed", { name: "pathed" });

    const agent = await getApp().agents.get("pathed");
    expect(agent!._path).toBe(join(agentDir(), "pathed.yaml"));
  });

  it("loads a builtin agent (e.g. worker)", async () => {
    // The builtin agents dir should have worker.yaml from the repo
    const agent = await getApp().agents.get("worker");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("worker");
    expect(agent!._source).toBe("builtin");
  });

  it("global agent overrides builtin with same name", async () => {
    writeAgentYaml("worker", {
      name: "worker",
      description: "My custom worker",
      model: "haiku",
    });

    const agent = await getApp().agents.get("worker");
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("global");
    expect(agent!.description).toBe("My custom worker");
    expect(agent!.model).toBe("haiku");
  });
});

// ── listAgents ───────────────────────────────────────────────────────────────

describe("listAgents", () => {
  it("lists builtin agents when no user agents exist", async () => {
    const agents = await getApp().agents.list();
    // Should include at least the builtin agents from agents/ dir
    expect(agents.length).toBeGreaterThan(0);
    const names = agents.map((a) => a.name);
    expect(names).toContain("worker");
    expect(names).toContain("planner");
  });

  it("includes user agents in listing", async () => {
    writeAgentYaml("custom-one", { name: "custom-one", description: "First" });
    writeAgentYaml("custom-two", { name: "custom-two", description: "Second" });

    const agents = await getApp().agents.list();
    const names = agents.map((a) => a.name);
    expect(names).toContain("custom-one");
    expect(names).toContain("custom-two");
  });

  it("global agent overrides builtin with same name in listing", async () => {
    writeAgentYaml("worker", {
      name: "worker",
      description: "Override",
    });

    const agents = await getApp().agents.list();
    const worker = agents.find((a) => a.name === "worker");
    expect(worker).toBeDefined();
    expect(worker!._source).toBe("global");
    expect(worker!.description).toBe("Override");
  });

  it("fills defaults for agents in listing", async () => {
    writeAgentYaml("sparse", { name: "sparse" });

    const agents = await getApp().agents.list();
    const sparse = agents.find((a) => a.name === "sparse");
    expect(sparse).toBeDefined();
    expect(sparse!.model).toBe("sonnet");
    expect(sparse!.max_turns).toBe(200);
  });
});

// ── agents.save ────────────────────────────────────────────────────────────────

describe("agents.save", () => {
  it("round-trip: save then reload", async () => {
    const agent: AgentDefinition = {
      name: "saved-agent",
      description: "Saved description",
      model: "opus",
      max_turns: 50,
      system_prompt: "You are a saved agent.",
      tools: ["Bash", "Read"],
      mcp_servers: [],
      skills: ["skill-a"],
      memories: ["mem-1"],
      context: ["ctx-file"],
      permission_mode: "bypassPermissions",
      env: { FOO: "bar" },
    };

    await getApp().agents.save(agent.name, agent, "global");

    const loaded = await getApp().agents.get("saved-agent");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("saved-agent");
    expect(loaded!.description).toBe("Saved description");
    expect(loaded!.model).toBe("opus");
    expect(loaded!.max_turns).toBe(50);
    expect(loaded!.system_prompt).toBe("You are a saved agent.");
    expect(loaded!.tools).toEqual(["Bash", "Read"]);
    expect(loaded!.skills).toEqual(["skill-a"]);
    expect(loaded!.memories).toEqual(["mem-1"]);
    expect(loaded!.context).toEqual(["ctx-file"]);
    expect(loaded!.env).toEqual({ FOO: "bar" });
  });

  it("creates agent directory if it does not exist", async () => {
    rmSync(agentDir(), { recursive: true, force: true });

    await getApp().agents.save(
      "new-agent",
      {
        name: "new-agent",
        description: "",
        model: "sonnet",
        max_turns: 200,
        system_prompt: "",
        tools: [],
        mcp_servers: [],
        skills: [],
        memories: [],
        context: [],
        permission_mode: "bypassPermissions",
        env: {},
      } as AgentDefinition,
      "global",
    );

    expect(existsSync(join(agentDir(), "new-agent.yaml"))).toBe(true);
  });

  it("strips _source and _path from saved YAML", async () => {
    const agent: AgentDefinition = {
      name: "stripped",
      description: "",
      model: "sonnet",
      max_turns: 200,
      system_prompt: "",
      tools: [],
      mcp_servers: [],
      skills: [],
      memories: [],
      context: [],
      permission_mode: "bypassPermissions",
      env: {},
      _source: "global",
      _path: "/some/path",
    };

    await getApp().agents.save(agent.name, agent, "global");

    const raw = YAML.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("fs").readFileSync(join(agentDir(), "stripped.yaml"), "utf-8"),
    );
    expect(raw._source).toBeUndefined();
    expect(raw._path).toBeUndefined();
  });
});

// ── agents.delete ──────────────────────────────────────────────────────────────

describe("agents.delete", () => {
  it("returns false for non-existent agent", async () => {
    expect(await getApp().agents.delete("ghost")).toBe(false);
  });

  it("returns true and removes the file", async () => {
    writeAgentYaml("to-delete", { name: "to-delete" });
    expect(existsSync(join(agentDir(), "to-delete.yaml"))).toBe(true);

    const result = await getApp().agents.delete("to-delete");
    expect(result).toBe(true);
    expect(existsSync(join(agentDir(), "to-delete.yaml"))).toBe(false);
  });

  it("agent is no longer loadable after deletion", async () => {
    writeAgentYaml("ephemeral", { name: "ephemeral" });
    expect(await getApp().agents.get("ephemeral")).not.toBeNull();

    await getApp().agents.delete("ephemeral");
    // Should fall through to builtin lookup (which won't find "ephemeral")
    expect(await getApp().agents.get("ephemeral")).toBeNull();
  });
});

// ── resolveAgent ─────────────────────────────────────────────────────────────

describe("resolveAgent", () => {
  it("returns null for unknown agent", async () => {
    expect(await resolveAgent(getApp(), "nonexistent", {})).toBeNull();
  });

  it("substitutes template vars in system_prompt", async () => {
    writeAgentYaml("templated", {
      name: "templated",
      system_prompt: "Working on {{ticket}}: {{summary}} in {{repo}} on branch {{branch}}.",
    });

    const agent = await resolveAgent(getApp(), "templated", {
      ticket: "PROJ-123",
      summary: "Fix the bug",
      repo: "/code/myrepo",
      branch: "feat/fix-bug",
    });

    expect(agent).not.toBeNull();
    expect(agent!.system_prompt).toBe("Working on PROJ-123: Fix the bug in /code/myrepo on branch feat/fix-bug.");
  });

  it("substitutes session column vars", async () => {
    writeAgentYaml("vars-agent", {
      name: "vars-agent",
      system_prompt: "Dir: {{workdir}}, Id: {{id}}, Stage: {{stage}}",
    });

    const agent = await resolveAgent(getApp(), "vars-agent", {
      workdir: "/tmp/work",
      id: "s-abc123",
      stage: "implement",
    });

    expect(agent!.system_prompt).toBe("Dir: /tmp/work, Id: s-abc123, Stage: implement");
  });

  it("preserves unknown template vars", async () => {
    writeAgentYaml("unknown-vars", {
      name: "unknown-vars",
      system_prompt: "Known: {{ticket}}, Unknown: {{custom_var}}",
    });

    const agent = await resolveAgent(getApp(), "unknown-vars", { ticket: "T-1" });
    expect(agent!.system_prompt).toBe("Known: T-1, Unknown: {{custom_var}}");
  });

  it("handles empty session -- unset vars render verbatim", async () => {
    writeAgentYaml("empty-session", {
      name: "empty-session",
      system_prompt: "Ticket={{ticket}}, Repo={{repo}}",
    });

    const agent = await resolveAgent(getApp(), "empty-session", {});
    expect(agent!.system_prompt).toBe("Ticket={{ticket}}, Repo={{repo}}");
  });

  it("handles agent with no system_prompt", async () => {
    writeAgentYaml("no-prompt", { name: "no-prompt" });

    const agent = await resolveAgent(getApp(), "no-prompt", { ticket: "X-1" });
    expect(agent).not.toBeNull();
    expect(agent!.system_prompt).toBe("");
  });
});

// ── findProjectRoot ─────────────────────────────────────────────────────────

describe("findProjectRoot", () => {
  it("finds .git walking up from subdirectory", () => {
    // The test is running inside a git repo, so findProjectRoot from cwd should find it
    const root = findProjectRoot(process.cwd());
    expect(root).not.toBeNull();
    expect(existsSync(join(root!, ".git"))).toBe(true);
  });

  it("returns null when no .git exists", () => {
    // /tmp is unlikely to be inside a git repo
    const root = findProjectRoot("/tmp");
    expect(root).toBeNull();
  });

  it("finds .git in exact directory", () => {
    const tmpDir = join(getCtx().arkDir, "fake-project");
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    expect(findProjectRoot(tmpDir)).toBe(tmpDir);
  });

  it("finds .git from nested subdirectory", () => {
    const tmpDir = join(getCtx().arkDir, "fake-project2");
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    const nested = join(tmpDir, "src", "deep");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(tmpDir);
  });
});

// ── Three-tier resolution ───────────────────────────────────────────────────

describe("three-tier resolution", () => {
  it("project agent overrides global agent", async () => {
    writeAgentYaml("my-agent", { name: "my-agent", description: "global" });
    writeProjectAgentYaml("my-agent", { name: "my-agent", description: "project" });

    const agent = await getApp().agents.get("my-agent", projectDir());
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("project");
    expect(agent!.description).toBe("project");
  });

  it("project agent overrides builtin agent", async () => {
    writeProjectAgentYaml("worker", { name: "worker", description: "project worker" });

    const agent = await getApp().agents.get("worker", projectDir());
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("project");
    expect(agent!.description).toBe("project worker");
  });

  it("global agent overrides builtin when no project agent", async () => {
    writeAgentYaml("worker", { name: "worker", description: "global worker" });

    const agent = await getApp().agents.get("worker", projectDir());
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("global");
    expect(agent!.description).toBe("global worker");
  });

  it("falls back to builtin when no project or global agent", async () => {
    const agent = await getApp().agents.get("worker", projectDir());
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("builtin");
  });

  it("without projectRoot, skips project tier", async () => {
    writeProjectAgentYaml("only-project", { name: "only-project", description: "project only" });

    // Without projectRoot, should not find project-only agent
    const agent = await getApp().agents.get("only-project");
    expect(agent).toBeNull();
  });
});

// ── listAgents with projectRoot ─────────────────────────────────────────────

describe("listAgents with projectRoot", () => {
  it("merges all three tiers", async () => {
    writeAgentYaml("global-only", { name: "global-only", description: "global" });
    writeProjectAgentYaml("project-only", { name: "project-only", description: "project" });

    const agents = await getApp().agents.list(projectDir());
    const names = agents.map((a) => a.name);
    expect(names).toContain("worker"); // builtin
    expect(names).toContain("global-only"); // global
    expect(names).toContain("project-only"); // project
  });

  it("project agent wins over global and builtin", async () => {
    writeAgentYaml("worker", { name: "worker", description: "global worker" });
    writeProjectAgentYaml("worker", { name: "worker", description: "project worker" });

    const agents = await getApp().agents.list(projectDir());
    const worker = agents.find((a) => a.name === "worker");
    expect(worker).toBeDefined();
    expect(worker!._source).toBe("project");
    expect(worker!.description).toBe("project worker");
  });

  it("without projectRoot, does not include project agents", async () => {
    writeProjectAgentYaml("project-only", { name: "project-only" });

    const agents = await getApp().agents.list();
    const names = agents.map((a) => a.name);
    expect(names).not.toContain("project-only");
  });
});

// ── saveAgent with scope ────────────────────────────────────────────────────

describe("agents.save with scope", () => {
  const minAgent: AgentDefinition = {
    name: "scoped-agent",
    description: "test",
    model: "sonnet",
    max_turns: 200,
    system_prompt: "",
    tools: [],
    mcp_servers: [],
    skills: [],
    memories: [],
    context: [],
    permission_mode: "bypassPermissions",
    env: {},
  };

  it("saves to global by default", async () => {
    await getApp().agents.save(minAgent.name, minAgent, "global");
    expect(existsSync(join(agentDir(), "scoped-agent.yaml"))).toBe(true);
  });

  it("saves to project when scope is 'project'", async () => {
    await getApp().agents.save(minAgent.name, minAgent, "project", projectDir());
    const projectAgentPath = join(projectDir(), ".ark", "agents", "scoped-agent.yaml");
    expect(existsSync(projectAgentPath)).toBe(true);
    // Should NOT exist in global
    expect(existsSync(join(agentDir(), "scoped-agent.yaml"))).toBe(false);
  });

  it("falls back to global when scope is 'project' but no projectRoot", async () => {
    await getApp().agents.save(minAgent.name, minAgent, "project");
    expect(existsSync(join(agentDir(), "scoped-agent.yaml"))).toBe(true);
  });

  it("project-saved agent is loadable with projectRoot", async () => {
    await getApp().agents.save(minAgent.name, minAgent, "project", projectDir());
    const loaded = await getApp().agents.get("scoped-agent", projectDir());
    expect(loaded).not.toBeNull();
    expect(loaded!._source).toBe("project");
  });
});

// ── agents.delete with scope ──────────────────────────────────────────────────

describe("agents.delete with scope", () => {
  it("deletes from global by default", async () => {
    writeAgentYaml("to-delete", { name: "to-delete" });
    expect(await getApp().agents.delete("to-delete")).toBe(true);
    expect(existsSync(join(agentDir(), "to-delete.yaml"))).toBe(false);
  });

  it("deletes from project when scope is 'project'", async () => {
    writeProjectAgentYaml("proj-del", { name: "proj-del" });
    const projectPath = join(projectDir(), ".ark", "agents", "proj-del.yaml");
    expect(existsSync(projectPath)).toBe(true);

    expect(await getApp().agents.delete("proj-del", "project", projectDir())).toBe(true);
    expect(existsSync(projectPath)).toBe(false);
  });

  it("returns false when agent does not exist in specified scope", async () => {
    writeAgentYaml("global-only", { name: "global-only" });
    // Try deleting from project scope -- should not find it
    expect(await getApp().agents.delete("global-only", "project", projectDir())).toBe(false);
    // Global copy should still exist
    expect(existsSync(join(agentDir(), "global-only.yaml"))).toBe(true);
  });
});

// ── resolveAgent with projectRoot ───────────────────────────────────────────

describe("resolveAgent with projectRoot", () => {
  it("resolves project agent with template substitution", async () => {
    writeProjectAgentYaml("proj-tmpl", {
      name: "proj-tmpl",
      system_prompt: "Working on {{ticket}} in {{repo}}",
    });

    const agent = await resolveAgent(getApp(), "proj-tmpl", { ticket: "T-1", repo: "/code" }, projectDir());
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("project");
    expect(agent!.system_prompt).toBe("Working on T-1 in /code");
  });
});

// ── buildClaudeArgs ──────────────────────────────────────────────────────────

describe("buildClaudeArgs", () => {
  const baseAgent: AgentDefinition = {
    name: "test-agent",
    description: "Test",
    model: "sonnet",
    max_turns: 100,
    system_prompt: "Be helpful.",
    tools: ["Bash", "Read"],
    mcp_servers: [],
    skills: [],
    memories: [],
    context: [],
    permission_mode: "bypassPermissions",
    env: {},
  };

  it("starts with 'claude' as first arg", async () => {
    const args = await buildClaudeArgs(baseAgent);
    expect(args[0]).toBe("claude");
  });

  it("includes --model with resolved model name", async () => {
    const args = await buildClaudeArgs(baseAgent);
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
  });

  it("includes --max-turns from agent", async () => {
    const args = await buildClaudeArgs(baseAgent);
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("100");
  });

  it("includes --append-system-prompt from agent", async () => {
    const args = await buildClaudeArgs(baseAgent);
    expect(args).toContain("--append-system-prompt");
    const prompt = args[args.indexOf("--append-system-prompt") + 1];
    // Base system_prompt first, then the injected tool hints block.
    expect(prompt.startsWith("Be helpful.")).toBe(true);
    expect(prompt).toContain("## Available tools");
    expect(prompt).toContain("**Built-in:** Bash, Read");
  });

  it("passes --session-id from opts", async () => {
    const args = await buildClaudeArgs(baseAgent, { sessionId: "sess-1" });
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("sess-1");
  });

  it("passes headless and task options", async () => {
    const args = await buildClaudeArgs(baseAgent, {
      headless: true,
      task: "Run the tests",
    });
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe("Run the tests");
    expect(args).toContain("--verbose");
    expect(args).toContain("--output-format");
  });

  it("includes --dangerously-skip-permissions in non-headless mode", async () => {
    const args = await buildClaudeArgs(baseAgent);
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("adds --mcp-config for each MCP server entry", async () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      mcp_servers: ["/path/a.json", { command: "node", args: ["s.js"] }],
    };
    const args = await buildClaudeArgs(agent);
    const mcpIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === "--mcp-config") acc.push(i);
      return acc;
    }, []);
    expect(mcpIndices.length).toBe(2);
    expect(args[mcpIndices[0] + 1]).toBe("/path/a.json");
    expect(args[mcpIndices[1] + 1]).toBe(JSON.stringify({ command: "node", args: ["s.js"] }));
  });

  it("does not include -p without headless mode", async () => {
    const args = await buildClaudeArgs(baseAgent, { task: "ignored" });
    expect(args).not.toContain("-p");
  });

  it("appends a completion contract that forces a final `report` tool call", async () => {
    // The agent's turn is not considered complete until it calls
    // ark-channel's `report` tool. The dashboard and flow routing both
    // rely on that call -- without it the session looks hung.
    const args = await buildClaudeArgs(baseAgent);
    const prompt = args[args.indexOf("--append-system-prompt") + 1];
    expect(prompt).toContain("## Completion contract");
    expect(prompt).toContain("MUST call the `report` tool");
    expect(prompt).toContain("type='completed'");
    expect(prompt).toContain("type='question'");
    expect(prompt).toContain("type='error'");
  });

  it("keeps the completion contract even in fully autonomous mode", async () => {
    // Autonomous mode removes `type='question'` reports but still needs
    // `completed` / `error` terminal reports so flow routing advances.
    const args = await buildClaudeArgs(baseAgent, { autonomy: "full" });
    const prompt = args[args.indexOf("--append-system-prompt") + 1];
    expect(prompt).toContain("## Autonomous Mode");
    expect(prompt).toContain("## Completion contract");
    expect(prompt).toContain("MUST call the `report` tool");
  });
});

// ── Integration: full agent lifecycle ───────────────────────────────────────

describe("full agent lifecycle", () => {
  it("create -> list -> load -> delete round-trip for project scope", async () => {
    const root = projectDir();
    const agent = { name: "lifecycle-test", description: "Integration test agent", model: "haiku" } as AgentDefinition;
    await getApp().agents.save(agent.name, agent, "project", root);

    const agents = await getApp().agents.list(root);
    const found = agents.find((a) => a.name === "lifecycle-test");
    expect(found).not.toBeNull();
    expect(found!._source).toBe("project");

    const loaded = await getApp().agents.get("lifecycle-test", root);
    expect(loaded!.model).toBe("haiku");

    await getApp().agents.delete("lifecycle-test", "project", root);
    expect(await getApp().agents.get("lifecycle-test", root)).toBeNull();
  });

  it("project agent shadows global agent with same name", async () => {
    const root = projectDir();

    await getApp().agents.save("shadow-test", { name: "shadow-test", model: "sonnet" } as AgentDefinition, "global");
    await getApp().agents.save(
      "shadow-test",
      { name: "shadow-test", model: "opus" } as AgentDefinition,
      "project",
      root,
    );

    const loaded = await getApp().agents.get("shadow-test", root);
    expect(loaded!.model).toBe("opus");
    expect(loaded!._source).toBe("project");

    await getApp().agents.delete("shadow-test", "project", root);
    const fallback = await getApp().agents.get("shadow-test", root);
    expect(fallback!.model).toBe("sonnet");
    expect(fallback!._source).toBe("global");
  });

  it("global agent shadows builtin with same name", async () => {
    writeAgentYaml("worker", { name: "worker", model: "haiku", description: "custom worker" });

    const loaded = await getApp().agents.get("worker");
    expect(loaded!.model).toBe("haiku");
    expect(loaded!._source).toBe("global");

    await getApp().agents.delete("worker", "global");
    const fallback = await getApp().agents.get("worker");
    expect(fallback!._source).toBe("builtin");
  });
});
