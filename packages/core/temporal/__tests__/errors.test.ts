import { test, expect } from "bun:test";
import { ApplicationFailure } from "@temporalio/common";
import {
  validationError,
  authError,
  sessionNotFound,
  stageNotReady,
  dispatchValidationError,
  computeNotFound,
  tenantQuota,
} from "../errors.js";

test("validationError produces a non-retryable ApplicationFailure", () => {
  const err = validationError("bad input");
  expect(err).toBeInstanceOf(ApplicationFailure);
  expect((err as ApplicationFailure).nonRetryable).toBe(true);
  expect((err as ApplicationFailure).type).toBe("ValidationError");
  expect((err as ApplicationFailure).message).toContain("bad input");
});

test.each([
  ["authError", authError, "AuthError"],
  ["sessionNotFound", sessionNotFound, "SessionNotFound"],
  ["stageNotReady", stageNotReady, "StageNotReady"],
  ["dispatchValidationError", dispatchValidationError, "DispatchValidationError"],
  ["computeNotFound", computeNotFound, "ComputeNotFoundError"],
  ["tenantQuota", tenantQuota, "TenantQuotaError"],
] as const)("%s tags non-retryable with type %s", (_name, fn, type) => {
  const err = fn("x");
  expect((err as ApplicationFailure).type).toBe(type);
  expect((err as ApplicationFailure).nonRetryable).toBe(true);
});
