// Unit tests for destroyComputeActivity.
//
// The activity is the "finally" hook the workflow calls on every terminal
// path (success, stage-failure return, thrown error, cancellation) to ensure
// a session's provisioned compute (K8s pod, EC2 instance, etc.) gets reaped.
//
// Spec under test:
//   (A) session not found       -> no-op, no throw
//   (B) session has no handle   -> no-op
//   (C) session has handle      -> rehydrateHandle + compute.destroy(handle)
//   (D) compute.destroy throws  -> swallow + log warn (best-effort cleanup)
//   (E) compute target null     -> no-op
import { describe, it, expect } from "bun:test";
import { destroyComputeActivity, injectDeps } from "../destroy-compute.js";
import type { OrchestrationDeps } from "../../../services/deps.js";

type DestroySpy = {
  destroyCalls: Array<{ kind: string; name: string; meta: unknown }>;
  rehydrateCalls: Array<{ kind: string; name: string; meta: unknown }>;
};

function makeStubDeps(opts: {
  session?: { id: string; config?: Record<string, unknown> | null; tenant_id?: string } | null;
  target?: "k8s" | null | "throw-on-destroy";
  /** When true, app.resolveComputeTarget returns null target (E). */
  unresolved?: boolean;
  /** When true, no AppContext (early no-op return). */
  noApp?: boolean;
}): { deps: OrchestrationDeps; spy: DestroySpy } {
  const spy: DestroySpy = { destroyCalls: [], rehydrateCalls: [] };

  const fakeCompute = {
    destroy: async (h: { kind: string; name: string; meta: unknown }) => {
      spy.destroyCalls.push({ kind: h.kind, name: h.name, meta: h.meta });
      if (opts.target === "throw-on-destroy") {
        throw new Error("synthetic destroy failure");
      }
    },
    rehydrateHandle: (h: { kind: string; name: string; meta: unknown }) => {
      spy.rehydrateCalls.push({ kind: h.kind, name: h.name, meta: h.meta });
      // Production rehydrate returns void; closures are re-attached on the
      // shared in-memory compute. We model it the same way.
    },
  };

  const sessionsApi = {
    get: async (id: string) => (opts.session && opts.session.id === id ? opts.session : null),
  };

  const app = opts.noApp
    ? undefined
    : ({
        tenantId: "default",
        forTenant: function () {
          return this;
        },
        sessions: sessionsApi,
        resolveComputeTarget: async () => {
          if (opts.unresolved) return { target: null, compute: null };
          return { target: { compute: fakeCompute }, compute: { name: "k8s-default" } };
        },
      } as any);

  const deps: OrchestrationDeps = {
    sessions: sessionsApi,
    events: { log: async () => {} },
    db: {},
    flows: { get: () => null },
    config: {} as any,
    secrets: {} as any,
    blobStore: {} as any,
    computes: {} as any,
    agents: {} as any,
    runtimes: {} as any,
    pluginRegistry: {} as any,
    flowStates: {} as any,
    statusPollers: {} as any,
    messages: {} as any,
    tenantId: "default",
    arkDir: "/tmp/test-ark",
    app,
  } as unknown as OrchestrationDeps;

  return { deps, spy };
}

describe("destroyComputeActivity", () => {
  it("A: returns normally when session is not found (no throw)", async () => {
    const { deps, spy } = makeStubDeps({ session: null });
    injectDeps(deps);
    await expect(destroyComputeActivity({ sessionId: "s-missing" })).resolves.toBeUndefined();
    expect(spy.destroyCalls.length).toBe(0);
  });

  it("B: returns normally when session has no compute_handle (never provisioned)", async () => {
    const { deps, spy } = makeStubDeps({
      session: { id: "s-1", config: {} },
    });
    injectDeps(deps);
    await destroyComputeActivity({ sessionId: "s-1" });
    expect(spy.destroyCalls.length).toBe(0);
    expect(spy.rehydrateCalls.length).toBe(0);
  });

  it("C: rehydrates the persisted handle and calls compute.destroy()", async () => {
    const persistedHandle = {
      kind: "k8s",
      name: "ark-mpXYZ",
      meta: { k8s: { podName: "ark-mpXYZ", namespace: "ark", portForwardPid: null, arkdLocalPort: 0 } },
    };
    const { deps, spy } = makeStubDeps({
      session: { id: "s-2", config: { compute_handle: persistedHandle } },
    });
    injectDeps(deps);

    await destroyComputeActivity({ sessionId: "s-2" });

    expect(spy.rehydrateCalls).toEqual([persistedHandle]);
    expect(spy.destroyCalls).toEqual([persistedHandle]);
  });

  it("D: swallows compute.destroy() errors (best-effort cleanup, never blocks workflow finally)", async () => {
    const { deps, spy } = makeStubDeps({
      session: {
        id: "s-3",
        config: {
          compute_handle: {
            kind: "k8s",
            name: "ark-x",
            meta: { k8s: { podName: "ark-x", namespace: "ark", portForwardPid: null, arkdLocalPort: 0 } },
          },
        },
      },
      target: "throw-on-destroy",
    });
    injectDeps(deps);

    // Must NOT throw.
    await expect(destroyComputeActivity({ sessionId: "s-3" })).resolves.toBeUndefined();
    expect(spy.destroyCalls.length).toBe(1);
  });

  it("E: no-op when compute target no longer resolves (template deleted, etc.)", async () => {
    const { deps, spy } = makeStubDeps({
      session: {
        id: "s-4",
        config: { compute_handle: { kind: "k8s", name: "ark-y", meta: {} } },
      },
      unresolved: true,
    });
    injectDeps(deps);

    await destroyComputeActivity({ sessionId: "s-4" });
    expect(spy.destroyCalls.length).toBe(0);
  });

  it("F: no-op when AppContext is not wired (test profile compatibility)", async () => {
    const { deps, spy } = makeStubDeps({
      session: { id: "s-5", config: { compute_handle: { kind: "k8s", name: "x", meta: {} } } },
      noApp: true,
    });
    injectDeps(deps);
    await destroyComputeActivity({ sessionId: "s-5" });
    expect(spy.destroyCalls.length).toBe(0);
  });
});
