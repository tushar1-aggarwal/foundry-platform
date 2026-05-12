import { test, expect, afterEach } from "bun:test";
import { buildDispatchDeps } from "../activities/dispatch-deps.js";
import { AppContext } from "../../app.js";
import { depsFromApp } from "../../services/deps.js";

let app: AppContext | null = null;
afterEach(async () => {
  if (app) await app.shutdown();
  app = null;
});

test("buildDispatchDeps returns a DispatchDeps with all required fields", async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  const orchDeps = depsFromApp(app);
  const dispatchDeps = buildDispatchDeps(orchDeps);

  expect(dispatchDeps.sessions).toBeDefined();
  expect(dispatchDeps.events).toBeDefined();
  expect(dispatchDeps.computes).toBeDefined();
  expect(dispatchDeps.flows).toBeDefined();
  expect(dispatchDeps.blobStore).toBeDefined();
  expect((dispatchDeps as any).app).toBeUndefined();
});

// ── Diagnostic error messages for not-yet-ported callbacks ───────────────────
//
// The notPortedYet stubs are the boundary between "ported to Temporal" and
// "still bespoke-only". When an operator hits one, they need actionable
// guidance -- which Temporal-vs-bespoke knob to flip, or which flow shape to
// avoid -- not a generic "Phase 3.5" sentinel. These tests pin the message
// shape so a future refactor can't quietly regress to opaque errors.

test("dispatchChild throws with for_each-aware guidance under Temporal", async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  const dispatchDeps = buildDispatchDeps(depsFromApp(app));

  // Sync throw bubbles through await; toThrow handles both async and sync.
  expect(() => dispatchDeps.dispatchChild("child-id")).toThrow(/for_each/);
  expect(() => dispatchDeps.dispatchChild("child-id")).toThrow(/ARK_TEMPORAL_ORCHESTRATION/);
});

test("fork throws explaining it is unreachable under Temporal (fan_out branch handles it)", async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  const dispatchDeps = buildDispatchDeps(depsFromApp(app));

  // The workflow's fan_out branch (session-workflow.ts) consumes `type: fork`
  // stages before the bespoke FanOutDispatcher path can run. If this fires
  // the operator hit an unexpected code path -- the message should say so.
  expect(() => dispatchDeps.fork("parent", "task", { dispatch: true })).toThrow(/fan_out/);
  expect(() => dispatchDeps.fork("parent", "task", { dispatch: true })).toThrow(/unreachable|unexpected/i);
});

test("computeService.cloneTemplate throws with disable-temporal guidance", async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  const dispatchDeps = buildDispatchDeps(depsFromApp(app));

  // Per-stage compute template clones (`stage.compute: <template-name>`) are
  // routed via ComputeResolver, which hits computeService.cloneTemplate.
  // Operators hitting this need to know which knob to flip.
  expect(() => dispatchDeps.computeService.cloneTemplate("tmpl", { name: "session-x" } as any)).toThrow(
    /compute template/,
  );
  expect(() => dispatchDeps.computeService.cloneTemplate("tmpl", { name: "session-x" } as any)).toThrow(
    /ARK_TEMPORAL_ORCHESTRATION/,
  );
});
