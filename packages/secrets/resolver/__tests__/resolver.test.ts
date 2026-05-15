import { describe, test, expect } from "bun:test";
import type { SecretsCapability } from "../../../core/secrets/types.js";
import { HierarchicalSecretResolver } from "../resolver.js";

/**
 * Minimal in-memory SecretsCapability stand-in. Only the four methods the
 * resolver actually touches need to behave -- `listAt` and `batchGet` --
 * but TypeScript wants the full interface so we throw on the rest.
 */
function mockCapability(values: Record<string, string>): SecretsCapability {
  const cap = {
    list: notUsed,
    get: notUsed,
    set: notUsed,
    delete: notUsed,
    resolveMany: notUsed,
    listBlobs: notUsed,
    listBlobsDetailed: notUsed,
    getBlob: notUsed,
    setBlob: notUsed,
    deleteBlob: notUsed,
    async listAt(prefix: string) {
      const out: { name: string }[] = [];
      for (const k of Object.keys(values)) {
        if (k.startsWith(prefix)) out.push({ name: k });
      }
      return out;
    },
    async batchGet(paths: string[]) {
      const out: Record<string, string> = {};
      for (const p of paths) {
        if (p in values) out[p] = values[p];
      }
      return out;
    },
  } as unknown as SecretsCapability;
  return cap;
}

function notUsed(): never {
  throw new Error("mock: method not used by resolver");
}

describe("HierarchicalSecretResolver", () => {
  test("user-scoped overrides team-scoped overrides tenant-scoped (precedence)", async () => {
    const r = new HierarchicalSecretResolver(
      mockCapability({
        "/ark/t1/tenant/SHARED": "tenant-v",
        "/ark/t1/teams/eng/SHARED": "team-v",
        "/ark/t1/users/u1/SHARED": "user-v",
      }),
    );
    const env = await r.resolveAll({ tenant_id: "t1", user_id: "u1" }, ["eng"]);
    expect(env).toEqual({ SHARED: "user-v" });
  });

  test("disjoint keys across scopes are all merged", async () => {
    const r = new HierarchicalSecretResolver(
      mockCapability({
        "/ark/t1/tenant/T_KEY": "t-v",
        "/ark/t1/teams/eng/TEAM_KEY": "team-v",
        "/ark/t1/users/u1/USER_KEY": "user-v",
      }),
    );
    const env = await r.resolveAll({ tenant_id: "t1", user_id: "u1" }, ["eng"]);
    expect(env).toEqual({ T_KEY: "t-v", TEAM_KEY: "team-v", USER_KEY: "user-v" });
  });

  test("empty scopes yield empty map", async () => {
    const r = new HierarchicalSecretResolver(mockCapability({}));
    const env = await r.resolveAll({ tenant_id: "t1", user_id: null }, []);
    expect(env).toEqual({});
  });

  test("same key in two team levels -- most-specific team wins", async () => {
    const r = new HierarchicalSecretResolver(
      mockCapability({
        "/ark/t1/teams/eng/SHARED": "eng-v",
        "/ark/t1/teams/platform/SHARED": "platform-v",
        "/ark/t1/tenant/SHARED": "tenant-v",
      }),
    );
    // teamChain[0] is most specific; user_id=null so no user-scope win.
    const env = await r.resolveAll({ tenant_id: "t1" }, ["platform", "eng"]);
    expect(env).toEqual({ SHARED: "platform-v" });
  });

  test("assertPresent throws on missing key with the missing list in the message", () => {
    const r = new HierarchicalSecretResolver(mockCapability({}));
    expect(() => r.assertPresent(["FOO", "BAR"], { FOO: "v" })).toThrow(/BAR/);
    // No throw when everything is present.
    r.assertPresent(["FOO"], { FOO: "v" });
    // No throw when nothing required.
    r.assertPresent([], { ANY: "v" });
  });

  test("null user + empty teamChain -> tenant-only env (single-tenant CLI path)", async () => {
    const r = new HierarchicalSecretResolver(
      mockCapability({
        "/ark/default/tenant/ANTHROPIC_API_KEY": "sk-tenant",
        "/ark/default/users/somebody/ANTHROPIC_API_KEY": "sk-user", // ignored: user_id is null
      }),
    );
    const env = await r.resolveAll({ tenant_id: "default", user_id: null }, []);
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-tenant" });
  });
});
