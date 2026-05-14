/**
 * SecureBuffer -- 32-byte buffer for key material with zero-on-dispose.
 *
 * Harm reduction, not proof: V8 may copy bytes around the heap and we
 * cannot intercept GC. This implementation (a) refuses to materialize as
 * a string (no V8 string interning), (b) zero-fills the underlying memory
 * on dispose(), and (c) survives the caller mutating their input array.
 * Use it for the master KEK and unwrapped tenant DEKs only.
 */
export class SecureBuffer {
  private readonly _buf: Uint8Array;
  private _disposed = false;

  constructor(input: Uint8Array) {
    if (input.length !== 32) {
      throw new Error(`SecureBuffer requires exactly 32 bytes, got ${input.length}`);
    }
    this._buf = new Uint8Array(32);
    this._buf.set(input);
  }

  get byteLength(): number {
    return 32;
  }

  /** Read-only view of the bytes. Post-dispose, returns zeros. */
  bytes(): Uint8Array {
    return this._buf;
  }

  /** Zero-fill in place. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._buf.fill(0);
    this._disposed = true;
  }
}
