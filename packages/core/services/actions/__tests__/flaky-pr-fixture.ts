/**
 * flaky-pr -- test-only action that fails N times then succeeds.
 *
 * Unit test usage: `runFlakyPr({ failTimes, error })` returns a handle with
 * an `invoke()` method. The call counter is kept inside the closure, so it
 * resets per `runFlakyPr()` call -- ideal for unit tests.
 *
 * Temporal e2e usage (ActionHandler): each activity attempt calls
 * `handler.execute(app, session, ...)` as a fresh invocation, so the in-closure
 * counter would reset on every retry. To persist the attempt count across
 * Temporal retries we write a `flaky_pr_attempt` event on every call and read
 * back the count from `app.events.list`. The events table is durable storage
 * that survives activity retries within the same workflow run.
 *
 * Decision: events.log/list was chosen over a session config field because:
 *   1. It requires no schema change (events table already exists and is flexible).
 *   2. It leaves an audit trail of every attempt, which helps debugging.
 *   3. It does not pollute session config with test-only state.
 */

import type { ActionHandler } from "../types.js";
import { authError, validationError } from "../../../temporal/errors.js";

export interface FlakyPrConfig {
  failTimes: number;
  error: string;
}

/** In-process handle returned by `runFlakyPr` -- used in unit tests. */
export function runFlakyPr(config: FlakyPrConfig) {
  let calls = 0;
  return {
    invoke: async () => {
      calls++;
      if (calls <= config.failTimes) {
        if (config.error === "AuthError") throw authError("flaky-pr: AuthError -- auth failed");
        if (config.error === "ValidationError") throw validationError("flaky-pr: validation failed");
        throw new Error(config.error);
      }
      return { ok: true, pr_url: "https://example.com/pr/1", calls };
    },
  };
}

/**
 * ActionHandler registration for flow YAML `action: flaky_pr`.
 *
 * Stage config (from flow YAML):
 *   config:
 *     fail_times: 3          # number of failures before succeeding
 *     error: "503 service unavailable"   # or "AuthError" / "ValidationError"
 *
 * Cross-attempt persistence: each invocation logs a `flaky_pr_attempt` event.
 * The handler counts those events to determine how many times it has already
 * been called for this session+stage, making the failure count durable across
 * Temporal activity retries.
 */
export const flakyPrAction: ActionHandler = {
  name: "flaky_pr",
  aliases: ["flaky-pr"],
  async execute(app, session, action, _opts) {
    // Stage config lives on the flow's stage definition, not on session.config.
    // Look it up from the flow definition for the session's current stage.
    // Falls back to session.config so tests / callers that pre-populate the
    // session config still work.
    const flowDef = await app.flows.get(session.flow);
    const stageDef = flowDef?.stages?.find((s: { name: string }) => s.name === session.stage) as
      | { config?: Record<string, unknown> }
      | undefined;
    const cfg = (stageDef?.config ?? (session as any).config ?? {}) as Record<string, unknown>;
    const failTimes: number = typeof cfg.fail_times === "number" ? cfg.fail_times : 0;
    const errorMsg: string = typeof cfg.error === "string" ? cfg.error : "Error";

    // Record this attempt in the durable event log so the count survives
    // Temporal activity retries (each retry creates a fresh closure).
    await app.events.log(session.id, "flaky_pr_attempt", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: { action },
    });

    // Count total attempts for this session (includes the one we just logged).
    const attempts = await app.events.list(session.id, { type: "flaky_pr_attempt" });
    const callCount = attempts.length;

    if (callCount <= failTimes) {
      if (errorMsg === "AuthError") throw authError("flaky-pr: auth failed");
      if (errorMsg === "ValidationError") throw validationError("flaky-pr: validation failed");
      throw new Error(errorMsg);
    }

    await app.events.log(session.id, "action_executed", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: { action, pr_url: "https://example.com/pr/1", calls: callCount },
    });
    return { ok: true, message: `Action '${action}' executed` };
  },
};
