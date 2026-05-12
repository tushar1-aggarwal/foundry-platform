import { ApplicationFailure } from "@temporalio/activity";

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorError";
  }
}

export class ValidationError extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "ValidationError");
  }
}
export class SessionNotFound extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "SessionNotFound");
  }
}
export class StageNotReady extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "StageNotReady");
  }
}
export class TenantQuotaError extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "TenantQuotaError");
  }
}
export class ComputeNotFoundError extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "ComputeNotFoundError");
  }
}
export class DispatchValidationError extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "DispatchValidationError");
  }
}
export class AuthError extends OrchestratorError {
  toFailure() {
    return ApplicationFailure.nonRetryable(this.message, "AuthError");
  }
}

export class TransientOrchestratorError extends OrchestratorError {}

// Factory functions producing non-retryable ApplicationFailure instances.
const tag =
  (type: string) =>
  (msg: string): ApplicationFailure =>
    ApplicationFailure.nonRetryable(msg, type);

export const validationError = tag("ValidationError");
export const authError = tag("AuthError");
export const sessionNotFound = tag("SessionNotFound");
export const stageNotReady = tag("StageNotReady");
export const dispatchValidationError = tag("DispatchValidationError");
export const computeNotFound = tag("ComputeNotFoundError");
export const tenantQuota = tag("TenantQuotaError");
