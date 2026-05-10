/**
 * api-key-rpc.ts client wrapper tests.
 *
 * Pin the RPC payload shape and the response normalization so the
 * dialog UI can rely on the wrapper without inline `transport.rpc`
 * fan-out. We intentionally don't render React here -- the wire shape
 * is what's load-bearing, and the UI tests would need testing-library
 * which the codebase doesn't use.
 */
import { describe, it, expect } from "bun:test";
import { listApiKeys, createApiKey, revokeApiKey } from "../api-key-rpc.js";
import { MockTransport } from "../../../transport/MockTransport.js";

describe("listApiKeys", () => {
  it("returns the keys array from the response", async () => {
    const t = new MockTransport().register("apikey/list", () => ({
      keys: [
        {
          id: "ak-aaa",
          tenantId: "default",
          name: "k1",
          role: "member",
          createdAt: "2026-05-07T00:00:00Z",
          lastUsedAt: null,
          expiresAt: null,
        },
      ],
    }));
    const keys = await listApiKeys(t);
    expect(keys).toHaveLength(1);
    expect(keys[0].id).toBe("ak-aaa");
    expect(t.calls[0]).toEqual({ method: "apikey/list", params: {} });
  });

  it("returns [] when the server returns no keys field (defensive)", async () => {
    const t = new MockTransport().register("apikey/list", () => ({}));
    expect(await listApiKeys(t)).toEqual([]);
  });
});

describe("createApiKey", () => {
  it("forwards name, role, and expires to the RPC payload", async () => {
    const t = new MockTransport().register("apikey/create", () => ({ id: "ak-x", key: "ark_default_xxx" }));
    const result = await createApiKey(t, { name: "ci", role: "member", expires: "2027-01-01" });
    expect(result).toEqual({ id: "ak-x", key: "ark_default_xxx" });
    expect(t.calls[0].method).toBe("apikey/create");
    expect(t.calls[0].params).toEqual({ name: "ci", role: "member", expires: "2027-01-01" });
  });

  it("propagates RPC errors so the dialog can render them as form errors", async () => {
    const t = new MockTransport().register("apikey/create", () => {
      throw new Error("maximum of 10 live API keys per user reached");
    });
    await expect(createApiKey(t, { name: "x" })).rejects.toThrow(/maximum of 10/);
  });
});

describe("revokeApiKey", () => {
  it("sends the id and ignores the response", async () => {
    const t = new MockTransport().register("apikey/revoke", () => ({ ok: true }));
    await revokeApiKey(t, "ak-target");
    expect(t.calls[0]).toEqual({ method: "apikey/revoke", params: { id: "ak-target" } });
  });

  it("propagates RPC errors so the section can render them", async () => {
    const t = new MockTransport().register("apikey/revoke", () => {
      throw new Error("API key not found or not owned by caller");
    });
    await expect(revokeApiKey(t, "ak-other")).rejects.toThrow(/not found or not owned/);
  });
});
