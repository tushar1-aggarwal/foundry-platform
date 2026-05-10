/**
 * whoami client wrapper tests.
 *
 * Pin the contract: identity-only, swallows errors as anonymous,
 * normalizes shape.
 */
import { describe, it, expect } from "bun:test";
import { whoami } from "../whoami.js";
import { MockTransport } from "../../transport/MockTransport.js";

describe("whoami", () => {
  it("returns the identity object on success", async () => {
    const t = new MockTransport().register("auth/whoami", () => ({
      identity: { userId: "u1", email: "a@p.com", tenantId: "ocl", role: "member" },
    }));
    const id = await whoami(t);
    expect(id).toEqual({ userId: "u1", email: "a@p.com", tenantId: "ocl", role: "member" });
  });

  it("returns null when the server reports anonymous", async () => {
    const t = new MockTransport().register("auth/whoami", () => ({ identity: null }));
    expect(await whoami(t)).toBeNull();
  });

  it("returns null on RPC error (network / 401 / handler not registered)", async () => {
    // No handler -> MockTransport throws "no handler registered". whoami swallows.
    const t = new MockTransport();
    expect(await whoami(t)).toBeNull();
  });

  it("returns null on shape-mismatch (defensive: server upgraded but client old)", async () => {
    const t = new MockTransport().register("auth/whoami", () => ({}));
    expect(await whoami(t)).toBeNull();
  });
});
