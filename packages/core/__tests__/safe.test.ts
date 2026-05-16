/**
 * Tests for safe.ts -- async error suppression utility.
 *
 * Every case binds the return value to a proof that `fn` was actually
 * invoked. Without that binding the tests pass vacuously: an
 * implementation that ignored `fn` entirely and returned a constant
 * would satisfy a return-value-only assertion.
 */

import { describe, it, expect, mock } from "bun:test";
import { safeAsync } from "../safe.js";

describe("safeAsync", () => {
  it("invokes fn exactly once", async () => {
    let callCount = 0;
    await safeAsync("test", async () => {
      callCount++;
    });
    expect(callCount).toBe(1);
  });

  it("returns true and invokes fn when fn resolves", async () => {
    // The conjunction matters: returning true alone could be satisfied by
    // an impl that skipped fn; running fn alone says nothing about the
    // result contract. Both must hold to prove the success path.
    let ran = false;
    const result = await safeAsync("test", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(result).toBe(true);
  });

  it("returns false and invokes fn when fn rejects with an Error", async () => {
    let ran = false;
    const result = await safeAsync("test", async () => {
      ran = true;
      throw new Error("boom");
    });
    expect(ran).toBe(true);
    expect(result).toBe(false);
  });

  it("returns false when fn throws a non-Error", async () => {
    let ran = false;
    const result = await safeAsync("test", async () => {
      ran = true;
      throw "string error";
    });
    expect(ran).toBe(true);
    expect(result).toBe(false);
  });

  it("does not rethrow when fn rejects", async () => {
    // Asserting fn ran alongside no-rethrow rules out the vacuous case
    // where fn was never called (and so trivially "didn't throw").
    let ran = false;
    let rethrew = false;
    try {
      await safeAsync("test", async () => {
        ran = true;
        throw new Error("should be caught");
      });
    } catch {
      rethrew = true;
    }
    expect(ran).toBe(true);
    expect(rethrew).toBe(false);
  });

  it("logs via logError, not console.error", async () => {
    const origConsoleError = console.error;
    const consoleMock = mock(() => {});
    console.error = consoleMock;
    try {
      const result = await safeAsync("test", async () => {
        throw new Error("should use logError");
      });
      // Bind to result so the error path is proven to have executed.
      expect(result).toBe(false);
      expect(consoleMock).not.toHaveBeenCalled();
    } finally {
      console.error = origConsoleError;
    }
  });
});
