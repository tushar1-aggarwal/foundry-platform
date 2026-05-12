/**
 * Tests for SessionService.approveReviewGate() / rejectReviewGate()
 * Temporal signal routing (Task 8 of Temporal Phase 3).
 *
 * When a session has orchestrator="temporal" and a workflow_id set, the
 * review-gate methods must send Temporal signals instead of calling the
 * legacy review-gate helper.
 *
 * Signal routing is verified by injecting a stub via the
 * `_temporalClientFactory` escape hatch on SessionService -- this avoids
 * trying to mutate ES-module live bindings (which Bun enforces as read-only).
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { setApp, clearApp } from "./test-helpers.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

// ---------------------------------------------------------------------------
// Guard: session not found
// ---------------------------------------------------------------------------

test("approveReviewGate returns ok:false for unknown session id", async () => {
  const result = await app.sessionService.approveReviewGate("non-existent-id");
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/not found/i);
});

test("rejectReviewGate returns ok:false for unknown session id", async () => {
  const result = await app.sessionService.rejectReviewGate("non-existent-id", "reason");
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/not found/i);
});

// ---------------------------------------------------------------------------
// Guard: workflow_id missing -- must return { ok: false } gracefully
// ---------------------------------------------------------------------------

test("approveReviewGate returns ok:false when session is temporal but has no workflow_id", async () => {
  const session = await app.sessions.create({ flow: "e2e-docs", summary: "gate-approve-no-wfid" });
  // Mark as temporal but leave workflow_id null (the default).
  await app.sessions.update(session.id, { orchestrator: "temporal" } as any);

  const result = await app.sessionService.approveReviewGate(session.id);
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/workflow_id/i);
});

test("rejectReviewGate returns ok:false when session is temporal but has no workflow_id", async () => {
  const session = await app.sessions.create({ flow: "e2e-docs", summary: "gate-reject-no-wfid" });
  await app.sessions.update(session.id, { orchestrator: "temporal" } as any);

  const result = await app.sessionService.rejectReviewGate(session.id, "looks wrong");
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/workflow_id/i);
});

// ---------------------------------------------------------------------------
// Signal routing: temporal + workflow_id -- inject stub via _temporalClientFactory
// ---------------------------------------------------------------------------

test("approveReviewGate sends approveReviewGate signal when session uses Temporal", async () => {
  const signaled: Array<{ name: string; payload: any }> = [];

  const svc = app.sessionService;
  const origFactory = (svc as any)._temporalClientFactory;
  (svc as any)._temporalClientFactory = async (_cfg: any) => ({
    workflow: {
      getHandle: (_wfId: string) => ({
        signal: async (name: string, payload: any) => {
          signaled.push({ name, payload });
        },
      }),
    },
  });

  try {
    const session = await app.sessions.create({ flow: "e2e-docs", summary: "test-approve-signal" });
    await app.sessions.update(session.id, {
      orchestrator: "temporal",
      workflow_id: `session-${session.id}`,
    } as any);

    const result = await svc.approveReviewGate(session.id);
    expect(result.ok).toBe(true);
    expect(signaled.length).toBe(1);
    expect(signaled[0].name).toBe("approveReviewGate");
    expect(signaled[0].payload.sessionId).toBe(session.id);
  } finally {
    (svc as any)._temporalClientFactory = origFactory;
  }
});

test("rejectReviewGate sends rejectReviewGate signal with reason when session uses Temporal", async () => {
  const signaled: Array<{ name: string; payload: any }> = [];

  const svc = app.sessionService;
  const origFactory = (svc as any)._temporalClientFactory;
  (svc as any)._temporalClientFactory = async (_cfg: any) => ({
    workflow: {
      getHandle: (_wfId: string) => ({
        signal: async (name: string, payload: any) => {
          signaled.push({ name, payload });
        },
      }),
    },
  });

  try {
    const session = await app.sessions.create({ flow: "e2e-docs", summary: "test-reject-signal" });
    await app.sessions.update(session.id, {
      orchestrator: "temporal",
      workflow_id: `session-${session.id}`,
    } as any);

    const result = await svc.rejectReviewGate(session.id, "looks wrong");
    expect(result.ok).toBe(true);
    expect(signaled.length).toBe(1);
    expect(signaled[0].name).toBe("rejectReviewGate");
    expect(signaled[0].payload.reason).toBe("looks wrong");
    expect(signaled[0].payload.sessionId).toBe(session.id);
  } finally {
    (svc as any)._temporalClientFactory = origFactory;
  }
});
