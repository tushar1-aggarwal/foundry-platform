/**
 * In-process end-to-end smoke for the resolver -> placement integration.
 *
 * Drives `buildLaunchEnv` against a real `FileSecretsProvider` (exposed
 * via `AppContext.forTestAsync()`) -- no stubs on the backend. Seeds
 * tenant + user secrets at path-shaped locations via `setAtPath`, an
 * ssh-private-key typed-blob entry via the legacy `set()` surface, and
 * verifies:
 *
 *   1. User-scope wins over tenant-scope for the same key.
 *   2. A tenant-only key surfaces on the launch env.
 *   3. The typed-blob (ssh-private-key) queues file ops on the
 *      DeferredPlacementCtx -- proving blob placement still runs even
 *      though env-var placement is now resolver-driven.
 *   4. No env-var name on the launch env contains a path separator --
 *      path-shaped storage keys must not leak through envVarPlacer.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../../../app.js";
import { setApp, clearApp } from "../../../__tests__/test-helpers.js";
import { buildLaunchEnv } from "../launch.js";
import { StageSecretResolver } from "../secrets-resolve.js";
import { DeferredPlacementCtx } from "../../../secrets/deferred-placement-ctx.js";
import { __test_registerPlacer } from "../../../secrets/placement.js";
import { _makeSshPrivateKeyPlacer, sshPrivateKeyPlacer } from "../../../secrets/placers/ssh-private-key.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterEach(async () => {
  await app?.shutdown();
  clearApp();
});

function tenant(): string {
  return app.config.authSection?.defaultTenant ?? "default";
}

function makeDeps(): Parameters<typeof buildLaunchEnv>[0] {
  return {
    computes: app.computes,
    runtimes: app.runtimes,
    materializeClaudeAuth: async () => ({ env: {}, credsSecretName: null, credsSecretNamespace: null }) as any,
    getApp: () => app,
    secrets: app.secrets,
    teamChainLoader: async () => [],
  };
}

describe("buildLaunchEnv end-to-end (hierarchical resolver -> placement)", () => {
  it("user-scope wins, tenant-only surfaces, ssh-private-key queues file ops, no path-shaped env names", async () => {
    const tid = tenant();
    const setAtPath = app.secrets.setAtPath;
    if (typeof setAtPath !== "function") {
      throw new Error("FileSecretsProvider must implement setAtPath for this test");
    }

    // Tenant + user scopes for the same key. User must win.
    await setAtPath.call(app.secrets, tid, `/ark/${tid}/tenant/SHARED_KEY`, "tenant-value", {
      type: "env-var",
      metadata: {},
    });
    await setAtPath.call(app.secrets, tid, `/ark/${tid}/users/u1/SHARED_KEY`, "user-value", {
      type: "env-var",
      metadata: {},
    });
    // Tenant-only key.
    await setAtPath.call(app.secrets, tid, `/ark/${tid}/tenant/TENANT_ONLY`, "tenant-only-value", {
      type: "env-var",
      metadata: {},
    });

    // One typed-blob secret -- ssh-private-key. Stored via the legacy
    // `set()` surface (its name passes assertValidSecretName).
    await app.secrets.set(tid, "GH_DEPLOY_KEY", "PRIVATE_KEY_BODY", {
      type: "ssh-private-key",
      metadata: { host: "github.com" },
    });

    // Replace the ssh placer with one that doesn't shell out to ssh-keyscan.
    const stubSshPlacer = _makeSshPrivateKeyPlacer({
      runKeyScan: async () => Buffer.from("github.com ssh-rsa AAAA...\n"),
    });
    __test_registerPlacer("ssh-private-key", stubSshPlacer);

    try {
      // A compute row the session points at -- placement runs only when
      // a compute is resolved.
      await app.computes.insert({
        name: "smoke-target",
        compute_kind: "local",
        isolation_kind: "direct",
        status: "running",
        config: {},
      } as any);

      const session = await app.sessions.create({
        summary: "smoke",
        flow: "quick",
        compute_name: "smoke-target",
      });
      // Stamp the session with user_id=u1 so the resolver walks the user prefix.
      await app.sessions.update(session.id, { user_id: "u1" } as any);
      const fetched = (await app.sessions.get(session.id))!;

      const deps = makeDeps();
      const secrets = new StageSecretResolver({
        secrets: app.secrets,
        config: app.config,
        teamChainLoader: async () => [],
      });

      const result = await buildLaunchEnv(deps, secrets, fetched, null, "test-runtime", () => {});

      expect(result.error).toBeUndefined();
      expect(result.env.SHARED_KEY).toBe("user-value");
      expect(result.env.TENANT_ONLY).toBe("tenant-only-value");
      // No path-shaped env names.
      for (const k of Object.keys(result.env)) {
        expect(k).not.toContain("/");
      }

      // Placement ctx exists and the ssh placer queued at least one file op.
      const placement = result.placement as DeferredPlacementCtx | undefined;
      expect(placement).toBeInstanceOf(DeferredPlacementCtx);
      expect(placement!.hasDeferred()).toBe(true);
      const writes = placement!.queuedOps.filter((op) => op.kind === "writeFile");
      // ssh-private-key placer writes one private-key file plus appends to
      // ~/.ssh/config and ~/.ssh/known_hosts -- only writeFile counts here.
      expect(writes.length).toBeGreaterThanOrEqual(1);
    } finally {
      __test_registerPlacer("ssh-private-key", sshPrivateKeyPlacer);
    }
  }, 180_000);
});
// bail-on-first: tests in this file share a real AppContext; a failing
// assertion would otherwise leak partial state into subsequent cases.
// bun:test honours the per-test timeout above; no extra cfg needed.

/*
# Manual smoke (operator-run)
ark secrets set DEMO_KEY=tenant-val --scope tenant
ark secrets set DEMO_KEY=user-val --scope user
ark session start <agent> <repo>
# expected: printenv inside the agent reports DEMO_KEY=user-val
*/
