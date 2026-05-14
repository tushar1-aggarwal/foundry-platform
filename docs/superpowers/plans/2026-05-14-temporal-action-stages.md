# Temporal Action-Stage Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Phase 3.x gap where `executeActionActivity` is a stub that emits `action_skipped` and returns. Wire it to actually invoke `executeAction()` (the bespoke action runner already used in non-Temporal mode) so action stages like `create_pr`, `merge`, `close` run end-to-end through the Temporal workflow, with proper retry classification and idempotency.

**Architecture:** Replace the stub body with a 3-step pipeline: (1) call the existing `executeAction(app, sessionId, action, { idempotencyKey })` via `buildAppShim(d)` from `dispatch-deps.ts`, reusing Phase 3.6's already-imported helper and the already-populated `d.app` escape hatch; (2) classify failures the same way `dispatchStageActivity` does — wrap validation/not-found errors as non-retryable `dispatchValidationError`, let everything else bubble so Temporal retries; (3) gate the call with `withIdempotency` via `d.db` (already exposed by Phase 3.6) so Temporal at-least-once retries don't double-execute the action handler. Integration test wires the existing `flaky_pr` test action through a real Temporal workflow against the e2e Postgres/Temporal stack, asserting both successful execution and retry-budget exhaustion paths.

**Tech Stack:** Bun + TypeScript, `@temporalio/worker` + `@temporalio/client`, Postgres (e2e stack on :15434), Temporal (e2e stack on :7234), `bun:test`. No new dependencies.

---

## Spec → tasks coverage map

| Spec requirement | Covered by task(s) |
|---|---|
| Activity invokes real action handler (not stub) — observable via `action_executed` event emitted by the activity on success | Task 2 (asserts emit), Task 3 (Step 1.5 adds the emit), Task 7 (real e2e assertion) |
| Idempotency: same (sessionId, stageIdx, action) → handler invoked once even when the activity is called twice | Task 4 (uses a real test action + real `withIdempotency`) — also implicitly exercised by Task 8 retries |
| Non-retryable errors (validation, not-found, handler ok:false) → `ApplicationFailure.nonRetryable=true` | Task 5a (validation), Task 5b (handler ok:false), Task 9 (real e2e) |
| Retryable errors (transient: ECONNRESET, etc.) bubble unchanged so Temporal retries per RetryPolicy | Task 5c (unit), Task 8 (real e2e via `flaky_pr`) |
| Unknown action → `action_skipped` emitted by inner `executeAction`, activity returns normally (no throw) | Task 5d (explicit unit test) |
| Missing `d.app` guard fires `ApplicationFailure.nonRetryable=true` with a specific operator-facing message (not NPE) | Task 5e (explicit unit test) |
| Activity registered with the Temporal worker AND deps injected at boot | Task 6 (manual inspection) + Tasks 7-9 (implicit: if unregistered, workflows fail with "activity not found") |
| Action stages (`create_pr`, `merge`, `close`, `flaky_pr`, `test_fail`) run end-to-end under Temporal — the action-wiring layer | Tasks 7-9 |
| **Full docs flow** (plan → implement → pr) under Temporal | **PARTIAL** — existing T1/T2 tests in `e2e/temporal-control-plane.test.ts` cover the agent stages with fake-claude; Tasks 7-9 cover the action stages with deterministic actions. The three-stage shape is the UNION of those, but no single test currently runs all three sequentially. See Out-of-scope. |
| Compute=k8s / compute=ec2 remote-routing path of handlers (`runGit` over arkd `/exec`) | **NOT covered** — see Out-of-scope |

## File structure

```
packages/core/temporal/activities/
  execute-action.ts                              [MODIFY] replace stub body, ~55 LOC
  __tests__/execute-action.test.ts               [CREATE] 7 unit tests across Tasks 2/4/5

packages/core/temporal/
  errors.ts                                      [READ-ONLY] exports `dispatchValidationError`

packages/core/services/actions/
  index.ts                                       [MODIFY] import + register testFailAction
                                                  under existing ARK_ENABLE_TEST_ACTIONS gate
  __tests__/
    flaky-pr-fixture.ts                          [READ-ONLY] existing test action — convention
                                                  reference for test-fail-fixture.ts placement
    test-fail-fixture.ts                         [CREATE] deterministic ok:false test action

e2e/fixtures/flows/
  close-only.yaml                                [CREATE if missing] one-stage flow for Task 7
  flaky-retry.yaml                               [CREATE if missing] one-stage flow for Task 8
  test-fail-only.yaml                            [CREATE]         one-stage flow for Task 9

e2e/
  temporal-control-plane.test.ts                 [MODIFY] un-skip close_ticket (Task 7) +
                                                  flaky_pr retries 3x (Task 8); add deterministic-
                                                  failure test (Task 9). Three new active tests.

docs/superpowers/plans/
  2026-05-14-temporal-action-stages.md           [THIS FILE]
```

The ~55-line edit in `execute-action.ts` is the entire production change. The `index.ts` change is two lines (one import + one registration entry). Everything else is tests + fixtures + plan.

---

## Task 1: Read existing infrastructure so the plan is grounded in real code

