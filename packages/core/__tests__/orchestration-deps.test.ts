import { test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { depsFromApp } from "../services/deps.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

test("OrchestrationDeps does not carry a dispatch callback (Phase 3 cutover)", () => {
  const d = depsFromApp(app);
  expect((d as any).dispatch).toBeUndefined();
});
