import type { SecureBuffer } from "./memory.js";

/**
 * Result of a successful KEK load.
 *
 * `material` is a SecureBuffer wrapping the 32 raw KEK bytes. Caller MUST
 * call `material.dispose()` during shutdown.
 *
 * `version` is the integer the operator considers "current". For SSM-backed
 * loads this is the SSM parameter Version (so SSM is the source of truth for
 * what `tenant_deks.kek_version` should record when wrapping DEKs).
 *
 * `describe()` returns a redacted identity string for startup logs and audit.
 * MUST NOT include any byte of the key material.
 */
export interface LoadedKek {
  material: SecureBuffer;
  version: number;
  describe(): string;
}

export interface KekBackend {
  /**
   * Load the master KEK. Implementations MUST fail loudly on any error
   * (missing parameter, IAM denied, wrong length, decode failure) by
   * throwing KekLoadError. Implementations MUST NOT log or include any
   * byte of the key material in error messages.
   */
  load(): Promise<LoadedKek>;
  /** Redacted backend identity for startup logs + audit. Never bytes. */
  describe(): string;
}

/**
 * Thrown for any KEK load failure. Message format:
 *   "KEK load failed via <backend>: <reason>"
 * NEVER include key bytes (partial or otherwise) in the message.
 */
export class KekLoadError extends Error {
  constructor(
    backend: string,
    reason: string,
    public readonly cause?: unknown,
  ) {
    super(`KEK load failed via ${backend}: ${reason}`);
    this.name = "KekLoadError";
  }
}