**Files:**
- Read: `packages/core/services/actions/index.ts:57-86` (the bespoke `executeAction` we're calling)
- Read: `packages/core/temporal/activities/dispatch-stage.ts:1-92` (the activity-pattern template, with error classification)
- Read: `packages/core/temporal/errors.ts` (defines `dispatchValidationError`)
- Read: `packages/core/services/idempotency.ts` (signature of `withIdempotency`)
- Read: `packages/core/temporal/activities/__tests__/dispatch-deps-execute-action.test.ts` (Phase 3.6 already wrote a related test — model on it)

- [ ] **Step 1: Read the four files above**

Run:
```bash
cat packages/core/services/actions/index.ts packages/core/temporal/activities/dispatch-stage.ts packages/core/temporal/errors.ts packages/core/services/idempotency.ts
ls packages/core/temporal/activities/__tests__/
```

Expected: You see `executeAction(app, sessionId, action, opts?)` returning `{ ok, message }`, the `dispatchValidationError(msg)` factory, and the pattern `let _deps; injectDeps; deps()`. Confirm that `withIdempotency(db, key, fn)` lives in `services/idempotency.ts` — note its exact signature, you'll need it in Task 4.

- [ ] **Step 2: Confirm OrchestrationDeps already has `db` and `app?`**

Run:
```bash
grep -nE "^  (db|app\??):" packages/core/services/deps.ts
```

Expected:
```
  db: DatabaseAdapter;
  app?: import("../app.js").AppContext;
```

If either is missing, this plan's preconditions are violated — STOP and consult.

- [ ] **Step 3: Note the workflow ID and activity timing for retries**

Run:
```bash
grep -nE "executeActionActivity|action_skipped|retryPolicy" packages/core/temporal/workflows/session-workflow.ts
```

Expected: the workflow calls `executeActionActivity` for non-agent stages, with whatever retry policy is in place. Read the lines and remember the policy — it determines how Task 8's retry test sets timeouts (the e2e budget needs to cover N attempts × the policy's exponential backoff).

---

## Task 2: TDD — unit test for happy-path handler dispatch

**Files:**
- Create: `packages/core/temporal/activities/__tests__/execute-action.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/temporal/activities/__tests__/execute-action.test.ts
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { executeActionActivity, injectDeps } from "../execute-action.js";
import type { OrchestrationDeps } from "../../../services/deps.js";

function stubDeps(overrides: Partial<OrchestrationDeps> = {}): OrchestrationDeps {
  const events: Array<{ type: string; data: unknown }> = [];
  const stub = {
    sessions: { get: async () => ({ id: "s-1", stage: "pr", flow: "docs" }) },
    events: { log: async (_sid: string, type: string, payload: any) => { events.push({ type, data: payload.data }); } },
    db: { query: async () => [] }, // withIdempotency's no-op happy path
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
    // We exercise the REAL executeAction via a real test action registered in
    // ACTION_INDEX. The activity's own `d.events.log("action_executed", …)` is
    // captured via the top-level events spy in stubDeps -- that's the contract
    // Task 3 Step 1 introduces.
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
      // Wrap events.log so we record activity-level emits AND let inner
      // executeAction also see the same spy (depsFromApp aliases d.events ===
      // d.app.events in production, so a single spy captures both layers).
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
```

- [ ] **Step 2: Run test, confirm it fails**

```bash
bun test packages/core/temporal/activities/__tests__/execute-action.test.ts
```

Expected: FAIL — the current stub emits `action_skipped`, never `action_executed`. The test catches the absence of the wiring.

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/core/temporal/activities/__tests__/execute-action.test.ts
git commit -m "chore: failing test for executeActionActivity action dispatch"
```

---

## Task 3: Implement the activity wiring — minimal happy path

**Files:**
- Modify: `packages/core/temporal/activities/execute-action.ts`

- [ ] **Step 1: Replace the stub body**

Replace the entire body of `executeActionActivity` (current lines 20-42) with:

```typescript
import type { OrchestrationDeps } from "../../services/deps.js";
import { executeAction } from "../../services/actions/index.js";
import { dispatchValidationError } from "../errors.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("executeActionActivity: deps not injected");
  return _deps;
}

/**
 * Execute a non-agent action stage (create_pr, merge, close, flaky_pr, ...).
 *
 * Phase 3.8: end-to-end wiring of the action runner through the Temporal worker.
 * Uses Phase 3.6's `d.app` escape hatch -- the worker boots its own AppContext
 * in worker.ts and injects it via depsFromApp, so the bespoke executeAction()
 * sees the full surface it expects without a refactor of its signature.
 *
 * Idempotency: executeAction internally wraps in withIdempotency(db, op_kind,
 * idempotencyKey) keyed on `action:<handler.name>`. The Temporal activity is
 * at-least-once; the ledger inside executeAction is the dedupe gate so retries
 * are safe even when the handler had side effects (PR creation, branch push).
 *
 * Error classification: dispatchValidationError marks the failure non-retryable
 * so the workflow surfaces it immediately instead of burning the retry budget.
 * Validation-class errors are "this action call is malformed" (unknown action,
 * session not found, missing prereq) -- retrying will not help. Other errors
 * (network blips, transient git failures) bubble unchanged so Temporal's
 * RetryPolicy can take a second pass.
 */
