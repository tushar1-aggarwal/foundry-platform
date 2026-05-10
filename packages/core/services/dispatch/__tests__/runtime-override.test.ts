/**
 * Unit test for `applyScopingRuntimeHint` -- the helper that mutates a
 * resolved agent in place when a Phase 1 `runtime` scoping hint is
 * present on the session config.
 */

import { describe, it, expect } from "bun:test";
import { applyScopingRuntimeHint, applyScopingModelHint } from "../agent-resolve.js";
import type { AgentDefinition } from "../../../agent/agent.js";

type RuntimeDef = { name?: string; type: string };

function fakeRuntimes(map: Record<string, RuntimeDef>) {
  return {
    runtimes: {
      get(name: string): RuntimeDef | null {
        return map[name] ?? null;
      },
    },
  } as unknown as Parameters<typeof applyScopingRuntimeHint>[0];
}

type ModelDef = { id: string; provider: string };

function fakeModels(map: Record<string, ModelDef>) {
  return {
    models: {
      get(idOrAlias: string): ModelDef | null {
        return map[idOrAlias] ?? null;
      },
    },
  } as unknown as Parameters<typeof applyScopingModelHint>[0];
}

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "code-reviewer",
    runtime: "claude",
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
    ...overrides,
  } as AgentDefinition;
}

describe("applyScopingRuntimeHint", () => {
  it("no-ops when hint is undefined", () => {
    const agent = makeAgent({ _resolved_runtime_type: "claude-code" });
    const logs: string[] = [];
    applyScopingRuntimeHint(fakeRuntimes({}), agent, undefined, (m) => logs.push(m));
    expect(agent.runtime).toBe("claude");
    expect(agent._resolved_runtime_type).toBe("claude-code");
    expect(logs).toEqual([]);
  });

  it("replaces runtime + recomputes _resolved_runtime_type when hint matches a known runtime and agent is unlocked", () => {
    const agent = makeAgent({ _resolved_runtime_type: "claude-code" });
    const logs: string[] = [];
    applyScopingRuntimeHint(fakeRuntimes({ codex: { type: "cli-agent" } }), agent, "codex", (m) => logs.push(m));
    expect(agent.runtime).toBe("codex");
    expect(agent._resolved_runtime_type).toBe("cli-agent");
    expect(logs.some((m) => m.includes("'codex' applied"))).toBe(true);
  });

  it("ignores hint when agent is runtime_locked (logs reason, leaves agent untouched)", () => {
    const agent = makeAgent({ runtime_locked: true, _resolved_runtime_type: "claude-code" });
    const logs: string[] = [];
    applyScopingRuntimeHint(fakeRuntimes({ codex: { type: "cli-agent" } }), agent, "codex", (m) => logs.push(m));
    expect(agent.runtime).toBe("claude");
    expect(agent._resolved_runtime_type).toBe("claude-code");
    expect(logs.some((m) => m.includes("ignored") && m.includes("runtime_locked"))).toBe(true);
  });

  it("falls back gracefully when the hint refers to a runtime no longer in the registry", () => {
    const agent = makeAgent({ _resolved_runtime_type: "claude-code" });
    const logs: string[] = [];
    applyScopingRuntimeHint(fakeRuntimes({}), agent, "ghost-runtime", (m) => logs.push(m));
    expect(agent.runtime).toBe("claude");
    expect(agent._resolved_runtime_type).toBe("claude-code");
    expect(logs.some((m) => m.includes("ghost-runtime") && m.includes("no longer"))).toBe(true);
  });
});

describe("applyScopingModelHint", () => {
  it("no-ops when hint is undefined", () => {
    const agent = makeAgent({ model: "sonnet" });
    const logs: string[] = [];
    applyScopingModelHint(fakeModels({}), agent, undefined, undefined, (m) => logs.push(m));
    expect(agent.model).toBe("sonnet");
    expect(logs).toEqual([]);
  });

  it("replaces agent.model when hint matches a known model and agent is unlocked", () => {
    const agent = makeAgent({ model: "sonnet" });
    const logs: string[] = [];
    applyScopingModelHint(fakeModels({ opus: { id: "opus", provider: "anthropic" } }), agent, "opus", undefined, (m) =>
      logs.push(m),
    );
    expect(agent.model).toBe("opus");
    expect(logs.some((m) => m.includes("'opus' applied"))).toBe(true);
  });

  it("ignores hint when agent is model_locked (the cost-pinned scenario)", () => {
    const agent = makeAgent({ model: "haiku", model_locked: true });
    const logs: string[] = [];
    applyScopingModelHint(fakeModels({ opus: { id: "opus", provider: "anthropic" } }), agent, "opus", undefined, (m) =>
      logs.push(m),
    );
    // Cost lock-in: agent stays on haiku even though tenant override said opus.
    expect(agent.model).toBe("haiku");
    expect(logs.some((m) => m.includes("ignored") && m.includes("model_locked"))).toBe(true);
  });

  it("falls back gracefully when the hint refers to a model no longer in the catalog", () => {
    const agent = makeAgent({ model: "sonnet" });
    const logs: string[] = [];
    applyScopingModelHint(fakeModels({}), agent, "ghost-model", undefined, (m) => logs.push(m));
    expect(agent.model).toBe("sonnet");
    expect(logs.some((m) => m.includes("ghost-model") && m.includes("no longer"))).toBe(true);
  });
});
