/**
 * Tests for the placeAllSecrets wiring inside buildLaunchEnv.
 *
 * Post Task 5 of the compute cleanup, placement always runs against a
 * fresh `DeferredPlacementCtx`. Env-typed secrets land synchronously on
 * the launch env (via `ctx.getEnv()`); file-typed secrets queue ops on
 * the deferred ctx that `target.compute.flushPlacement` replays
 * post-provision. There is no longer a `provider.buildPlacementCtx` opt-in.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";
import { buildLaunchEnv } from "../dispatch/launch.js";
import { StageSecretResolver } from "../dispatch/secrets-resolve.js";
import { DeferredPlacementCtx } from "../../secrets/deferred-placement-ctx.js";
import { __test_registerPlacer } from "../../secrets/placement.js";
import { envVarPlacer } from "../../secrets/placers/env-var.js";
import type { TypedSecretPlacer } from "../../secrets/placement-types.js";

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

/** Tenant id the dispatch path uses for sessions with a null tenant_id. */
function tenant(): string {
  return app.config.authSection?.defaultTenant ?? "default";
}

/**
 * Build the `Pick<DispatchDeps, ...>` shape buildLaunchEnv expects, with a
 * no-op materializeClaudeAuth (so the test isolates the placement branch).
 */
function makeDeps(): Parameters<typeof buildLaunchEnv>[0] {
  return {
    computes: app.computes,
    runtimes: app.runtimes,
    materializeClaudeAuth: async () => ({ env: {}, credsSecretName: null, credsSecretNamespace: null }),
    getApp: () => app,
    secrets: app.secrets,
    teamChainLoader: async () => [],
  };
}

