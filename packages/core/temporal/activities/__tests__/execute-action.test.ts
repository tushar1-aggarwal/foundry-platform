// packages/core/temporal/activities/__tests__/execute-action.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { executeActionActivity, injectDeps } from "../execute-action.js";
import type { OrchestrationDeps } from "../../../services/deps.js";
import { AppContext } from "../../../app.js";
import { depsFromApp } from "../../../services/deps.js";
import { ACTION_INDEX } from "../../../services/actions/index.js";

function stubDeps(overrides: Partial<OrchestrationDeps> = {}): OrchestrationDeps {
  const events: Array<{ type: string; data: unknown }> = [];
  const stub = {
    sessions: { get: async () => ({ id: "s-1", stage: "pr", flow: "docs" }) },
    events: { log: async (_sid: string, type: string, payload: any) => { events.push({ type, data: payload?.data }); } },
    db: { query: async () => [] },
    flows: { get: () => ({ stages: [{ name: "pr", action: "create_pr" }] }) },
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
  (stub as any)._events = events;
  return stub;
}

describe("executeActionActivity (happy path)", () => {
  beforeEach(() => {
    // Reset module state between tests so each test injects fresh deps.
  });

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
