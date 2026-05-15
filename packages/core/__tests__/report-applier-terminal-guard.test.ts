/**
 * Terminal-status guard in ReportApplier.apply.
 *
 * Symmetric to the hook-status guard (hook-status-terminal-guard.test.ts).
 * The hook handler suppressed late SessionEnd events that would un-fail a
 * row, but the channel-report pipeline had no equivalent guard -- a stale
 * `completed` / `error` / `progress` report drained from an agent process
 * that outlived the stage's terminal transition could still flip status
 * from terminal back to `ready` / `failed` / `waiting`.
 *
 * Concretely:
 *   - `completed` would set status="ready" and trigger shouldAdvance
 *   - `error` would set status="failed"
 *   - `question` would set status="waiting"
 *   - `progress` would set status="running" if current status was "waiting"
 *
 * None of those transitions should fire when the session is already
 * `completed` / `failed` / `stopped` / `archived`. This test pins the
 * suppression by exercising all four report types.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import type { OutboundMessage } from "../services/channel/channel-types.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
});

async function makeTerminalSession(status: "completed" | "failed" | "stopped" | "archived") {
  const s = await app.sessions.create({ summary: "stale-report repro", flow: "quick" });
  await app.sessions.update(s.id, { status });
  const fresh = await app.sessions.get(s.id);
  expect(fresh?.status).toBe(status);
  return fresh!;
}

describe("ReportApplier terminal-status guard", () => {
  it("does not flip a failed session to ready on a late `completed` report", async () => {
    const session = await makeTerminalSession("failed");

    const report: OutboundMessage = {
      type: "completed",
      stage: "implement",
      summary: "agent finished after we already failed",
    } as unknown as OutboundMessage;

    const result = await app.sessionHooks.applyReport(session.id, report);

    expect(result.updates.status).toBeUndefined();
    expect(result.shouldAdvance).toBeFalsy();
    expect(result.shouldAutoDispatch).toBeFalsy();
    expect(result.message).toBeUndefined();
    expect(result.logEvents?.some((e) => e.type === "report_stale")).toBe(true);
  });

  it("does not flip a completed session to failed on a late `error` report", async () => {
    const session = await makeTerminalSession("completed");

    const report: OutboundMessage = {
      type: "error",
      stage: "implement",
      error: "agent died after we already completed",
    } as unknown as OutboundMessage;

    const result = await app.sessionHooks.applyReport(session.id, report);

    expect(result.updates.status).toBeUndefined();
    expect(result.shouldRetry).toBeFalsy();
    expect(result.logEvents?.some((e) => e.type === "report_stale")).toBe(true);
  });

  it("does not flip a stopped session to waiting on a late `question` report", async () => {
    const session = await makeTerminalSession("stopped");

    const report: OutboundMessage = {
      type: "question",
      stage: "implement",
      question: "are you still there",
    } as unknown as OutboundMessage;

    const result = await app.sessionHooks.applyReport(session.id, report);

    expect(result.updates.status).toBeUndefined();
    expect(result.updates.breakpoint_reason).toBeUndefined();
    expect(result.logEvents?.some((e) => e.type === "report_stale")).toBe(true);
  });

  it("does not flip an archived session to running on a late `progress` report", async () => {
    const session = await makeTerminalSession("archived");

    const report: OutboundMessage = {
      type: "progress",
      stage: "implement",
      message: "still chugging along",
    } as unknown as OutboundMessage;

    const result = await app.sessionHooks.applyReport(session.id, report);

    expect(result.updates.status).toBeUndefined();
    expect(result.logEvents?.some((e) => e.type === "report_stale")).toBe(true);
  });

  it("still applies state transitions on a non-terminal session (happy path)", async () => {
    const s = await app.sessions.create({ summary: "live session", flow: "quick" });
    await app.sessions.update(s.id, { status: "running", session_id: "tmux-stub" });

    const report: OutboundMessage = {
      type: "question",
      stage: "implement",
      question: "please confirm",
    } as unknown as OutboundMessage;

    const result = await app.sessionHooks.applyReport(s.id, report);

    expect(result.updates.status).toBe("waiting");
    expect(result.updates.breakpoint_reason).toBe("please confirm");
    expect(result.logEvents?.some((e) => e.type === "report_stale")).toBeFalsy();
  });
});
