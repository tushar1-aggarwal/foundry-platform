// packages/core/temporal/activities/__tests__/execute-action.test.ts
import { describe, it, expect } from "bun:test";
import { executeActionActivity, injectDeps } from "../execute-action.js";
import { AppContext } from "../../../app.js";
import { depsFromApp } from "../../../services/deps.js";
import { ACTION_INDEX } from "../../../services/actions/index.js";

describe("executeActionActivity (happy path)", () => {
  it("emits action_executed on success (the success-signal contract; no action_skipped on the happy path)", async () => {
    // Use a real AppContext + real ACTION_INDEX so the test exercises the
    // actual executeAction -> handler chain. The activity's own
    // `d.events.log("action_executed", ...)` is captured via the events spy.
    let app: AppContext | null = null;
    try {
      app = await AppContext.forTestAsync();
      await app.boot();

      ACTION_INDEX.set("no_op_test_action", {
        name: "no_op_test_action",
        execute: async () => ({ ok: true, message: "no-op success" }),
      });

      const session = await app.sessions.create({ summary: "happy path", flow: "noop" });
      await app.sessions.update(session.id, { stage: "test" });

      const recorded: Array<{ type: string; data: unknown }> = [];
      const realDeps = depsFromApp(app);
      // Wrap events.log so we record activity-level emits AND inner executeAction
      // emits (depsFromApp aliases d.events === d.app.events, so one spy captures both).
      const origLog = realDeps.events.log.bind(realDeps.events);
      realDeps.events.log = async (sid: string, type: string, payload: any) => {
        recorded.push({ type, data: payload?.data });
        return origLog(sid, type, payload);
      };
      injectDeps(realDeps);

      await executeActionActivity({
        sessionId: session.id,
        stageIdx: 0,
        action: "no_op_test_action",
      });

      const types = recorded.map((e) => e.type);
      expect(types).toContain("action_executed");
      expect(types).not.toContain("action_skipped");
    } finally {
      ACTION_INDEX.delete("no_op_test_action");
      await app?.shutdown();
    }
  });
});

describe("executeActionActivity (idempotency, real db)", () => {
  it("calls handler exactly once when invoked twice with the same (sessionId, stageIdx, action)", async () => {
    const app = await AppContext.forTestAsync();
    await app.boot();

    try {
      let invocations = 0;
      ACTION_INDEX.set("count_invocations_test", {
        name: "count_invocations_test",
        execute: async () => {
          invocations += 1;
          return { ok: true, message: `invocation ${invocations}` };
        },
      });

      const session = await app.sessions.create({ summary: "idempotency test", flow: "noop" });
      await app.sessions.update(session.id, { stage: "test" });

      injectDeps(depsFromApp(app));

      // First call: real handler fires, ledger row inserted, invocations -> 1.
      await executeActionActivity({
        sessionId: session.id,
        stageIdx: 0,
        action: "count_invocations_test",
      });

      // Second call with identical key: withIdempotency sees the existing
      // ledger row keyed on op_kind="action:count_invocations_test" + the
      // idempotency key, and short-circuits with the cached result.
      await executeActionActivity({
        sessionId: session.id,
        stageIdx: 0,
        action: "count_invocations_test",
      });

      expect(invocations).toBe(1);
    } finally {
      ACTION_INDEX.delete("count_invocations_test");
      await app.shutdown();
    }
  });
});
