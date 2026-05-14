import { describe, it, expect } from "bun:test";
import { SecureBuffer } from "../memory.js";

describe("SecureBuffer", () => {
  it("wraps exactly 32 bytes", () => {
    const buf = new SecureBuffer(new Uint8Array(32).fill(7));
    expect(buf.byteLength).toBe(32);
    expect(buf.bytes()[0]).toBe(7);
    expect(buf.bytes()[31]).toBe(7);
  });

  it("rejects inputs of the wrong length", () => {
    expect(() => new SecureBuffer(new Uint8Array(16))).toThrow(/32/);
    expect(() => new SecureBuffer(new Uint8Array(33))).toThrow(/32/);
    expect(() => new SecureBuffer(new Uint8Array(0))).toThrow(/32/);
  });

  it("copies input bytes (caller can zero their source without affecting us)", () => {
    const src = new Uint8Array(32).fill(9);
    const buf = new SecureBuffer(src);
    src.fill(0);
    expect(buf.bytes()[0]).toBe(9);
  });

  it("dispose() zero-fills the buffer", () => {
    const buf = new SecureBuffer(new Uint8Array(32).fill(0xff));
    buf.dispose();
    const zero = Buffer.alloc(32);
    expect(Buffer.from(buf.bytes()).equals(zero)).toBe(true);
  });

  it("double-dispose is a no-op", () => {
    const buf = new SecureBuffer(new Uint8Array(32).fill(1));
    buf.dispose();
    expect(() => buf.dispose()).not.toThrow();
  });

  it("bytes() after dispose returns zero-filled view (no throw)", () => {
    const buf = new SecureBuffer(new Uint8Array(32).fill(1));
    buf.dispose();
    expect(buf.bytes().every((b) => b === 0)).toBe(true);
  });
});
