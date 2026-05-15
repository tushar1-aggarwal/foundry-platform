/**
 * Unit tests for StageSecretResolver. We inject a tiny in-memory
 * SecretsCapability stub that supports just listAt + batchGet (the
 * surface the hierarchical resolver consumes) and a fake teamChainLoader.
 *
 * Regression guard: the resolver no longer consults the runtime YAML
 * allowlist. We don't pass a `runtimes` store at all in these tests and
 * the resolver must still produce env -- proving the Phase 1 wiring is
 * gone.
 */

import { describe, it, expect } from "bun:test";
import type { SecretsCapability } from "../../../secrets/types.js";
import type { ArkConfig } from "../../../config.js";
import type { Session } from "../../../../types/index.js";
import type { StageDefinition } from "../../flow.js";
import { StageSecretResolver } from "../secrets-resolve.js";

function buildSecrets(values: Record<string, string>): SecretsCapability {
  return {
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
    // The remaining capability methods are intentionally unused by the
    // resolver. Stub them as throwers so any future regression that
    // calls back into them lights up in this test.
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
  } as unknown as SecretsCapability;
}

function notUsed(): never {
  throw new Error("stub: method not exercised by StageSecretResolver");
}

const cfg: ArkConfig = { authSection: { defaultTenant: "default" } } as ArkConfig;

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    tenant_id: "t1",
    user_id: "u1",
    status: "pending",
    ...over,
  } as Session;
}

const log = () => {};

describe("StageSecretResolver (hierarchical)", () => {
  it("returns the resolver's env even when stage YAML secrets: is empty", async () => {
    const r = new StageSecretResolver({
      secrets: buildSecrets({
        "/ark/t1/tenant/ANTHROPIC_API_KEY": "sk-tenant",
        "/ark/t1/users/u1/PERSONAL_TOKEN": "sk-user",
      }),
      config: cfg,
      teamChainLoader: async () => [],
    });
    const out = await r.resolve(mkSession(), null, "claude-code", log);
    expect(out.error).toBeUndefined();
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "sk-tenant", PERSONAL_TOKEN: "sk-user" });
  });

  it("returns env when stage's required secrets: all resolved", async () => {
    const r = new StageSecretResolver({
      secrets: buildSecrets({
        "/ark/t1/tenant/ANTHROPIC_API_KEY": "sk-tenant",
      }),
      config: cfg,
      teamChainLoader: async () => [],
    });
    const stage: StageDefinition = { secrets: ["ANTHROPIC_API_KEY"] } as StageDefinition;
    const out = await r.resolve(mkSession(), stage, "claude-code", log);
    expect(out.error).toBeUndefined();
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "sk-tenant" });
  });

  it("populates error and empties env when a required stage secret is missing", async () => {
    const r = new StageSecretResolver({
      secrets: buildSecrets({
        "/ark/t1/tenant/HAVE": "yes",
      }),
      config: cfg,
      teamChainLoader: async () => [],
    });
    const stage: StageDefinition = { secrets: ["HAVE", "MISSING"] } as StageDefinition;
    const out = await r.resolve(mkSession(), stage, "claude-code", log);
    expect(out.error).toBeDefined();
    expect(out.error).toContain("MISSING");
    expect(out.env).toEqual({});
  });

  it("uses team chain + user override per resolver precedence", async () => {
    const r = new StageSecretResolver({
      secrets: buildSecrets({
        "/ark/t1/tenant/SHARED": "tenant-v",
        "/ark/t1/teams/eng/SHARED": "team-v",
        "/ark/t1/users/u1/SHARED": "user-v",
      }),
      config: cfg,
      teamChainLoader: async () => ["eng"],
    });
    const out = await r.resolve(mkSession(), null, "claude-code", log);
    expect(out.env).toEqual({ SHARED: "user-v" });
  });

  it("regression: runtime YAML allowlist is NOT consulted -- no `runtimes` dep in scope, env still produced", async () => {
    // Construct deps WITHOUT a `runtimes` store; the old code would have
    // tried to dereference it. The hierarchical resolver must not.
    const r = new StageSecretResolver({
      secrets: buildSecrets({
        "/ark/t1/tenant/ANTHROPIC_API_KEY": "sk-tenant",
      }),
      config: cfg,
      teamChainLoader: async () => [],
    });
    const out = await r.resolve(mkSession(), null, "any-runtime-kind", log);
    expect(out.error).toBeUndefined();
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "sk-tenant" });
  });

  it("falls back to tenant-only when teamChainLoader throws", async () => {
    const r = new StageSecretResolver({
      secrets: buildSecrets({
        "/ark/t1/tenant/ONLY": "tenant-v",
      }),
      config: cfg,
      teamChainLoader: async () => {
        throw new Error("auth-store unavailable");
      },
    });
    const out = await r.resolve(mkSession({ user_id: null }), null, "claude-code", log);
    expect(out.error).toBeUndefined();
    expect(out.env).toEqual({ ONLY: "tenant-v" });
  });

  it("single-tenant CLI path: null user_id + no teamChainLoader -> tenant env", async () => {
    const r = new StageSecretResolver({
      secrets: buildSecrets({
        "/ark/default/tenant/ANTHROPIC_API_KEY": "sk-default",
      }),
      config: cfg,
    });
    const out = await r.resolve(
      mkSession({ tenant_id: null as unknown as string, user_id: null }),
      null,
      "claude-code",
      log,
    );
    expect(out.error).toBeUndefined();
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: "sk-default" });
  });
});
