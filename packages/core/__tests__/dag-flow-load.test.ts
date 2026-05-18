import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { getStages, getStage, validateDAG } from "../services/flow.js";
import { depsFromApp } from "../services/deps.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

describe("dag-parallel flow", () => {
  test("loads with correct stages", async () => {
    const stages = await getStages(depsFromApp(app), "dag-parallel");
    expect(stages).toHaveLength(6);
    expect(stages.map((s) => s.name)).toEqual(["plan", "implement", "test", "integrate", "review", "pr"]);
  });

  test("implement and test depend on plan", async () => {
    const impl = await getStage(depsFromApp(app), "dag-parallel", "implement");
    const testStage = await getStage(depsFromApp(app), "dag-parallel", "test");
    expect(impl?.depends_on).toEqual(["plan"]);
    expect(testStage?.depends_on).toEqual(["plan"]);
  });

  test("integrate depends on both implement and test", async () => {
    const integrate = await getStage(depsFromApp(app), "dag-parallel", "integrate");
    expect(integrate?.depends_on).toEqual(["implement", "test"]);
  });

  test("DAG is valid (no cycles)", async () => {
    const stages = await getStages(depsFromApp(app), "dag-parallel");
    expect(() => validateDAG(stages)).not.toThrow();
  });
});
