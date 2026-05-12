import { test, expect, beforeAll, afterAll } from "bun:test";
import { dispatchStageActivity, injectDeps } from "../activities/dispatch-stage.js";
import { AppContext } from "../../app.js";
import { depsFromApp } from "../../services/deps.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

test("dispatchStageActivity runs without dispatch? callback", async () => {
  const session = await app.sessions.create({ flow: "e2e-docs", summary: "test-disp" });
  await app.sessions.update(session.id, { stage: "plan", status: "ready" });

  const deps = depsFromApp(app);
  // Phase 3 cutover: deps no longer carries dispatch?
  delete (deps as any).dispatch;
  injectDeps(deps);

  // Should not throw "dispatch callback not wired"; activity now constructs its own DispatchService.
  // The actual launch may succeed or surface a stubbed-callback error -- either is acceptable here.
  // Key assertion: NOT the "dispatch_failed: dispatch callback not wired" path.
  let result: any;
  let err: any;
  try {
    result = await dispatchStageActivity({ sessionId: session.id, stageIdx: 0 });
  } catch (e) {
    err = e;
  }
  // Phase 3 contract: the activity must not take the legacy early-return path
  // that logs dispatch_failed and silently returns {}.  That path is identified
  // by (a) no error AND (b) result is an empty object with no dispatch signal.
  // After Phase 3 the activity either throws (stubbed callback hit) or returns
  // a real DispatchStageResult. Either outcome is acceptable; the silent empty
  // return is not.
  const isSilentEmptyReturn = !err && result && Object.keys(result).length === 0;
  expect(isSilentEmptyReturn).toBe(false);

  if (err) {
    // A thrown error is fine -- it means DispatchService was invoked and hit a
    // stubbed Phase-3.5 callback. The only forbidden message is the legacy one.
    expect(String(err.message ?? err)).not.toMatch(/dispatch callback not wired/i);
  } else {
    expect(result).toBeDefined();
  }
});
