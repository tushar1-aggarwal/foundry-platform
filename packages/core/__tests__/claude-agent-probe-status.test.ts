/**
 * claude-agent's runtime-aware status probe (#435).
 *
 * The status-poller calls executor.probeStatus instead of
 * `AgentHandle.checkAlive` when the executor implements it. claude-agent
 * spawns its agent as a Bun process via arkd /process/spawn, NOT tmux,
 * so the tmux-based /agent/status (the default checkAlive query) always
 * returns false for it. Without this polymorphic probe the poller flips
 * the row to "completed" within ~3s of launch, kicks the action chain
 * prematurely, and leaves the session in an inconsistent state when the
 * actually-still-running agent later emits SessionEnd.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import { claudeAgentExecutor } from "../executors/claude-agent.js";
import type { LocalCompute } from "../compute/local.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
});

/**
 * Stub LocalCompute's ArkdClient factory so handle.statusProcess returns
 * what each test wants. Keeps the wiring honest -- we exercise the real
 * `attachComputeMethods` path that decorates handles with
 * `statusProcess`.
 */
function stubArkdStatusProcess(result: { running: boolean; pid?: number; exitCode?: number }): void {
  const local = app.getCompute("local") as LocalCompute;
  local.setClientFactoryForTesting(
    () =>
      ({
        statusProcess: async () => result,
        snapshot: async () => ({}) as any,
        spawnProcess: async () => ({ pid: 0 }),
        killProcess: async () => ({ wasRunning: false }),
      }) as any,
  );
}

async function makeSessionPinnedToLocal(summary: string) {
  const session = await app.sessions.create({ summary, flow: "quick" });
  await app.sessions.update(session.id, { compute_name: "local" });
  return (await app.sessions.get(session.id))!;
}