export async function executeActionActivity(input: {
  sessionId: string;
  stageIdx: number;
  action?: string;
}): Promise<void> {
  const d = deps();

  if (!input.action) {
    // No action specified -- nothing to execute. Workflow callers should not
    // reach this branch (project-stage activity is supposed to gate on
    // stage.action presence), but tolerate it for forward compat.
    return;
  }

  if (!d.app) {
    // The synthetic shim is intentionally narrow and doesn't carry the action
    // handlers' transitive deps (gh CLI invocations, git push wiring, etc.).
    // Hosted mode (the only consumer of this activity) always populates
    // d.app via depsFromApp in worker.ts -- if we got here without it, the
    // worker was misconfigured.
    throw dispatchValidationError(
      "executeActionActivity: OrchestrationDeps.app is required for action stages. " +
        "Boot worker via depsFromApp(app) so the AppContext is exposed.",
    );
  }

  // Stable idempotency key keyed on (workflowId attempt). Temporal does NOT
  // expose workflowId from inside an activity without Context.current(), but
  // (sessionId, stageIdx, action) is a stable triple per dispatch: the
  // workflow only retries the same (sessionId, stageIdx) with the same action.
  // executeAction's internal idempotency ledger sees identical keys on retry
  // and returns the cached result.
  const idempotencyKey = `${input.sessionId}:${input.stageIdx}:${input.action}`;

  try {
    const result = await executeAction(d.app, input.sessionId, input.action, { idempotencyKey });
    if (!result.ok) {
      // Handler returned a non-ok result -- this is a typed failure (e.g.
      // "PR already exists", "branch has no commits"). Wrap as non-retryable
      // so the workflow doesn't churn the retry budget on a deterministic
      // failure.
      throw dispatchValidationError(`Action '${input.action}' failed: ${result.message}`);
    }
    // Emit action_executed as the observable success signal. The inner
    // executeAction has no matching success event (it emits action_skipped
    // only for the unknown-action bypass), so without this line there is
    // no externally observable difference between "stub returned" and "real
    // handler ran". Tests in Task 7 and the operator UI both subscribe to
    // this event to confirm action stages are not silently skipped.
    await d.events.log(input.sessionId, "action_executed", {
      actor: "system",
      data: {
        action: input.action,
        stageIdx: input.stageIdx,
        message: result.message,
      },
    });
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    // If the action threw before we wrapped it, classify by message shape --
    // mirrors dispatch-stage.ts:86-91 so the two activities behave the same.
    if (/validation|not found|unknown action|missing prereq/i.test(msg)) {
      throw dispatchValidationError(msg);
    }
    throw e;
  }
}
```

- [ ] **Step 2: Run the unit test from Task 2**

```bash
bun test packages/core/temporal/activities/__tests__/execute-action.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the full activity test suite for regression**

```bash
bun test packages/core/temporal/activities/__tests__/
```

Expected: all tests pass, including pre-existing `dispatch-deps-execute-action.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/core/temporal/activities/execute-action.ts
git commit -m "feature: wire executeActionActivity to real action handlers (Phase 3.8)"
```

---

## Task 4: TDD — unit test for idempotency under retry (using real db + real `withIdempotency`)

**Files:**
- Modify: `packages/core/temporal/activities/__tests__/execute-action.test.ts`

**Why real db, not a mock:** the previous draft of this task hand-mocked `db.query` with regex matchers against the SQL `withIdempotency` runs. That's brittle — the mock can silently let both calls through if the real query shape ever changes. Using `AppContext.forTestAsync()` gives us a real in-memory sqlite + the real `withIdempotency` wiring, so the assertion is empirical.

- [ ] **Step 1: Add the test**

Append to the test file:

```typescript
import { AppContext } from "../../app.js";
import { depsFromApp } from "../../services/deps.js";
import { ACTION_INDEX } from "../../services/actions/index.js";

describe("executeActionActivity (idempotency, real db)", () => {
  it("calls handler exactly once when invoked twice with the same (sessionId, stageIdx, action)", async () => {
    // Real test AppContext: in-memory sqlite, full schema, tenant=default.
    // This is the canonical Ark test helper -- mirrors what existing tests
    // like packages/core/__tests__/claude-agent-probe-status.test.ts use.
    const app = await AppContext.forTestAsync();
    await app.boot();

    try {
      // Register a side-effect-counting test action. Mirrors the registration
      // pattern in packages/core/services/actions/__tests__/actions.test.ts.
      // Cleaned up in the finally block so this test doesn't pollute the
      // global registry for sibling tests.
      let invocations = 0;
      ACTION_INDEX.set("count_invocations_test", {
        name: "count_invocations_test",
        execute: async () => {
          invocations += 1;
          return { ok: true, message: `invocation ${invocations}` };
        },
      });

      // Seed a session row so executeAction's `app.sessions.get(sessionId)`
      // returns non-null. The session's stage doesn't need to match the
      // action's nominal stage -- executeAction only reads session.id and
      // session.stage for the idempotency ledger key.
      const session = await app.sessions.create({ summary: "idempotency test", flow: "noop" });
      await app.sessions.update(session.id, { stage: "test" });

      injectDeps(depsFromApp(app));

      // First call: real handler fires, ledger row inserted, invocations -> 1.
      await executeActionActivity({
        sessionId: session.id,
        stageIdx: 0,
        action: "count_invocations_test",
      });

      // Second call with IDENTICAL (sessionId, stageIdx, action): withIdempotency
      // sees the existing ledger row keyed on op_kind="action:count_invocations_test"
      // + (sessionId, stage, idempotencyKey) and short-circuits with the cached
      // result -- handler MUST NOT run again.
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
```

- [ ] **Step 2: Run, confirm it passes**

```bash
bun test packages/core/temporal/activities/__tests__/execute-action.test.ts -t idempotency
```

