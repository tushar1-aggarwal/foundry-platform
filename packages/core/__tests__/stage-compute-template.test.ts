/**
 * Tests for per-stage compute templates in flow definitions.
 *
 * Verifies that:
 * - StageDefinition accepts a compute_template field
 * - resolveComputeForStage resolves templates from DB and config
 * - Compute is auto-provisioned when template exists but compute doesn't
 * - Existing compute is reused when it matches the template name
 * - Null is returned when no template is specified or template not found
 * - Flow YAML with compute_template loads correctly
 */

import { legacyProviderLabel as providerOf } from "./_util/legacy-provider-label.js";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { AppContext } from "../app.js";
import { getStage, getStages } from "../services/flow.js";
import { depsFromApp } from "../services/deps.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

/** Directory where flow.ts looks for user flows. */
const flowDir = () => join(app.config.dirs.ark, "flows");

/** Write a YAML flow definition to the user flows directory. */
function writeUserFlow(name: string, def: Record<string, unknown>): void {
  const dir = flowDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

beforeEach(async () => {
  // Clean user flows dir so each test starts fresh
  rmSync(flowDir(), { recursive: true, force: true });
  // Clean templates
  for (const t of await app.computeTemplates.list()) {
    await app.computeTemplates.delete(t.name);
  }
});

// ── StageDefinition.compute_template field ──────────────────────────────────

describe("StageDefinition compute_template field", () => {
  it("loads compute_template from flow YAML", async () => {
    writeUserFlow("tmpl-flow", {
      name: "tmpl-flow",
      stages: [
        { name: "plan", agent: "planner", gate: "auto", compute_template: "fast-docker" },
        { name: "implement", agent: "implementer", gate: "auto", compute_template: "heavy-ec2" },
      ],
    });

    const stages = await getStages(depsFromApp(app), "tmpl-flow");
    expect(stages).toHaveLength(2);
    expect(stages[0].compute_template).toBe("fast-docker");
    expect(stages[1].compute_template).toBe("heavy-ec2");
  });

  it("compute_template is undefined when not specified", async () => {
    writeUserFlow("no-tmpl-flow", {
      name: "no-tmpl-flow",
      stages: [{ name: "work", agent: "worker", gate: "auto" }],
    });

    const stage = await getStage(depsFromApp(app), "no-tmpl-flow", "work");
    expect(stage).not.toBeNull();
    expect(stage!.compute_template).toBeUndefined();
  });

  it("only some stages can have compute_template", async () => {
    writeUserFlow("mixed-flow", {
      name: "mixed-flow",
      stages: [
        { name: "plan", agent: "planner", gate: "auto" },
        { name: "implement", agent: "implementer", gate: "auto", compute_template: "gpu-large" },
        { name: "review", agent: "reviewer", gate: "manual" },
      ],
    });

    const stages = await getStages(depsFromApp(app), "mixed-flow");
    expect(stages[0].compute_template).toBeUndefined();
    expect(stages[1].compute_template).toBe("gpu-large");
    expect(stages[2].compute_template).toBeUndefined();
  });
});

// ── resolveComputeForStage ─────────────────────────────────────────────────

describe("resolveComputeForStage", async () => {
  it("returns null when stageDef is null", async () => {
    const result = await app.dispatchService.resolveComputeForStage(null, "s-test");
    expect(result).toBeNull();
  });

  it("returns null when stage has no compute_template", async () => {
    const stageDef = { name: "work", gate: "auto" as const };
    const result = await app.dispatchService.resolveComputeForStage(stageDef, "s-test");
    expect(result).toBeNull();
  });

  it("returns null when template is not found in DB or config", async () => {
    const logs: string[] = [];
    const stageDef = { name: "work", gate: "auto" as const, compute_template: "nonexistent" };
    const result = await app.dispatchService.resolveComputeForStage(stageDef, "s-test", (m) => logs.push(m));
    expect(result).toBeNull();
    expect(logs.some((l) => l.includes("not found"))).toBe(true);
  });

  it("provisions compute from DB template when no existing compute", async () => {
    // Create a template in DB
    await app.computeTemplates.create({
      name: "fast-docker",
      compute: "local",
      isolation: "docker",
      config: { image: "node:20" },
    });

    const session = await app.sessions.create({ summary: "template-test" });
    const stageDef = { name: "implement", gate: "auto" as const, compute_template: "fast-docker" };
    const logs: string[] = [];

    const result = await app.dispatchService.resolveComputeForStage(stageDef, session.id, (m) => logs.push(m));
    // A template resolves to its own name -- no per-session clone row.
    // The provision path materializes an ephemeral pod from the spec.
    expect(result).toBe("fast-docker");

    // The resolved row is the template itself, untouched.
    const tmpl = await app.computes.get(result!);
    expect(tmpl).not.toBeNull();
    expect(tmpl!.is_template).toBe(true);
    expect(providerOf(tmpl!)).toBe("docker");

    // No clone row, no clone event.
    expect(await app.computes.get(`fast-docker-${session.id.slice(0, 8)}`)).toBeNull();
    const events = await app.events.list(session.id);
    expect(events.find((e) => e.type === "compute_cloned_from_template")).toBeUndefined();
  });

  it("resolves template from config when not in DB", async () => {
    // Temporarily add to config
    const originalTemplates = app.config.computeTemplates;
    app.config.computeTemplates = [
      { name: "config-tmpl", compute: "local", isolation: "docker", config: { image: "alpine" } },
    ];

    const session = await app.sessions.create({ summary: "config-test" });
    const stageDef = { name: "build", gate: "auto" as const, compute_template: "config-tmpl" };

    const result = await app.dispatchService.resolveComputeForStage(stageDef, session.id);
    // Config-only templates are seeded into a template row; resolution
    // returns the template name (materialized at provision, not cloned).
    expect(result).toBe("config-tmpl");

    const compute = await app.computes.get(result!);
    expect(compute).not.toBeNull();
    expect(compute!.is_template).toBe(true);
    expect(providerOf(compute!)).toBe("docker");

    // Restore config
    app.config.computeTemplates = originalTemplates;
    await app.computes.delete(result!);
  });
});

// ── Integration: flow YAML with compute_template ────────────────────────────

describe("flow with per-stage compute templates", () => {
  it("different stages can specify different compute templates", async () => {
    writeUserFlow("multi-compute-flow", {
      name: "multi-compute-flow",
      description: "Flow with per-stage compute",
      stages: [
        {
          name: "plan",
          agent: "planner",
          gate: "auto",
          compute_template: "lightweight",
        },
        {
          name: "implement",
          agent: "implementer",
          gate: "auto",
          compute_template: "heavy-gpu",
          on_failure: "retry(3)",
        },
        {
          name: "review",
          agent: "reviewer",
          gate: "manual",
        },
      ],
    });

    const flow = await app.flows.get("multi-compute-flow");
    expect(flow).not.toBeNull();
    expect(flow!.stages[0].compute_template).toBe("lightweight");
    expect(flow!.stages[1].compute_template).toBe("heavy-gpu");
    expect(flow!.stages[2].compute_template).toBeUndefined();
  });

  it("compute_template coexists with other stage fields", async () => {
    writeUserFlow("full-stage-flow", {
      name: "full-stage-flow",
      stages: [
        {
          name: "impl",
          agent: "implementer",
          gate: "auto",
          model: "opus",
          compute_template: "sandbox",
          verify: ["npm test"],
          on_failure: "retry(2)",
          task: "Implement {{summary}}",
        },
      ],
    });

    const stage = await getStage(depsFromApp(app), "full-stage-flow", "impl");
    expect(stage).not.toBeNull();
    expect(stage!.compute_template).toBe("sandbox");
    expect(stage!.model).toBe("opus");
    expect(stage!.verify).toEqual(["npm test"]);
    expect(stage!.on_failure).toBe("retry(2)");
    expect(stage!.task).toBe("Implement {{summary}}");
  });
});
