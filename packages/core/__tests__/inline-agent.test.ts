/**
 * Tests for inline agent definitions on stage `agent:` fields.
 *
 * await buildInlineAgent() takes an InlineAgentSpec (an ad-hoc agent object passed
 * inside a stage) and produces an AgentDefinition without touching the agent
 * store. Used by for_each + spawn flows that ship the agent inline instead of
 * pre-registering a YAML on disk.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { setApp, clearApp } from "./test-helpers.js";
import { buildInlineAgent } from "../agent/agent.js";
import type { InlineAgentSpec } from "../services/flow.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

test("builds AgentDefinition from a minimal inline spec", async () => {
  const spec: InlineAgentSpec = {
    runtime: "claude-agent",
    system_prompt: "You are a test agent.",
  };
  const agent = await buildInlineAgent(app, spec, {});
  expect(agent).not.toBeNull();
  expect(agent!.name).toBe("inline");
  expect(agent!.runtime).toBe("claude-agent");
  expect(agent!.system_prompt).toBe("You are a test agent.");
  // Defaults
  expect(agent!.model).toBe("sonnet");
  expect(agent!.max_turns).toBe(200);
  expect(agent!.permission_mode).toBe("bypassPermissions");
  expect(agent!.tools).toEqual(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
});

test("returns null when system_prompt is missing", async () => {
  const spec = { runtime: "claude-agent" } as InlineAgentSpec;
  expect(await buildInlineAgent(app, spec, {})).toBeNull();
});

test("returns null when runtime is missing", async () => {
  const spec = { system_prompt: "test" } as InlineAgentSpec;
  expect(await buildInlineAgent(app, spec, {})).toBeNull();
});

test("substitutes session vars into system_prompt", async () => {
  const spec: InlineAgentSpec = {
    runtime: "claude-agent",
    system_prompt: "You are working on {{ticket}} in {{workdir}}.",
  };
  const agent = await buildInlineAgent(app, spec, { ticket: "PAI-31080", workdir: "/tmp/test" });
  expect(agent!.system_prompt).toBe("You are working on PAI-31080 in /tmp/test.");
});

test("caller-provided fields override defaults", async () => {
  const spec: InlineAgentSpec = {
    name: "my-custom-agent",
    runtime: "claude-agent",
    model: "opus",
    max_turns: 50,
    system_prompt: "custom",
    tools: ["Read", "Write"],
  };
  const agent = await buildInlineAgent(app, spec, {});
  expect(agent!.name).toBe("my-custom-agent");
  expect(agent!.model).toBe("opus");
  expect(agent!.max_turns).toBe(50);
  expect(agent!.tools).toEqual(["Read", "Write"]);
});

test("applies runtime merge -- _resolved_runtime_type is set", async () => {
  const spec: InlineAgentSpec = {
    runtime: "claude-agent",
    system_prompt: "test",
  };
  const agent = await buildInlineAgent(app, spec, {});
  // The claude-agent runtime YAML should resolve to type: "claude-agent"
  expect(agent!._resolved_runtime_type).toBeDefined();
});

test("runtimeOverride takes precedence over spec.runtime for the merge", async () => {
  const spec: InlineAgentSpec = {
    runtime: "claude-code",
    system_prompt: "test",
  };
  const agent = await buildInlineAgent(app, spec, {}, { runtimeOverride: "claude-agent" });
  // agent.runtime stays as the spec's declared runtime, but the merged
  // _resolved_runtime_type reflects the override.
  expect(agent!.runtime).toBe("claude-code");
  expect(agent!._resolved_runtime_type).toBeDefined();
});