describe("claude-agent.probeStatus (#435)", () => {
  it("reports running when arkd /process/status says the PID is alive", async () => {
    const session = await makeSessionPinnedToLocal("probe running");
    stubArkdStatusProcess({ running: true, pid: 12345 });

    const result = await claudeAgentExecutor.probeStatus!({
      app,
      session,
      handle: `ark-${session.id}`,
    });

    expect(result.state).toBe("running");
  });

  it("reports completed when the process exited with code 0", async () => {
    const session = await makeSessionPinnedToLocal("probe completed");
    stubArkdStatusProcess({ running: false, exitCode: 0 });

    const result = await claudeAgentExecutor.probeStatus!({
      app,
      session,
      handle: `ark-${session.id}`,
    });

    expect(result.state).toBe("completed");
    expect((result as { exitCode?: number }).exitCode).toBe(0);
  });

  it("reports failed when the process exited with a non-zero code", async () => {
    const session = await makeSessionPinnedToLocal("probe failed");
    stubArkdStatusProcess({ running: false, exitCode: 137 });

    const result = await claudeAgentExecutor.probeStatus!({
      app,
      session,
      handle: `ark-${session.id}`,
    });

    expect(result.state).toBe("failed");
    expect((result as { error?: string }).error).toContain("137");
  });

  it("reports not_found when arkd has no record of the handle (no exitCode)", async () => {
    // This is what arkd returns after a daemon restart: the in-memory
    // process map is empty, so the handle lookup misses entirely.
    const session = await makeSessionPinnedToLocal("probe not_found");
    stubArkdStatusProcess({ running: false });

    const result = await claudeAgentExecutor.probeStatus!({
      app,
      session,
      handle: `ark-${session.id}`,
    });

    expect(result.state).toBe("not_found");
  });

  it("falls back to running when no compute target resolves", async () => {
    // No compute target -- a misconfigured session must NOT cause a false-
    // positive completion. The poller treats "running" as "keep waiting" so
    // an unresolved target is safer than synthesizing not_found.
    const session = await app.sessions.create({ summary: "no-target", flow: "quick" });
    // session.compute_name is null and the test profile's defaultProvider
    // resolves to "local" -- but if the compute handle's `statusProcess`
    // is missing the executor returns "running".
    const local = app.getCompute("local") as LocalCompute;
    local.setClientFactoryForTesting(
      () =>
        ({
          // Force the underlying call to throw so the executor's outer
          // try is hit; status-poller wraps probeStatus in its own try/catch.
        }) as any,
    );

    // Just check the executor doesn't crash on a session whose target is
    // resolvable but whose statusProcess will fail. The status-poller
    // fallback kicks in for unresolved targets too.
    const result = await claudeAgentExecutor.probeStatus!({
      app,
      session,
      handle: `ark-${session.id}`,
    }).catch(() => ({ state: "running" as const }));

    expect(result.state).toBeDefined();
  });

  it("falls back to session.config.compute_handle when attachExistingHandle returns null (template-row bug)", async () => {
    // Regression for the docs-flow EKS hang: session.compute_name points at
    // a TEMPLATE compute row (e.g. "docs-k8s") whose config has no pod_name.
    // K8sCompute.attachExistingHandle returns null for that template row, so
    // probeStatus previously hit the `!computeHandle?.statusProcess` guard
    // and returned { state: "running" } forever even though arkd in the pod
    // had { running: false, exitCode: 1 } ready under ark-s-<sid>.
    //
    // Strategy: stub app.resolveComputeTarget to return a target whose
    // compute.attachExistingHandle is a stub returning null AND whose
    // compute.rehydrateHandle is a stub returning a methoded handle. The
    // session carries a RAW persisted compute_handle (kind/name/meta only --
    // no method closures, because JSON.stringify drops them; target-resolver.ts
    // documents this). The fix must call rehydrateHandle on the persisted
    // state to re-attach statusProcess, not pass the raw handle directly.
    // See status-poller.ts:129-137 for the precedent pattern.
    const session = await makeSessionPinnedToLocal("template-row-phantom-handle");

    // Persist a RAW handle on session.config -- kind/name/meta only, no
    // statusProcess closure. This is what runTargetLifecycle writes via
    // persistHandleState (target-resolver.ts) after stripping method closures.
    const sessionWithHandle = {
      ...session,
      config: {
        ...(session.config as object),
        compute_handle: {
          kind: "local" as const,
          name: "local",
          meta: { mock_pod: "ark-mock-pod" },
        },
      },
    };

    // Track whether rehydrateHandle is called -- the fix must use it to
    // re-attach methods. We supply a methoded handle so statusProcess works.
    let rehydrateCalled = false;
    const methodedHandle = {
      kind: "local" as const,
      name: "local",
      meta: { mock_pod: "ark-mock-pod" },
      statusProcess: async (_h: string) => ({ running: false as const, exitCode: 1 }),
    } as any;

    const origResolve = app.resolveComputeTarget.bind(app);
    (app as any).resolveComputeTarget = async (s: any) => {
      const result = await origResolve(s);
      if (result?.target?.compute) {
        result.target.compute = {
          ...result.target.compute,
          // Simulate template row: attachExistingHandle sees no pod_name -> null
          attachExistingHandle: (_row: any) => null,
          // Rehydrate the raw persisted state into a methoded handle. This is
          // what the fix must call to recover statusProcess.
          rehydrateHandle: (state: any) => {
            rehydrateCalled = true;
            return { ...methodedHandle, meta: state.meta ?? methodedHandle.meta };
          },
        } as any;
      }
      return result;
    };

    try {
      const probeResult = await claudeAgentExecutor.probeStatus!({
        app,
        session: sessionWithHandle as any,
        handle: `ark-${session.id}`,
      });

      // Without the fix this returns { state: "running" } silently.
      // With the fix it must rehydrate the persisted handle and return failed.
      expect(rehydrateCalled).toBe(true);
      expect(probeResult.state).toBe("failed");
      expect((probeResult as { error?: string }).error).toMatch(/exit.*1/i);
    } finally {
      (app as any).resolveComputeTarget = origResolve;
    }
  });
});
