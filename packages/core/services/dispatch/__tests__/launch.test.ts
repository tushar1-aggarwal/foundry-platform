/**
 * Regression test for buildLaunchEnv when user-scope secrets override
 * tenant-scope secrets through HierarchicalSecretResolver.
 *
 * Before the resolver/placement integration fix:
 *   - StageSecretResolver returned `{ DEMO_USER: "user-val" }` correctly.
 *   - But `placeAllSecrets` then iterated the flat tenant list -- which,
 *     when the backend stores path-shaped names (`/ark/<tid>/users/...`),
 *     leaked those names into envVarPlacer.setEnv(). Two consequences:
 *       (a) env var names like "/ark/t/users/u1/DEMO_USER" land on the
 *           launch env -- shell-illegal.
 *       (b) The flat tenant entry for `DEMO_USER` clobbers the resolver's
 *           user-scope value because Object.assign(env, ctx.getEnv())
 *           runs LAST.
 *
 * This test exercises buildLaunchEnv directly against a stub
 * SecretsCapability that mirrors the FileSecretsProvider behaviour --
 * storing path-shaped names in the tenant bucket as setAtPath() does.
 */

import { describe, it, expect } from "bun:test";
import type { SecretsCapability, SecretRef, BlobRef } from "../../../secrets/types.js";
import type { ArkConfig } from "../../../config.js";
import type { Session } from "../../../../types/index.js";
import type { Compute } from "../../../../types/index.js";
import { buildLaunchEnv } from "../launch.js";
import { StageSecretResolver } from "../secrets-resolve.js";
import { parsePath } from "../../../../secrets/resolver/index.js";

interface StoredEntry {
  value: string;
  type: "env-var" | "ssh-private-key" | "kubeconfig" | "generic-blob";
}

/**
 * Stub modelled after FileSecretsProvider: legacy bare names live at
 * `/ark/<tid>/tenant/<name>`; full paths are stored as-is. The `list()`
 * surface returns Object.keys (so path-shaped names leak through there,
 * which is exactly the production-side bug).
 */
function buildSecretsStub(initial: Record<string, Record<string, StoredEntry>>): SecretsCapability {
  const data: Record<string, Record<string, StoredEntry>> = JSON.parse(JSON.stringify(initial));

  const effectiveFullPath = (tid: string, storedName: string): string | null => {
    if (!storedName) return null;
    if (storedName.startsWith("/ark/")) return storedName;
    if (storedName.includes("/")) return null;
    return `/ark/${tid}/tenant/${storedName}`;
  };

  return {
    async list(tenantId: string): Promise<SecretRef[]> {
      const tenant = data[tenantId] ?? {};
      return Object.keys(tenant)
        .sort()
        .map((name) => ({
          tenant_id: tenantId,
          name,
          type: tenant[name].type,
          metadata: {},
          created_at: "",
          updated_at: "",
        }));
    },
    async get() {
      throw new Error("stub: get not used");
    },
    async set() {
      throw new Error("stub: set not used");
    },
    async delete() {
      throw new Error("stub: delete not used");
    },
    async resolveMany(tenantId: string, names: string[]): Promise<Record<string, string>> {
      const tenant = data[tenantId] ?? {};
      const out: Record<string, string> = {};
      for (const n of names) {
        const entry = tenant[n];
        if (entry) out[n] = entry.value;
      }
      return out;
    },
    async listAt(prefix: string): Promise<{ name: string }[]> {
      if (!prefix.startsWith("/ark/")) throw new Error("listAt: prefix must start with /ark/");
      const out: { name: string }[] = [];
      for (const tid of Object.keys(data)) {
        const tenant = data[tid];
        for (const storedName of Object.keys(tenant)) {
          const full = effectiveFullPath(tid, storedName);
          if (full && full.startsWith(prefix)) out.push({ name: full });
        }
      }
      return out;
    },
    async batchGet(paths: string[]): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      for (const p of paths) {
        const parsed = parsePath(p);
        if (!parsed) continue;
        const tenant = data[parsed.tenantId];
        if (!tenant) continue;
        // Try both shapes -- full path key (setAtPath) and bare-name key
        // (legacy `set()`).
        const direct = tenant[p];
        if (direct) {
          out[p] = direct.value;
          continue;
        }
        if (parsed.scope === "tenant") {
          const bare = tenant[parsed.key];
          if (bare) out[p] = bare.value;
        }
      }
      return out;
    },
    async listBlobs() {
      return [];
    },
    async listBlobsDetailed(): Promise<BlobRef[]> {
      return [];
    },
    async getBlob() {
      return null;
    },
    async setBlob() {
      throw new Error("stub: setBlob not used");
    },
    async deleteBlob() {
      throw new Error("stub: deleteBlob not used");
    },
  };
}

