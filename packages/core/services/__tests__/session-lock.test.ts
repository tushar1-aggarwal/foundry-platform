/**
 * Guard for the per-session serialization invariant.
 *
 * Same sessionId: critical sections run strictly FIFO, never interleaved
 * (this is what stops the report-driven advance racing an in-flight
 * dispatch -- the root cause behind the reverted async big-bang).
 * Different sessionIds: run concurrently. A rejecting section must not
 * poison the chain for the next waiter.
 */

import { describe, it, expect } from "bun:test";
import { withSessionLock } from "../session-lock.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withSessionLock", () => {
  it("serializes overlapping sections for the same session (no interleave)", async () => {
    const events: string[] = [];
    const a = withSessionLock("s-1", async () => {
      events.push("A:start");
      await tick(30);
      events.push("A:end");
    });
    // Submitted while A is still running -- must wait, not interleave.
    const b = withSessionLock("s-1", async () => {
      events.push("B:start");
      await tick(1);
      events.push("B:end");
    });
    await Promise.all([a, b]);
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  it("runs different sessions concurrently", async () => {
    const order: string[] = [];
    const slow = withSessionLock("s-A", async () => {
      await tick(40);
      order.push("A");
    });
    const fast = withSessionLock("s-B", async () => {
      await tick(5);
      order.push("B");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["B", "A"]); // B not blocked by A's lock
  });

  it("a rejecting section does not poison the chain", async () => {
    await expect(
      withSessionLock("s-2", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const v = await withSessionLock("s-2", async () => 42);
    expect(v).toBe(42);
  });

  it("returns the section's resolved value", async () => {
    expect(await withSessionLock("s-3", async () => "ok")).toBe("ok");
  });
});
