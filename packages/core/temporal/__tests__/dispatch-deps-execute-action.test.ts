import { test, expect, beforeAll, afterAll } from "bun:test";
import { buildDispatchDeps } from "../activities/dispatch-deps.js";
import { AppContext } from "../../app.js";
import { depsFromApp } from "../../services/deps.js";

let app: any;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

test("buildDispatchDeps.executeAction runs close_ticket action without Phase 3.5 stub", async () => {
  const deps = buildDispatchDeps(depsFromApp(app));
  const session = await app.sessions.create({ flow: "e2e-docs", summary: "exec-action-test" });
  await app.sessions.update(session.id, { stage: "close", status: "ready" } as any);

  let err: any;
  try {
    await deps.executeAction(session.id, "close_ticket");
  } catch (e) {
    err = e;
  }
  if (err) {
    expect(String(err.message ?? err)).not.toMatch(/not yet ported.*Phase 3\.5/i);
  }
  // close_ticket should either return ok:true or skip (both acceptable in unit test)
});