const cfg: ArkConfig = { authSection: { defaultTenant: "default" } } as ArkConfig;

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s-test",
    tenant_id: "t",
    user_id: "u1",
    status: "pending",
    compute_name: "stub-compute",
    ...over,
  } as Session;
}

function mkDeps(secretsStub: SecretsCapability): Parameters<typeof buildLaunchEnv>[0] {
  const compute: Compute = {
    name: "stub-compute",
    compute_kind: "local",
    isolation_kind: "direct",
    status: "running",
    config: {},
  } as Compute;
  return {
    computes: {
      get: async (_name: string) => compute,
    } as any,
    runtimes: { get: () => null } as any,
    materializeClaudeAuth: async () => ({ env: {}, credsSecretName: null, credsSecretNamespace: null }) as any,
    getApp: () =>
      ({
        secrets: secretsStub,
        config: cfg,
      }) as any,
    secrets: secretsStub,
    teamChainLoader: async () => [],
  };
}

describe("buildLaunchEnv: hierarchical resolver vs flat placement (regression)", () => {
  it("user-scope override wins and no env-var name is path-shaped", async () => {
    const secrets = buildSecretsStub({
      t: {
        "/ark/t/tenant/DEMO_USER": { value: "tenant-val", type: "env-var" },
        "/ark/t/users/u1/DEMO_USER": { value: "user-val", type: "env-var" },
        "/ark/t/tenant/DEMO_TOKEN": { value: "tt", type: "env-var" },
      },
    });

    const stageSecrets = new StageSecretResolver({
      secrets,
      config: cfg,
      teamChainLoader: async () => [],
    });

    const deps = mkDeps(secrets);
    const result = await buildLaunchEnv(deps, stageSecrets, mkSession(), null, "test-runtime", () => {});

    expect(result.error).toBeUndefined();
    expect(result.env.DEMO_USER).toBe("user-val");
    expect(result.env.DEMO_TOKEN).toBe("tt");
    // No env-var name can be path-shaped -- shells reject names containing "/".
    for (const k of Object.keys(result.env)) {
      expect(k).not.toContain("/");
    }
  });

  it("tenant-level claude auth wins over secret of the same name", async () => {
    const secrets = buildSecretsStub({
      t: {
        "/ark/t/tenant/ANTHROPIC_API_KEY": { value: "from-secret", type: "env-var" },
      },
    });
    const stageSecrets = new StageSecretResolver({
      secrets,
      config: cfg,
      teamChainLoader: async () => [],
    });
    const deps = mkDeps(secrets);
    // Override materializeClaudeAuth to seed ANTHROPIC_API_KEY.
    (deps as any).materializeClaudeAuth = async () => ({
      env: { ANTHROPIC_API_KEY: "from-claude-auth" },
      credsSecretName: null,
      credsSecretNamespace: null,
    });
    const result = await buildLaunchEnv(deps, stageSecrets, mkSession(), null, "test-runtime", () => {});
    expect(result.error).toBeUndefined();
    expect(result.env.ANTHROPIC_API_KEY).toBe("from-claude-auth");
  });
});