describe("buildLaunchEnv with placeAllSecrets wiring", () => {
  it("merges env-var placer output into the launch env", async () => {
    await app.computes.insert({
      name: "stub-target",
      compute_kind: "local",
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as any);

    // Tenant has one env-var secret. Placement should run env-var placer
    // against the deferred ctx and we should see it land on the launch env.
    await app.secrets.set(tenant(), "STUB_TOKEN", "stub-value", { type: "env-var", metadata: {} });

    const session = await app.sessions.create({
      summary: "test session",
      flow: "quick",
      compute_name: "stub-target",
    });
    const fetched = (await app.sessions.get(session.id))!;

    const deps = makeDeps();
    const secrets = new StageSecretResolver({
      runtimes: app.runtimes,
      secrets: app.secrets,
      config: app.config,
    });
    const result = await buildLaunchEnv(deps, secrets, fetched, null, "test-only-runtime", () => {});

    expect(result.error).toBeUndefined();
    expect(result.env.STUB_TOKEN).toBe("stub-value");
    expect(result.placement).toBeDefined();
  });

  it("hierarchical resolver surfaces every tenant secret when no stage narrow is set", async () => {
    // With placement as the env-var authority, the narrow filter (union
    // of stageDef.secrets + runtime.secrets) restricts which env vars
    // land on the launch env. When neither stage nor runtime declares
    // anything, narrow is undefined and every tenant secret flows through.
    await app.secrets.set(tenant(), "WANTED", "yes", { type: "env-var", metadata: {} });
    await app.secrets.set(tenant(), "EXTRA", "no", { type: "env-var", metadata: {} });

    await app.computes.insert({
      name: "narrow-target",
      compute_kind: "local",
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as any);

    const session = await app.sessions.create({
      summary: "test session",
      flow: "quick",
      compute_name: "narrow-target",
    });
    const fetched = (await app.sessions.get(session.id))!;

    // stageDef has no `secrets:` list, so narrow stays undefined.
    const stageDef = { name: "stage-x" } as any;
    const deps = makeDeps();
    const secrets = new StageSecretResolver({
      secrets: app.secrets,
      config: app.config,
    });
    const result = await buildLaunchEnv(deps, secrets, fetched, stageDef, "test-only-runtime", () => {});

    expect(result.error).toBeUndefined();
    expect(result.env.WANTED).toBe("yes");
    expect(result.env.EXTRA).toBe("no");
  });

  it("stage `secrets:` narrow filter restricts resolver-sourced env vars", async () => {
    // Post resolver/placement integration, the union of stage + runtime
    // secret names continues to apply on top of the resolver output:
    // when stage declares `secrets: ["WANTED"]`, EXTRA is dropped even
    // though it lives at tenant scope. (Stage YAML stays assert-only for
    // the purposes of failing dispatch on missing keys; the narrow filter
    // applies post-resolve.)
    await app.secrets.set(tenant(), "WANTED", "yes", { type: "env-var", metadata: {} });
    await app.secrets.set(tenant(), "EXTRA", "no", { type: "env-var", metadata: {} });

    await app.computes.insert({
      name: "narrow-target-2",
      compute_kind: "local",
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as any);

    const session = await app.sessions.create({
      summary: "test session",
      flow: "quick",
      compute_name: "narrow-target-2",
    });
    const fetched = (await app.sessions.get(session.id))!;

    const stageDef = { name: "stage-x", secrets: ["WANTED"] } as any;
    const deps = makeDeps();
    const secrets = new StageSecretResolver({
      secrets: app.secrets,
      config: app.config,
    });
    const result = await buildLaunchEnv(deps, secrets, fetched, stageDef, "test-only-runtime", () => {});

    expect(result.error).toBeUndefined();
    expect(result.env.WANTED).toBe("yes");
    expect(result.env.EXTRA).toBeUndefined();
  });

  it("returns the placement ctx so dispatch can forward it through to flushPlacement", async () => {
    await app.computes.insert({
      name: "echo-target",
      compute_kind: "local",
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as any);

    const session = await app.sessions.create({
      summary: "s",
      flow: "quick",
      compute_name: "echo-target",
    });
    const fetched = (await app.sessions.get(session.id))!;

    const deps = makeDeps();
    const secrets = new StageSecretResolver({
      runtimes: app.runtimes,
      secrets: app.secrets,
      config: app.config,
    });
    const result = await buildLaunchEnv(deps, secrets, fetched, null, "test-only-runtime", () => {});
    expect(result.placement).toBeInstanceOf(DeferredPlacementCtx);
  });

  it("file-typed secret writes are deferred (queued, not executed)", async () => {
    // Register a stub placer that both writes a file AND sets an env var;
    // assert the env lands on the launch env synchronously while the file op
    // is queued for post-flush.
    const stubPlacer: TypedSecretPlacer = {
      type: "env-var",
      async place(secret, place) {
        place.setEnv(secret.name, secret.value!);
        await place.writeFile(`/home/ubuntu/.${secret.name}.token`, 0o600, new TextEncoder().encode(secret.value!));
      },
    };
    __test_registerPlacer("env-var", stubPlacer);
    try {
      await app.computes.insert({
        name: "deferred-target",
        compute_kind: "local",
        isolation_kind: "direct",
        status: "running",
        config: {},
      } as any);

      await app.secrets.set(tenant(), "DEFER_TOKEN", "secret-val", { type: "env-var", metadata: {} });

      const session = await app.sessions.create({
        summary: "s",
        flow: "quick",
        compute_name: "deferred-target",
      });
      const fetched = (await app.sessions.get(session.id))!;

      const deps = makeDeps();
      const secrets = new StageSecretResolver({
        runtimes: app.runtimes,
        secrets: app.secrets,
        config: app.config,
      });
      const result = await buildLaunchEnv(deps, secrets, fetched, null, "test-only-runtime", () => {});

      expect(result.error).toBeUndefined();
      // Env was captured synchronously and merged into the launch env.
      expect(result.env.DEFER_TOKEN).toBe("secret-val");
      // The file write for DEFER_TOKEN was DEFERRED, not executed.
      const placement = result.placement as DeferredPlacementCtx | undefined;
      expect(placement).toBeInstanceOf(DeferredPlacementCtx);
      expect(placement!.hasDeferred()).toBe(true);
    } finally {
      __test_registerPlacer("env-var", envVarPlacer);
    }
  });

  it("returns an error and does not launch when a fail-fast placer throws", async () => {
    const explodingPlacer: TypedSecretPlacer = {
      type: "env-var",
      async place() {
        throw new Error("simulated placement failure");
      },
    };
    __test_registerPlacer("env-var", explodingPlacer);
    try {
      await app.computes.insert({
        name: "fail-target",
        compute_kind: "local",
        isolation_kind: "direct",
        status: "running",
        config: {},
      } as any);
      await app.secrets.set(tenant(), "BOOM", "x", { type: "env-var", metadata: {} });

      const session = await app.sessions.create({
        summary: "test session",
        flow: "quick",
        compute_name: "fail-target",
      });
      const fetched = (await app.sessions.get(session.id))!;

      const deps = makeDeps();
      const secrets = new StageSecretResolver({
        runtimes: app.runtimes,
        secrets: app.secrets,
        config: app.config,
      });
      const result = await buildLaunchEnv(deps, secrets, fetched, null, "test-only-runtime", () => {});

      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/placement/i);
    } finally {
      __test_registerPlacer("env-var", envVarPlacer);
    }
  });
});
