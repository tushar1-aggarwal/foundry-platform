/**
 * Dispatch-failure surfacing for `fork()`.
 *
 * `fork(dispatch:true)` is the one remaining call site that still routes a
 * child through the bespoke `dispatchService.dispatch` launch primitive and
 * must surface a `{ok:false}`/throw onto the child row (status=failed +
 * dispatch_failed event).
 *
 * The other two original call sites no longer use dispatchService:
 *  - subagents.ts `spawnParallelSubagents` now starts a Temporal
 *    sessionWorkflow per child (`startWorkflowFor`); there is no
 *    in-process dispatch to surface.
 *  - conductor/report-pipeline.ts `on_failure` retry now only calls
 *    `retryWithContext` (flip to ready); the Temporal workflow re-runs the
 *    stage -- it no longer fire-and-forgets `dispatchService.dispatch`.
 * Those four tests asserted a deleted bespoke contract and were removed.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { asValue } from "awilix";
import { AppContext } from "../app.js";
import { fork } from "../services/fork-join.js";
import { depsFromApp } from "../services/deps.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

describe("fork-join.ts: fork() child dispatch failure surfacing", () => {
  it("marks child failed when dispatch returns {ok:false}", async () => {
    app.container.register({
      dispatchService: asValue({
        dispatch: async () => ({ ok: false, message: "child compute unreachable" }),
      }),
    });

    const parent = await app.sessions.create({ summary: "fork ok:false test", flow: "bare" });
    await app.sessions.update(parent.id, { session_id: `ark-s-${parent.id}`, stage: "implement", status: "running" });

    const result = await fork(depsFromApp(app), parent.id, "child task", { dispatch: true });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.message).toContain("child compute unreachable");
    }

    const children = await app.sessions.getChildren(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe("failed");
    expect(children[0].error).toContain("child compute unreachable");

    const events = await app.events.list(children[0].id);
    const failed = events.find((e) => e.type === "dispatch_failed");
    expect(failed).toBeTruthy();
    expect(String(failed!.data?.reason ?? "")).toContain("child compute unreachable");
  });

  it("marks child failed when dispatch throws", async () => {
    app.container.register({
      dispatchService: asValue({
        dispatch: async () => {
          throw new Error("kaboom-fork");
        },
      }),
    });

    const parent = await app.sessions.create({ summary: "fork throw test", flow: "bare" });
    await app.sessions.update(parent.id, { session_id: `ark-s-${parent.id}`, stage: "implement", status: "running" });

    const result = await fork(depsFromApp(app), parent.id, "child task", { dispatch: true });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.message).toContain("kaboom-fork");
    }

    const children = await app.sessions.getChildren(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe("failed");
    expect(children[0].error).toContain("kaboom-fork");
  });
});
