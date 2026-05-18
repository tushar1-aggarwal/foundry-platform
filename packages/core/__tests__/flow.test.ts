/**
 * Tests for flow.ts -- flow loading, stage navigation, gate evaluation,
 * and stage action resolution.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import {
  getStages,
  getStage,
  getFirstStage,
  getNextStage,
  evaluateGate,
  getStageAction,
  resolveFlow,
} from "../services/flow.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

/** Directory where flow.ts looks for user flows (module-level constant). */
const flowDir = () => join(getApp().config.dirs.ark, "flows");

/** Write a YAML flow definition to the user flows directory. */
function writeUserFlow(name: string, def: Record<string, unknown>): void {
  const dir = flowDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

beforeEach(() => {
  // Clean user flows dir so each test starts fresh
  rmSync(flowDir(), { recursive: true, force: true });
});

// ── loadFlow ─────────────────────────────────────────────────────────────────

describe("loadFlow", () => {
  it("returns null for a non-existent flow", async () => {
    expect(await getApp().flows.get("does-not-exist")).toBeNull();
  });

  it("loads a user-defined flow from the user dir", async () => {
    writeUserFlow("my-flow", {
      name: "my-flow",
      description: "test flow",
      stages: [{ name: "alpha", agent: "planner", gate: "auto" }],
    });
    const flow = await getApp().flows.get("my-flow");
    expect(flow).not.toBeNull();
    expect(flow!.name).toBe("my-flow");
    expect(flow!.stages).toHaveLength(1);
    expect(flow!.stages[0].name).toBe("alpha");
  });

  it("loads the builtin 'default' flow", async () => {
    const flow = await getApp().flows.get("default");
    expect(flow).not.toBeNull();
    expect(flow!.name).toBe("default");
    expect(flow!.stages.length).toBeGreaterThanOrEqual(1);
  });

  it("user flow overrides a builtin flow of the same name", async () => {
    writeUserFlow("default", {
      name: "default",
      description: "user override",
      stages: [{ name: "only-stage", agent: "custom", gate: "manual" }],
    });
    const flow = await getApp().flows.get("default");
    expect(flow).not.toBeNull();
    expect(flow!.description).toBe("user override");
    expect(flow!.stages).toHaveLength(1);
    expect(flow!.stages[0].name).toBe("only-stage");
  });
});

// ── listFlows ────────────────────────────────────────────────────────────────

describe("listFlows", () => {
  it("includes builtin flows", async () => {
    const flows = await getApp().flows.list();
    const names = flows.map((f) => f.name);
    expect(names).toContain("default");
  });

  it("includes user-defined flows", async () => {
    writeUserFlow("custom-flow", {
      name: "custom-flow",
      description: "a custom flow",
      stages: [{ name: "s1", agent: "tester", gate: "auto" }],
    });
    const flows = await getApp().flows.list();
    const custom = flows.find((f) => f.name === "custom-flow");
    expect(custom).toBeDefined();
    expect(custom!.source).toBe("user");
    expect(custom!.description).toBe("a custom flow");
  });

  it("user flow overrides builtin with same name", async () => {
    writeUserFlow("default", {
      name: "default",
      description: "overridden",
      stages: [{ name: "x", agent: "a", gate: "auto" }],
    });
    const flows = await getApp().flows.list();
    const defaults = flows.filter((f) => f.name === "default");
    expect(defaults).toHaveLength(1);
    expect(defaults[0].source).toBe("user");
    expect(defaults[0].description).toBe("overridden");
  });

  it("returns stages as an array of stage names", async () => {
    const flows = await getApp().flows.list();
    const def = flows.find((f) => f.name === "default");
    expect(def).toBeDefined();
    expect(Array.isArray(def!.stages)).toBe(true);
    expect(def!.stages[0]).toBe("intake");
  });
});

// ── getStages ────────────────────────────────────────────────────────────────

describe("getStages", () => {
  it("returns empty array for unknown flow", async () => {
    expect(await getStages(getApp(), "nonexistent")).toEqual([]);
  });

  it("returns all stages for a known flow", async () => {
    const stages = await getStages(getApp(), "default");
    const names = stages.map((s) => s.name);
    expect(names).toEqual(["intake", "plan", "audit", "implement", "verify", "pr", "review", "close", "retro"]);
  });
});

// ── getStage ─────────────────────────────────────────────────────────────────

describe("getStage", () => {
  it("returns null for unknown flow", async () => {
    expect(await getStage(getApp(), "nonexistent", "plan")).toBeNull();
  });

  it("returns null for unknown stage name", async () => {
    expect(await getStage(getApp(), "default", "nonexistent-stage")).toBeNull();
  });

  it("returns the named stage with correct properties", async () => {
    const stage = await getStage(getApp(), "default", "implement");
    expect(stage).not.toBeNull();
    expect(stage!.name).toBe("implement");
    expect(stage!.agent).toBe("implementer");
    expect(stage!.gate).toBe("auto");
  });
});

// ── getFirstStage ────────────────────────────────────────────────────────────

describe("getFirstStage", () => {
  it("returns null for unknown flow", async () => {
    expect(await getFirstStage(getApp(), "nonexistent")).toBeNull();
  });

  it("returns the first stage name", async () => {
    expect(await getFirstStage(getApp(), "default")).toBe("intake");
  });

  it("returns first stage of a user flow", async () => {
    writeUserFlow("my-flow", {
      name: "my-flow",
      stages: [
        { name: "alpha", agent: "a", gate: "auto" },
        { name: "beta", agent: "b", gate: "manual" },
      ],
    });
    expect(await getFirstStage(getApp(), "my-flow")).toBe("alpha");
  });
});

// ── getNextStage ─────────────────────────────────────────────────────────────

describe("getNextStage", () => {
  it("returns the next stage name", async () => {
    expect(await getNextStage(getApp(), "default", "intake")).toBe("plan");
    expect(await getNextStage(getApp(), "default", "plan")).toBe("audit");
  });

  it("returns null at the last stage", async () => {
    expect(await getNextStage(getApp(), "default", "retro")).toBeNull();
  });

  it("returns null for unknown current stage", async () => {
    expect(await getNextStage(getApp(), "default", "nonexistent")).toBeNull();
  });

  it("returns null for unknown flow", async () => {
    expect(await getNextStage(getApp(), "nonexistent", "plan")).toBeNull();
  });
});

// ── evaluateGate ─────────────────────────────────────────────────────────────

describe("evaluateGate", async () => {
  it("auto gate passes without error", async () => {
    const result = await evaluateGate(getApp(), "default", "implement", {});
    expect(result.canProceed).toBe(true);
    expect(result.reason).toContain("auto");
  });

  it("auto gate passes with explicit null error", async () => {
    const result = await evaluateGate(getApp(), "default", "implement", { error: null });
    expect(result.canProceed).toBe(true);
  });

  it("auto gate fails when session has error", async () => {
    const result = await evaluateGate(getApp(), "default", "implement", { error: "build failed" });
    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain("build failed");
  });

  it("manual gate always blocks", async () => {
    const result = await evaluateGate(getApp(), "default", "plan", {});
    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain("manual");
  });

  it("condition gate always passes", async () => {
    writeUserFlow("cond-flow", {
      name: "cond-flow",
      stages: [{ name: "check", agent: "validator", gate: "condition" }],
    });
    const result = await evaluateGate(getApp(), "cond-flow", "check", {});
    expect(result.canProceed).toBe(true);
    expect(result.reason).toContain("condition");
  });

  it("review gate always blocks", async () => {
    writeUserFlow("review-flow", {
      name: "review-flow",
      stages: [{ name: "await-pr", agent: "reviewer", gate: "review" }],
    });
    const result = await evaluateGate(getApp(), "review-flow", "await-pr", {});
    expect(result.canProceed).toBe(false);
  });

  it("review gate reason contains 'awaiting PR approval'", async () => {
    writeUserFlow("review-flow2", {
      name: "review-flow2",
      stages: [{ name: "await-pr", agent: "reviewer", gate: "review" }],
    });
    const result = await evaluateGate(getApp(), "review-flow2", "await-pr", {});
    expect(result.reason).toContain("awaiting PR approval");
  });

  it("returns canProceed false for unknown stage", async () => {
    const result = await evaluateGate(getApp(), "default", "nonexistent", {});
    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it("returns canProceed false for unknown flow", async () => {
    const result = await evaluateGate(getApp(), "nonexistent", "plan", {});
    expect(result.canProceed).toBe(false);
  });

  it("treats a missing gate as auto so for_each-only flows can advance", async () => {
    // Real incident: PAI-31995 dispatches surfaced as "pending" parents
    // forever because the outer for_each stage YAML didn't specify `gate:`,
    // and the strict default emitted "Unknown gate: undefined" which made
    // mediateStageHandoff -> advance bail before marking the flow completed.
    writeUserFlow("for-each-no-gate", {
      name: "for-each-no-gate",
      stages: [
        {
          name: "per_item",
          for_each: "{{inputs.items}}",
          mode: "spawn",
          spawn: { flow: "noop" },
        },
      ],
    });
    const result = await evaluateGate(getApp(), "for-each-no-gate", "per_item", {});
    expect(result.canProceed).toBe(true);
    expect(result.reason).toContain("auto");
  });
});

// ── getStageAction ───────────────────────────────────────────────────────────

describe("getStageAction", () => {
  it("returns type 'unknown' for missing flow", async () => {
    const action = await getStageAction(getApp(), "nonexistent", "plan");
    expect(action.type).toBe("unknown");
  });

  it("returns type 'unknown' for missing stage", async () => {
    const action = await getStageAction(getApp(), "default", "nonexistent");
    expect(action.type).toBe("unknown");
  });

  it("returns agent type with agent name", async () => {
    const action = await getStageAction(getApp(), "default", "plan");
    expect(action.type).toBe("agent");
    expect(action.agent).toBe("spec-planner");
  });

  it("returns action type with action name", async () => {
    const action = await getStageAction(getApp(), "default", "pr");
    expect(action.type).toBe("action");
    expect(action.action).toBe("create_pr");
  });

  it("returns fork type with defaults", async () => {
    writeUserFlow("fork-flow", {
      name: "fork-flow",
      stages: [{ name: "split", type: "fork", gate: "auto" }],
    });
    const action = await getStageAction(getApp(), "fork-flow", "split");
    expect(action.type).toBe("fork");
    expect(action.agent).toBe("implementer");
    expect(action.strategy).toBe("plan");
    expect(action.max_parallel).toBe(4);
  });

  it("returns fork type with custom values", async () => {
    writeUserFlow("fork-custom", {
      name: "fork-custom",
      stages: [
        {
          name: "split",
          type: "fork",
          gate: "auto",
          agent: "builder",
          strategy: "file",
          max_parallel: 8,
        },
      ],
    });
    const action = await getStageAction(getApp(), "fork-custom", "split");
    expect(action.type).toBe("fork");
    expect(action.agent).toBe("builder");
    expect(action.strategy).toBe("file");
    expect(action.max_parallel).toBe(8);
  });

  it("includes optional field when present", async () => {
    const action = await getStageAction(getApp(), "default", "audit");
    expect(action.optional).toBe(true);
  });

  it("on_failure and optional are undefined when not set", async () => {
    const action = await getStageAction(getApp(), "default", "pr");
    expect(action.on_failure).toBeUndefined();
    expect(action.optional).toBeUndefined();
  });

  it("returns auto_merge action for autonomous-sdlc merge stage", async () => {
    const action = await getStageAction(getApp(), "autonomous-sdlc", "merge");
    expect(action.type).toBe("action");
    expect(action.action).toBe("auto_merge");
  });
});

// ── autonomous-sdlc flow ────────────────────────────────────────────────────

describe("autonomous-sdlc flow", () => {
  it("includes merge stage after pr", async () => {
    const stages = await getStages(getApp(), "autonomous-sdlc");
    const names = stages.map((s) => s.name);
    expect(names).toEqual(["plan", "implement", "verify", "review", "pr", "merge"]);
  });

  it("merge stage depends on pr", async () => {
    const stage = await getStage(getApp(), "autonomous-sdlc", "merge");
    expect(stage).not.toBeNull();
    expect(stage!.depends_on).toEqual(["pr"]);
  });

  it("merge stage has auto gate", async () => {
    const result = await evaluateGate(getApp(), "autonomous-sdlc", "merge", {});
    expect(result.canProceed).toBe(true);
  });
});

// ── resolveFlow ─────────────────────────────────────────────────────────────

describe("resolveFlow", () => {
  it("substitutes variables in stage task field", async () => {
    writeUserFlow("task-flow", {
      name: "task-flow",
      stages: [
        { name: "plan", agent: "planner", gate: "auto", task: "Plan work for {{ticket}}: {{summary}}" },
        { name: "impl", agent: "worker", gate: "auto", task: "Implement {{ticket}} in {{repo}}" },
      ],
    });

    const flow = await resolveFlow(getApp(), "task-flow", { ticket: "PROJ-1", summary: "Fix bug", repo: "/code" });
    expect(flow).not.toBeNull();
    expect(flow!.stages[0].task).toBe("Plan work for PROJ-1: Fix bug");
    expect(flow!.stages[1].task).toBe("Implement PROJ-1 in /code");
  });

  it("substitutes variables in description", async () => {
    writeUserFlow("desc-flow", {
      name: "desc-flow",
      description: "Flow for {{ticket}} on {{branch}}",
      stages: [{ name: "s1", agent: "a", gate: "auto" }],
    });

    const flow = await resolveFlow(getApp(), "desc-flow", { ticket: "T-1", branch: "main" });
    expect(flow!.description).toBe("Flow for T-1 on main");
  });

  it("substitutes variables in on_failure", async () => {
    writeUserFlow("fail-flow", {
      name: "fail-flow",
      stages: [{ name: "s1", agent: "a", gate: "auto", on_failure: "notify({{ticket}})" }],
    });

    const flow = await resolveFlow(getApp(), "fail-flow", { ticket: "BUG-99" });
    expect(flow!.stages[0].on_failure).toBe("notify(BUG-99)");
  });

  it("preserves stages without templates", async () => {
    writeUserFlow("plain-flow", {
      name: "plain-flow",
      stages: [
        { name: "s1", agent: "planner", gate: "auto" },
        { name: "s2", agent: "worker", gate: "manual" },
      ],
    });

    const flow = await resolveFlow(getApp(), "plain-flow", { ticket: "X-1" });
    expect(flow).not.toBeNull();
    expect(flow!.stages[0].task).toBeUndefined();
    expect(flow!.stages[0].on_failure).toBeUndefined();
    expect(flow!.stages[0].name).toBe("s1");
    expect(flow!.stages[1].name).toBe("s2");
  });

  it("returns null for unknown flow", async () => {
    expect(await resolveFlow(getApp(), "nonexistent", { ticket: "X-1" })).toBeNull();
  });

  it("stage task field appears in loaded flow definition", async () => {
    writeUserFlow("task-field-flow", {
      name: "task-field-flow",
      stages: [{ name: "do-it", agent: "worker", gate: "auto", task: "Do the thing" }],
    });

    const flow = await getApp().flows.get("task-field-flow");
    expect(flow).not.toBeNull();
    expect(flow!.stages[0].task).toBe("Do the thing");
  });
});
