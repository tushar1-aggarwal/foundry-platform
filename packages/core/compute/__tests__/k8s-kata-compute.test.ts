/**
 * KataCompute unit tests.
 *
 * KataCompute extends K8sCompute with:
 *   - `kind = "k8s-kata"`
 *   - `capabilities.networkIsolation` flipped to true (microVM per pod).
 *     `capabilities.snapshot` stays false: snapshot/restore only throw, so
 *     a `true` flag would be a capability lie the dispatcher acts on.
 *   - pod spec annotated with `runtimeClassName` (default "kata", overridable)
 *
 * These tests verify those three deltas; the full K8sCompute lifecycle is
 * exercised in `k8s-compute.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { KataCompute, DEFAULT_KATA_RUNTIME_CLASS } from "../k8s-kata.js";
import type { K8sComputeDeps } from "../k8s.js";
import { NotSupportedError, type Snapshot } from "../types.js";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

// Minimal harness. Keeps only the state assertions here care about --
// `lastPod` for spec annotation checks and a shared `calls` list for the
// runtimeClassName-on-meta branch.
interface RecordedCall {
  method: string;
  args: unknown[];
}

class FakeChildProcess extends EventEmitter {
  public pid = 777;
}

interface Harness {
  calls: RecordedCall[];
  lastPod: any;
  deps: K8sComputeDeps;
}

function makeHarness(): Harness {
  const harness = { calls: [] as RecordedCall[], lastPod: null as any, deps: null as unknown as K8sComputeDeps };
  const fakeModule = {
    KubeConfig: class {
      loadFromFile() {}
      loadFromDefault() {}
      makeApiClient() {
        return {
          readNamespace: async (opts: any) => ({ metadata: { name: opts.name } }),
          createNamespace: async () => {},
          createNamespacedPod: async (opts: any) => {
            harness.calls.push({ method: "createNamespacedPod", args: [opts] });
            harness.lastPod = opts.body;
          },
          // K8sCompute.provision() polls this until `status.phase === "Running"`.
          // Returning Running immediately short-circuits the 2-min wait loop;
          // podIP populates the in-cluster routing path used by setupPortForward.
          readNamespacedPod: async () => ({ status: { phase: "Running", podIP: "10.0.0.1" } }),
          deleteNamespacedPod: async (opts: any) => {
            harness.calls.push({ method: "deleteNamespacedPod", args: [opts] });
          },
        };
      }
    },
    CoreV1Api: class {},
  };
  harness.deps = {
    loadK8sModule: async () => fakeModule as any,
    spawnPortForward: () => new FakeChildProcess() as unknown as ChildProcess,
    allocatePort: async () => 45678,
    // Default fetchHealth does real network probes against localhost:<port>/health,
    // which never answers in unit-test land. K8sCompute.setupPortForward polls
    // /health for up to 60s, so without this stub every provision() call times
    // out at the 5s per-test cap. Returning true short-circuits to the success
    // branch immediately.
    fetchHealth: async () => true,
    // Same idea for the in-pod arkd readiness probe (60s cap via 1s sleeps).
    probeArkdInPod: async () => true,
  } as Partial<K8sComputeDeps> as K8sComputeDeps;
  return harness;
}

function makeKataCompute(deps: K8sComputeDeps): KataCompute {
  const c = new KataCompute(app);
  c.setDeps(deps);
  return c;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("KataCompute", async () => {
  it("advertises `kind: 'k8s-kata'` and microVM-appropriate capabilities", () => {
    const c = new KataCompute(app);
    expect(c.kind).toBe("k8s-kata");
    expect(c.capabilities).toEqual({
      snapshot: false,
      pool: true,
      networkIsolation: true,
      provisionLatency: "seconds",
      singleton: false,
      canDelete: true,
      canReboot: false,
      supportsWorktree: false,
      supportsSecretMount: true,
      needsAuth: true,
      initialStatus: "stopped",
      isolationModes: [{ value: "pod", label: "Pod" }],
    });
  });

  it("annotates the pod spec with the default Kata runtimeClassName", async () => {
    const harness = makeHarness();
    const c = makeKataCompute(harness.deps);
    await c.provision({ tags: { name: "micro" }, config: {} });
    expect(harness.lastPod.spec.runtimeClassName).toBe(DEFAULT_KATA_RUNTIME_CLASS);
  });

  it("respects an explicit runtimeClassName from ProvisionOpts.config", async () => {
    const harness = makeHarness();
    const c = makeKataCompute(harness.deps);
    await c.provision({ tags: { name: "micro" }, config: { runtimeClassName: "kata-fc" } });
    expect(harness.lastPod.spec.runtimeClassName).toBe("kata-fc");
  });

  it("records runtimeClassName on handle.meta.k8s", async () => {
    const harness = makeHarness();
    const c = makeKataCompute(harness.deps);
    const h = await c.provision({ tags: { name: "micro" }, config: { runtimeClassName: "kata-qemu" } });
    expect((h.meta as any).k8s.runtimeClassName).toBe("kata-qemu");
  });

  it("still preserves the arkd container port on the pod spec", async () => {
    const harness = makeHarness();
    const c = makeKataCompute(harness.deps);
    await c.provision({ tags: { name: "micro" }, config: {} });
    expect(harness.lastPod.spec.containers[0].ports).toEqual([{ containerPort: 19300, name: "arkd" }]);
  });

  it("snapshot still throws NotSupportedError (real impl deferred)", async () => {
    const harness = makeHarness();
    const c = makeKataCompute(harness.deps);
    const h = await c.provision({ tags: { name: "micro" }, config: {} });
    (await expect(c.snapshot(h))).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("restore still throws NotSupportedError", async () => {
    const harness = makeHarness();
    const c = makeKataCompute(harness.deps);
    const snap: Snapshot = {
      id: "kata-1",
      computeKind: "k8s-kata",
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: {},
    };
    (await expect(c.restore(snap))).rejects.toBeInstanceOf(NotSupportedError);
  });
});
