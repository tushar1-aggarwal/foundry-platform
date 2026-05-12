import { test, expect } from "bun:test";
import { runFlakyPr } from "./flaky-pr-fixture.js";

test("flaky-pr fails N times then succeeds", async () => {
  const handle = runFlakyPr({ failTimes: 3, error: "503 service unavailable" });
  await expect(handle.invoke()).rejects.toThrow(/503/);
  await expect(handle.invoke()).rejects.toThrow(/503/);
  await expect(handle.invoke()).rejects.toThrow(/503/);
  const ok = await handle.invoke();
  expect(ok.ok).toBe(true);
  expect(ok.pr_url).toBeTruthy();
});

test("flaky-pr with AuthError throws non-retryable tagged failure", async () => {
  const handle = runFlakyPr({ failTimes: Infinity, error: "AuthError" });
  await expect(handle.invoke()).rejects.toThrow(/AuthError/);
});

test("flaky-pr with ValidationError throws non-retryable tagged failure", async () => {
  const handle = runFlakyPr({ failTimes: Infinity, error: "ValidationError" });
  await expect(handle.invoke()).rejects.toThrow(/validation/i);
});
