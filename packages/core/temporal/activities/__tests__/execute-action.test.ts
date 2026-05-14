// packages/core/temporal/activities/__tests__/execute-action.test.ts
import { describe, it, expect } from "bun:test";
import { ApplicationFailure } from "@temporalio/common";
import { executeActionActivity, injectDeps } from "../execute-action.js";
import { AppContext } from "../../../app.js";
import { depsFromApp } from "../../../services/deps.js";
import type { OrchestrationDeps } from "../../../services/deps.js";
import { ACTION_INDEX } from "../../../services/actions/index.js";

function stubDeps(overrides: Partial<OrchestrationDeps> = {}): OrchestrationDeps {
  return {
    sessions: { get: async () => ({ id: "s-1", stage: "test", flow: "noop" }) },
    events: { log: async () => {} },
    db: { query: async () => [] },
    flows: { get: () => null },
    config: {} as any,
    secrets: {} as any,
    blobStore: {} as any,
    computes: {} as any,
    agents: {} as any,
    runtimes: {} as any,
    pluginRegistry: {} as any,
    flowStates: {} as any,
    statusPollers: {} as any,
    messages: {} as any,
    tenantId: "default",
    arkDir: "/tmp/test-ark",
    app: undefined,
    ...overrides,
  } as unknown as OrchestrationDeps;
}

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

describe("executeActionActivity (error classification + bypass + guard)", () => {
  // 5a: validation/not-found errors -> non-retryable
  it("5a -- wraps validation-class errors (session not found) as non-retryable ApplicationFailure", async () => {
    const deps = stubDeps({
      app: {
        sessions: { get: async () => null },
        events: { log: async () => {} },
        db: { query: async () => [] },
      } as any,
    });
    injectDeps(deps);

    let caught: unknown = null;
    try {
      await executeActionActivity({ sessionId: "s-missing", stageIdx: 0, action: "create_pr" });
    } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(ApplicationFailure);
    expect((caught as ApplicationFailure).nonRetryable).toBe(true);
    expect((caught as ApplicationFailure).message).toMatch(/not found/i);
  }, 30_000);

  // 5b: handler returns ok:false -> non-retryable
  it("5b -- wraps handler ok:false return as non-retryable ApplicationFailure", async () => {
    ACTION_INDEX.set("always_fails_test", {
      name: "always_fails_test",
      execute: async () => ({ ok: false, message: "deterministic test failure" }),
    });
    try {
      const app = await AppContext.forTestAsync();
      await app.boot();
      try {
        const session = await app.sessions.create({ summary: "ok:false test", flow: "noop" });
        await app.sessions.update(session.id, { stage: "test" });
        injectDeps(depsFromApp(app));

        let caught: unknown = null;
        try {
          await executeActionActivity({
            sessionId: session.id,
            stageIdx: 0,
            action: "always_fails_test",
          });
        } catch (e) { caught = e; }

        expect(caught).toBeInstanceOf(ApplicationFailure);
        expect((caught as ApplicationFailure).nonRetryable).toBe(true);
        expect((caught as ApplicationFailure).message).toMatch(/always_fails_test.*deterministic test failure/);
      } finally {
        await app.shutdown();
      }
    } finally {
      ACTION_INDEX.delete("always_fails_test");
    }
  }, 180_000);

  // 5c: non-validation errors -> retryable (bubble unchanged)
  it("5c -- lets transient/non-validation errors bubble as retryable", async () => {
    // Register an action that throws a raw transient error (no "validation|not found" keywords).
    ACTION_INDEX.set("transient_throw_test", {
      name: "transient_throw_test",
      execute: async () => { throw new Error("connection ECONNRESET to postgres"); },
    });
    try {
      const app = await AppContext.forTestAsync();
      await app.boot();
      try {
        const session = await app.sessions.create({ summary: "5c transient", flow: "noop" });
        await app.sessions.update(session.id, { stage: "test" });
        injectDeps(depsFromApp(app));

        let caught: unknown = null;
        try {
          await executeActionActivity({ sessionId: session.id, stageIdx: 0, action: "transient_throw_test" });
        } catch (e) { caught = e; }

        expect(caught).not.toBeInstanceOf(ApplicationFailure);
        expect((caught as Error).message).toMatch(/ECONNRESET/);
      } finally {
        await app.shutdown();
      }
    } finally {
      ACTION_INDEX.delete("transient_throw_test");
    }
  }, 180_000);

  // 5d: unknown action -> action_skipped, activity returns void (no throw)
  it("5d -- returns normally when action is unknown; inner executeAction emits action_skipped", async () => {
    let skippedPayload: { action?: string; reason?: string } | null = null;
    const deps = stubDeps({
      app: {
        sessions: { get: async () => ({ id: "s-uk", stage: "test", flow: "noop" }) },
        events: {
          log: async (_sid: string, type: string, payload: any) => {
            if (type === "action_skipped") skippedPayload = payload?.data ?? {};
          },
        },
        db: { query: async () => [] },
      } as any,
    });
    injectDeps(deps);

    await executeActionActivity({
      sessionId: "s-uk",
      stageIdx: 0,
      action: "no_such_action_in_registry",
    });

    expect(skippedPayload).not.toBeNull();
    expect(skippedPayload?.action).toBe("no_such_action_in_registry");
    expect(skippedPayload?.reason).toMatch(/unknown action/i);
  }, 30_000);

  // 5e: missing d.app -> non-retryable with specific operator-facing message
  it("5e -- throws non-retryable ApplicationFailure with specific message when d.app is undefined", async () => {
    injectDeps(stubDeps({ app: undefined }));

    let caught: unknown = null;
    try {
      await executeActionActivity({ sessionId: "s-1", stageIdx: 0, action: "close_ticket" });
    } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(ApplicationFailure);
    expect((caught as ApplicationFailure).nonRetryable).toBe(true);
    expect((caught as ApplicationFailure).message).toMatch(/OrchestrationDeps\.app is required/);
    expect((caught as ApplicationFailure).message).toMatch(/depsFromApp/);
  }, 30_000);
});
