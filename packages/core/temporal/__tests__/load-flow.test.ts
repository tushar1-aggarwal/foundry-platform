import { afterAll, beforeAll, test, expect } from "bun:test";
import { loadFlowActivity, injectDeps } from "../activities/load-flow.js";
import { AppContext } from "../../app.js";
import { depsFromApp } from "../../services/deps.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  injectDeps(depsFromApp(app));
});

afterAll(async () => {
  await app.shutdown();
});

test("loadFlowActivity returns parsed flow with topological order for e2e-docs", async () => {
  const flow = await loadFlowActivity({ flowName: "e2e-docs" });
  expect(flow.stages.length).toBe(3);
  expect(flow.stages.map((s: any) => s.name)).toEqual(["plan", "implement", "close"]);
  expect(flow.topoOrder).toEqual([0, 1, 2]);
});

test("loadFlowActivity throws on missing flow", async () => {
  await expect(loadFlowActivity({ flowName: "definitely-not-a-real-flow-name-xyz" })).rejects.toThrow();
});