Expected: PASS. If `invocations === 2`, the activity isn't passing `idempotencyKey` to executeAction — re-check Task 3 Step 1's body. If `invocations === 0` on the first call, the test action wasn't registered before `injectDeps` — check that `ACTION_INDEX.set(...)` runs before `executeActionActivity(...)`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/temporal/activities/__tests__/execute-action.test.ts
git commit -m "chore: idempotency test for executeActionActivity using real db"
```

---

## Task 5: TDD — error classification + bypass + guard tests (5 cases)

**Files:**
- Modify: `packages/core/temporal/activities/__tests__/execute-action.test.ts`

Five distinct contracts get tested in this task. They share a describe block; each `it()` is one assertion.

- [ ] **Step 1: Add the tests**

Append:

```typescript
import { ApplicationFailure } from "@temporalio/common";
import { ACTION_INDEX } from "../../services/actions/index.js";

describe("executeActionActivity (error classification + bypass + guard)", () => {
  // ── 5a: validation/not-found errors → non-retryable ─────────────────────────
  it("5a — wraps validation-class errors (session not found) as non-retryable ApplicationFailure", async () => {
    const deps = stubDeps({
      app: {
        sessions: { get: async () => null }, // session not found
        events: { log: async () => {} },
        db: { query: async () => [] },
      } as any,
    });
    injectDeps(deps);

    let caught: unknown = null;
    try {
      await executeActionActivity({ sessionId: "s-missing", stageIdx: 0, action: "create_pr" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApplicationFailure);
    expect((caught as ApplicationFailure).nonRetryable).toBe(true);
    expect((caught as ApplicationFailure).message).toMatch(/not found/i);
  });

  // ── 5b: handler returns ok:false → non-retryable (deterministic failure) ────
  it("5b — wraps handler ok:false return as non-retryable ApplicationFailure", async () => {
    // Register a deterministic-failure test action so we don't depend on any
    // real handler's failure path. Cleaned up in afterEach.
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
        } catch (e) {
          caught = e;
        }

        expect(caught).toBeInstanceOf(ApplicationFailure);
        expect((caught as ApplicationFailure).nonRetryable).toBe(true);
        expect((caught as ApplicationFailure).message).toMatch(/always_fails_test.*deterministic test failure/);
      } finally {
        await app.shutdown();
      }
    } finally {
      ACTION_INDEX.delete("always_fails_test");
    }
  });

  // ── 5c: non-validation errors → retryable (bubble unchanged) ────────────────
  it("5c — lets transient/non-validation errors bubble as retryable", async () => {
    const deps = stubDeps({
      app: {
        sessions: { get: async () => ({ id: "s-3", stage: "pr", flow: "docs" }) },
        events: { log: async () => {} },
        db: {
          query: async () => {
            // Simulate transient DB error -- this should be retried.
            throw new Error("connection ECONNRESET to postgres");
          },
        },
      } as any,
    });
    injectDeps(deps);

    let caught: unknown = null;
    try {
      await executeActionActivity({ sessionId: "s-3", stageIdx: 0, action: "create_pr" });
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeInstanceOf(ApplicationFailure);
    expect((caught as Error).message).toMatch(/ECONNRESET/);
  });

  // ── 5d: unknown action → action_skipped, activity returns void (no throw) ───
  it("5d — returns normally when action is unknown; inner executeAction emits action_skipped", async () => {
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

    // Must not throw -- unknown action is a tolerated bypass, not a failure.
    await executeActionActivity({
      sessionId: "s-uk",
      stageIdx: 0,
      action: "no_such_action_in_registry",
    });

    expect(skippedPayload).not.toBeNull();
    expect(skippedPayload?.action).toBe("no_such_action_in_registry");
    expect(skippedPayload?.reason).toMatch(/unknown action/i);
  });

  // ── 5e: missing d.app → non-retryable with specific operator-facing message ─
  it("5e — throws non-retryable ApplicationFailure with specific message when d.app is undefined", async () => {
    injectDeps(stubDeps({ app: undefined }));

    let caught: unknown = null;
    try {
      await executeActionActivity({ sessionId: "s-1", stageIdx: 0, action: "close_ticket" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApplicationFailure);
    expect((caught as ApplicationFailure).nonRetryable).toBe(true);
    expect((caught as ApplicationFailure).message).toMatch(/OrchestrationDeps\.app is required/);
    expect((caught as ApplicationFailure).message).toMatch(/depsFromApp/); // operator-fix hint
  });
});
```

- [ ] **Step 2: Run, expect all 5 to pass**

```bash
bun test packages/core/temporal/activities/__tests__/execute-action.test.ts
```

Expected: 8/8 tests pass (Task 2 + Task 4 + 5 here). The non-retryable wrapping comes from Task 3's `dispatchValidationError`.

If 5b fails ("Cannot read properties of undefined"), the test action wasn't registered before `executeActionActivity` was called — check ordering of `ACTION_INDEX.set(...)` and `injectDeps(...)`.

If 5d fails because `events.log` was never called with `action_skipped`, the bespoke `executeAction` at `services/actions/index.ts:67-76` may have been refactored — re-read it to confirm the unknown-action branch still emits `action_skipped`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/temporal/activities/__tests__/execute-action.test.ts
git commit -m "chore: error/bypass/guard tests for executeActionActivity (5 cases)"
```

---

## Task 6: Verify activity is registered + reachable from the worker

**Files:**
- Modify (if needed): `packages/core/temporal/worker.ts`

- [ ] **Step 1: Inspect the worker's activity registration**

```bash
grep -nE "executeActionActivity|registerActivities|activities:" packages/core/temporal/worker.ts
```

Expected: `executeActionActivity` is already in the activities map (it was registered by the original Phase 1 stub). If not, add it to the `activities` map passed to the Temporal `Worker.create` call.

- [ ] **Step 2: Confirm worker injects deps via depsFromApp**

```bash
grep -nE "depsFromApp|injectDeps|d\.app" packages/core/temporal/worker.ts
```

Expected: Worker bootstraps an `AppContext` and calls `injectDeps(depsFromApp(app))` for each activity that calls `injectDeps`. If `execute-action`'s `injectDeps` isn't called, add it next to `dispatchStageActivity`'s injectDeps call.

- [ ] **Step 3: Commit if changes were needed (otherwise skip)**

```bash
git add packages/core/temporal/worker.ts
git commit -m "fix: register executeActionActivity deps injection in temporal worker"
```

---

## Task 7: TDD — integration test, happy path through real Temporal

**Files:**
- Modify: `e2e/temporal-control-plane.test.ts` (un-skip the `flaky_pr retries 3x` block AND add a happy-path test using a no-op action)

- [ ] **Step 1: Locate the existing skipped test**

```bash
grep -n "test\.skip\|flaky_pr\|close_ticket" e2e/temporal-control-plane.test.ts | head -10
```

Expected: 6 `test.skip` blocks per memory observation #802. Pick the simplest action-stage one (probably `session completes via close_ticket` or `flaky_pr retries 3x`).

- [ ] **Step 2: Replace `test.skip` with `test` for ONE action-stage test, happy path**

Find:
```typescript
test.skip("session completes via close_ticket action stage", async () => {
  // ...
});
```

Change to:
```typescript
test(
  "session completes via close_ticket action stage",
  async () => {
    // Boot is already done by the file-level beforeAll. Dispatch a session
    // whose flow ends in a `close_ticket` action stage (no LLM needed).
    const created = await rpc<{ session: Session }>("session/start", {
      flow: "close-only",
      summary: "smoke test for executeActionActivity wiring",
      compute_name: "local",
    });
    const sid = created.session.id;
    expect(created.session.orchestrator).toBe("temporal");

    // Wait for terminal state.
    const final = await waitForSessionState(
      sid,
      (s) => ["completed", "failed", "stopped"].includes(s.status),
      90_000,
      "session to reach terminal state",
    );

    expect(final.status).toBe("completed");

    // Critical assertion: action_executed (not action_skipped) was emitted.
    const events = await rpc<{ events: Array<{ type: string }> }>("session/events", { sessionId: sid });
    const types = events.events.map((e) => e.type);
    expect(types).toContain("action_executed");
    expect(types).not.toContain("action_skipped");
  },
  180_000,
);
```

- [ ] **Step 3: Add the `close-only` flow fixture if it doesn't exist**

Check:
```bash
ls e2e/fixtures/flows/ | grep close
```

If `close-only.yaml` is missing, create `e2e/fixtures/flows/close-only.yaml`:

```yaml
name: close-only
description: "Smoke flow for executeActionActivity -- one action stage, no LLM."
requires_repo: false
stages:
  - name: close
    action: close_ticket
    gate: auto
```

And ensure the test fixtures get registered (the existing `e2e/helpers/register-fixtures.ts` already handles this — confirm it scans the `e2e/fixtures/flows/` directory).

- [ ] **Step 4: Run the integration test**

```bash
make test-e2e-control-plane-up   # if stack not already up
bun test e2e/temporal-control-plane.test.ts --bail --timeout 240000 -t "close_ticket action stage"
```

Expected: PASS. Total runtime ~30-60s.

If the test fails with `action_skipped` instead of `action_executed`, the wiring in Task 3 didn't take effect for the worker — re-run after `make test-e2e-control-plane-down && make test-e2e-control-plane-up` to rebuild the worker image.

- [ ] **Step 5: Commit**

```bash
git add e2e/temporal-control-plane.test.ts e2e/fixtures/flows/close-only.yaml
git commit -m "feature: e2e/temporal-control-plane covers close_ticket action stage end-to-end"
```

---

## Task 8: TDD — integration test, retry budget exhaustion

**Files:**
- Modify: `e2e/temporal-control-plane.test.ts` (un-skip the `flaky_pr retries 3x` block)

- [ ] **Step 1: Replace the second skipped test**

Find `test.skip("flaky_pr retries 3x", ...)` and change to `test(...)`. Body:

```typescript
test(
  "flaky_pr fails on first attempt, succeeds on the third (retry budget exhausted-1)",
  async () => {
    // flaky_pr is registered when ARK_ENABLE_TEST_ACTIONS=1. The compose
    // worker has that env set (.infra/docker-compose.e2e.yaml:156).
    // flaky_pr fails the first two attempts then succeeds; Temporal's
    // activity RetryPolicy allows up to 3 attempts.
    const created = await rpc<{ session: Session }>("session/start", {
      flow: "flaky-retry",
      summary: "verify Temporal retries action stages per RetryPolicy",
      compute_name: "local",
    });
    const sid = created.session.id;

    const final = await waitForSessionState(
      sid,
      (s) => ["completed", "failed", "stopped"].includes(s.status),
      180_000,
      "flaky_pr session to reach terminal",
    );

    expect(final.status).toBe("completed");

    // Verify exactly 3 attempts: 2 action_failed + 1 action_executed.
    const events = await rpc<{ events: Array<{ type: string; data?: any }> }>(
      "session/events",
      { sessionId: sid },
    );
    const actionEvents = events.events.filter((e) =>
      e.type === "action_executed" || e.type === "action_failed",
    );
    expect(actionEvents.length).toBe(3);
    expect(actionEvents[actionEvents.length - 1].type).toBe("action_executed");
  },
  240_000,
);
```

- [ ] **Step 2: Add the `flaky-retry` flow fixture if missing**

```bash
ls e2e/fixtures/flows/ | grep -i flaky
```

If missing, create `e2e/fixtures/flows/flaky-retry.yaml`:

```yaml
name: flaky-retry
description: "Smoke flow for executeActionActivity retry behavior using flaky_pr action."
requires_repo: false
stages:
  - name: flaky
    action: flaky_pr
    gate: auto
    on_failure: "retry(3)"
```

- [ ] **Step 3: Run**

```bash
bun test e2e/temporal-control-plane.test.ts --bail --timeout 300000 -t "flaky_pr fails on first"
```

Expected: PASS. Total runtime ~60-180s due to Temporal's exponential backoff between attempts.

- [ ] **Step 4: Commit**

```bash
git add e2e/temporal-control-plane.test.ts e2e/fixtures/flows/flaky-retry.yaml
git commit -m "feature: e2e/temporal-control-plane covers flaky_pr retry budget end-to-end"
```

---

## Task 9: TDD — integration test, deterministic action failure fails fast

**Files:**
- Create: `packages/core/services/actions/__tests__/test-fail-fixture.ts` (under `__tests__/` to match the existing `flaky-pr-fixture.ts` convention — test-only fixtures live with the tests, not in the prod action source dir)
- Modify: `packages/core/services/actions/index.ts` (import from `./__tests__/test-fail-fixture.js`, register conditionally on `ARK_ENABLE_TEST_ACTIONS`)
- Create: `e2e/fixtures/flows/test-fail-only.yaml`
- Modify: `e2e/temporal-control-plane.test.ts`

**Why a dedicated `test_fail` action, not `create_pr`:** the prior draft of this task dispatched a `create_pr`-only flow against a bogus Bitbucket URL and asserted the session failed in < 30s. That setup is fragile — a session with no prior stages has no worktree, so `create_pr` fails at "no worktree to push" / "no commits" rather than the intended "remote not found" path. The failure class might not even be deterministic (depends on which check fires first in `createWorktreePR`'s preflight). A purpose-built action that **always** returns `{ok: false, message: "..."}` makes the test path unambiguous: we are testing the activity's wrapper, not any particular handler's failure modes.

**Why under `__tests__/`:** the project's existing test action (`flaky_pr`) is at `packages/core/services/actions/__tests__/flaky-pr-fixture.ts` and imported into the prod `index.ts` (line 12) but only registered when `ARK_ENABLE_TEST_ACTIONS` is set (line 25). Placing test fixtures under `__tests__/` makes them visually distinct from prod handlers, keeps `tsconfig.json`'s test-exclusion rules consistent, and matches the established Ark pattern. **Do not** put test-only fixtures in the top-level actions source directory.

- [ ] **Step 1: Create the test action fixture**

`packages/core/services/actions/__tests__/test-fail-fixture.ts`:

```typescript
import type { ActionHandler } from "../types.js";

/**
 * Test-only action that always returns ok:false. Lets integration tests
 * exercise executeActionActivity's deterministic-failure wrapping path
 * (handler returns ok:false → activity wraps as ApplicationFailure
 * nonRetryable=true) without relying on any real handler's failure modes.
 *
 * Registered only when ARK_ENABLE_TEST_ACTIONS=1 (the compose temporal-worker
 * sets this at `.infra/docker-compose.e2e.yaml:156`). Production builds never
 * have the env var set, so the action never makes it into ACTION_INDEX.
 *
 * Mirrors the location convention of `flaky-pr-fixture.ts` next to it.
 */
export const testFailAction: ActionHandler = {
  name: "test_fail",
  execute: async () => ({
    ok: false,
    message: "test_fail: deterministic failure for testing -- this is non-retryable by design",
  }),
};
```

- [ ] **Step 2: Register under the existing test-actions gate**

The existing `flaky_pr` registration is already present in `packages/core/services/actions/index.ts` at lines 12 and 23-25 — `testFailAction` registers right next to it, matching the exact same pattern.

Find the existing block:

```bash
grep -nE "flakyPrAction|ARK_ENABLE_TEST_ACTIONS" packages/core/services/actions/index.ts
```

Expected: line 12 has `import { flakyPrAction } from "./__tests__/flaky-pr-fixture.js";`, line ~23-25 spreads `flakyPrAction` into a conditional array gated on `ARK_ENABLE_TEST_ACTIONS`.

Make two edits:

```typescript
// Top of file, alongside the existing flakyPrAction import:
import { flakyPrAction } from "./__tests__/flaky-pr-fixture.js";
import { testFailAction } from "./__tests__/test-fail-fixture.js";  // ← add

// In the conditional spread (the existing ARK_ENABLE_TEST_ACTIONS block):
...(process.env.ARK_ENABLE_TEST_ACTIONS ? [flakyPrAction, testFailAction] : []),  // ← add testFailAction
```

Match the file's existing style exactly. If the registration uses `ACTION_INDEX.set(...)` instead of a spread, follow that pattern.

- [ ] **Step 3: Add the flow fixture**

`e2e/fixtures/flows/test-fail-only.yaml`:

```yaml
name: test-fail-only
description: "Smoke flow for deterministic-failure path in executeActionActivity."
requires_repo: false
stages:
  - name: fail
    action: test_fail
    gate: auto
```

- [ ] **Step 4: Add the integration test**

Append to `e2e/temporal-control-plane.test.ts`:

```typescript
test(
  "deterministic action failure (handler returns ok:false) fails fast without retry budget burn",
  async () => {
    // Dispatch a flow whose single stage runs the `test_fail` test action,
    // which deterministically returns {ok: false}. executeActionActivity
    // wraps that as ApplicationFailure(nonRetryable=true). Temporal stops
    // retrying immediately; session.status flips to "failed" in < 30s.
    // (Compare to flaky_pr at Task 8 which fails-then-recovers across the
    // RetryPolicy budget -- the wall-clock contrast is the proof.)
    const t0 = Date.now();
    const created = await rpc<{ session: Session }>("session/start", {
      flow: "test-fail-only",
      summary: "verify non-retryable action errors fail fast",
      compute_name: "local",
    });
    const sid = created.session.id;

    const final = await waitForSessionState(
      sid,
      (s) => s.status === "failed",
      60_000,
      "test_fail action stage to fail non-retryably",
    );

    const elapsed = Date.now() - t0;
    expect(final.status).toBe("failed");
    expect(elapsed).toBeLessThan(30_000); // No retries -> fast fail.
    expect(final.error).toBeTruthy();
    expect(final.error).toMatch(/test_fail.*deterministic/i);
  },
  90_000,
);
```

- [ ] **Step 5: Verify the test-fail fixture registers in the worker image**

Because Task 9's test runs against the e2e compose worker, the new file `packages/core/services/actions/__tests__/test-fail-fixture.ts` must end up in that worker's image. Confirm:

```bash
# The compose worker uses repo root as build context, so files anywhere
# under packages/core/ -- including under __tests__/ -- ship automatically
# with `docker compose up --build`. Confirm there's no .dockerignore
# excluding __tests__:
grep -n "context:\|dockerfile:" .infra/docker-compose.e2e.yaml | head -5
grep -nE "__tests__|\\*\\.test\\.ts" .dockerignore 2>/dev/null | head
```

Expected: the temporal-worker service has `context: ..` (the repo root) and `dockerfile: .infra/Dockerfile.temporal-worker`. `.dockerignore` may exclude `*.test.ts` (test runners themselves) but should NOT exclude `__tests__/` directories — the `flaky-pr-fixture.ts` already lives under `__tests__/` and is imported by prod code, so the directory must be included in the build. If `.dockerignore` excludes `__tests__/`, the existing flaky_pr path would already be broken — confirm with the next step.

Verify both fixtures end up in the image:
```bash
docker compose -f .infra/docker-compose.e2e.yaml -p ark-e2e exec -T temporal-worker \
  ls packages/core/services/actions/__tests__/ 2>&1 | head
```

Expected: shows `flaky-pr-fixture.ts` and `test-fail-fixture.ts` (after rebuild).

- [ ] **Step 6: Run**

```bash
make test-e2e-control-plane-down
make test-e2e-control-plane-up   # rebuilds worker image with the new action
bun test e2e/temporal-control-plane.test.ts --bail --timeout 120000 -t "deterministic action failure"
```

Expected: PASS in < 30s wall-clock.

- [ ] **Step 7: Commit**

```bash
git add packages/core/services/actions/__tests__/test-fail-fixture.ts \
        packages/core/services/actions/index.ts \
        e2e/fixtures/flows/test-fail-only.yaml \
        e2e/temporal-control-plane.test.ts
git commit -m "feature: test_fail fixture + e2e coverage for non-retryable action failure"
```

---

## Task 10: Run the full e2e suite as the regression gate

**Files:** none (just running existing tests)

- [ ] **Step 1: Bring up the e2e stack fresh**

```bash
make test-e2e-control-plane-down
make test-e2e-control-plane-up
```

Expected: All compose services come up healthy. The temporal-worker container rebuilds with the new `execute-action.ts` (the build context is the repo root, so the change ships automatically).

- [ ] **Step 2: Run the full Temporal control-plane suite**

```bash
bun test e2e/temporal-control-plane.test.ts --bail --timeout 300000
```

Expected: All previously-active tests (2) PLUS the three new ones added in Tasks 7-9 pass. Total runtime ~5-10 min.

If anything regresses, do NOT proceed to Task 11 — fix the regression first.

- [ ] **Step 3: Run the broader e2e gate**

```bash
make test
```

Expected: PASS (no unit-test regressions from the activity change).

---

## Task 11: Update CHANGELOG and the Phase 3.x status memory note

**Files:**
- Modify: `CHANGELOG.md`
- Read-only: `~/.claude/projects/-Users-zineng-featureScala-ark/memory/project_temporal_integration.md` (the user's memory note)

- [ ] **Step 1: Add a CHANGELOG entry**

Prepend to the top of `CHANGELOG.md` (under the current unreleased section, follow the file's existing format):

```markdown
### Phase 3.8 — Temporal action-stage wiring

- `executeActionActivity` now invokes the real action runner via `d.app` (was a Phase 1 stub emitting `action_skipped`)
- Workflow-driven `create_pr`, `merge`, `close`, `flaky_pr` and all other registered actions run end-to-end under Temporal
- Errors classified: validation/not-found / handler ok:false → non-retryable; everything else → retried per RetryPolicy
- Idempotency preserved via existing `withIdempotency(db, op_kind, idempotencyKey)` ledger inside `executeAction`
- E2E coverage: 3 new tests in `e2e/temporal-control-plane.test.ts` (close, flaky retry, deterministic-failure fast-fail) — compute=local only; remote-compute coverage tracked separately
```

- [ ] **Step 2: Suggest updating the memory note**

Tell the user (not in the commit) to update `memory/project_temporal_integration.md` to reflect that Phase 3.8 closed the action-stage gap. The memory note currently says "T3-T5 stubbed; Phase 3 will drive dispatch from workflow" — append a Phase 3.8 line.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "chore: document Phase 3.8 action-stage wiring"
```

---

## Verification before declaring complete

- [ ] **Step 1: All commits land cleanly**

```bash
git log --oneline -10
```

Expected: 8-10 new commits in the chain, all referencing Phase 3.8 / executeActionActivity / e2e coverage. No `--amend` or `--no-verify` flags used anywhere.

- [ ] **Step 2: Run the entire test pyramid one more time**

```bash
make test                          # unit tests
bun test e2e/temporal-control-plane.test.ts --bail --timeout 300000   # Temporal e2e
```

Expected: Both pass. The Temporal e2e (which now includes the 3 new action-stage tests added in Tasks 7-9) is the user-visible proof of Phase 3.8 — `action_executed` events fire instead of `action_skipped`, retry budgets work, deterministic failures fail fast.

- [ ] **Step 3: Manual dispatch of a docs flow**

Re-run the laptop control-plane stack and dispatch a docs flow session:

```bash
make dev-control-plane-down
make dev-control-plane
# in another terminal:
curl -sf -X POST http://localhost:8421/api/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"session/start","params":{"flow":"docs","summary":"Phase 3.8 smoke","repo":"git@bitbucket.org:paytmteam/foundry-test-repo.git","compute_name":"local"}}'
```

Watch the session in the web UI at http://localhost:8421/#/sessions/<id>. The pr stage should run, NOT skip, and produce a real PR URL. This is the same dispatch shape that motivated this whole plan.

- [ ] **Step 4: Open a draft PR**

```bash
gh pr create --draft --title "feature: Phase 3.8 -- wire executeActionActivity to real action runner" \
  --body "Closes the action-stage gap in the Temporal control-plane path. See docs/superpowers/plans/2026-05-14-temporal-action-stages.md for the full plan."
```

---

## Risk register

| Risk | Mitigation |
|---|---|
| The worker's `depsFromApp` doesn't populate `d.app` (e.g. if the worker uses a different deps builder) | Task 6 verifies this explicitly. If `d.app` is null, fail with a clear error rather than NPE deep in the action handler. |
| `executeAction`'s internal `withIdempotency` ledger row leaks across sessions if `idempotencyKey` collides | Key is `(sessionId, stageIdx, action)` — globally unique by construction. |
| Bedrock-compat proxy isn't running on the worker, so the action handler that shells out to git push (HTTPS-via-token) hangs | Out of scope — action handlers don't talk to the LLM gateway; the bedrock proxy only fronts model traffic. Tasks 7-9 use deterministic test actions that exercise the action-runner wiring directly. |
| Existing e2e Temporal tests regress because the worker now runs real action handlers (could touch shared state) | Task 10 is the regression gate. The action tests use isolated test-only flows (`close-only`, `flaky-retry`, `create-pr-only`) so they don't share state with the existing 2 active tests. |
| `flaky_pr` action behavior depends on `ARK_ENABLE_TEST_ACTIONS=1` — if that env isn't set in the worker, Task 8 fails | The compose worker has it set at `.infra/docker-compose.e2e.yaml:156`. Verified in Task 8 Step 1. |

---

## Out-of-scope (deliberately)

- **Compute=k8s / compute=ec2 e2e coverage** — Tasks 7-9 exercise `compute=local` exclusively. The action handler's `routing.remote=true` branch (where git push goes through remote-arkd `/exec` HTTP instead of local `execFile`) is a real prod-shape codepath that this plan does NOT exercise. Closing this gap requires standing up a kind-based cluster (already pending as task #2 in the backlog) OR a protected dev-namespace in prod EKS. Either approach takes ~1 day of test-infra work, separate from this Phase 3.8 wiring change. The two can land independently — this PR is safe to merge before the kind work because the activity wiring itself (the only production change in this plan) is compute-agnostic.
- **Real-LLM end-to-end happy path with real PR creation** — Removed from this plan per scoping. The action-stage wiring is proven by the deterministic test actions in Tasks 7-9 (`close_ticket`, `flaky_pr`, `create_pr` against a bogus repo). Adding an LLM-in-the-loop test (real Claude → real plan/implement → real PR) is valuable but adds ~10 min/run and external dependencies (TFY auth, Bitbucket creds, real LLM token spend); track as a separate validation pass once Phase 3.8 lands.
- **`run-verification.ts` Phase 1 stub** — separate concern; that stub is for *verification* stages, which the bespoke engine itself doesn't fully implement either. Track as a follow-up.
- **`gh pr create` on remote compute (EC2/K8s)** — per `pr.ts:394-398`, `gh` is not installed in the remote pod. The bespoke path has the same limitation. Phase 3.8 inherits it. Track as a follow-up.
- **`SessionScheduler` wiring in Temporal worker** — `dispatch-deps.ts:174` TODO. Unrelated to action stages.
- **Renaming "Phase 3.x" labels in source comments** — cosmetic; the existing labels (Phase 1 stub, Phase 3 will wire, etc.) become stale after this PR. Leave for a tidy-up sweep.
