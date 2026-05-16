/**
 * `resolveRemoteRouting` (worktree/pr.ts) must fall back to
 * `session.config.compute_handle` when `attachExistingHandle` returns
 * null. Otherwise PR action stages (and any caller of `runGit`) silently
 * fall through to LOCAL routing for sessions whose compute_name still
 * points at a template (the per-session clone hasn't propagated back to
 * the row). Local routing then uses `effectiveRepo(session)` as cwd,
 * which is the URL for hosted-mode sessions -- `git -C <url>` fails with
 * "cannot change to '<url>': No such file or directory".
 *
 * Verified live 2026-05-15 on s-5htnih1l2d, which reached stage=pr cleanly
 * but failed the push action with that exact stderr.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { resolveRemoteRouting } from "../services/worktree/pr.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

describe("resolveRemoteRouting: persistedHandle fallback", () => {
  it("returns remote=true when attachExistingHandle is null but session.config.compute_handle is set", async () => {
    // The s-5htnih1l2d shape: compute_name points at the K8s template
    // (no pod_name -> attachExistingHandle returns null). The session row
    // carries the real handle in config.compute_handle, persisted by
    // provisionCompute on an earlier stage.
    await app.computes.insert({
      name: "docs-k8s-template",
      compute_kind: "k8s",
      isolation_kind: "direct",
      status: "stopped",
      config: { image: "test:latest", namespace: "ark", resources: { cpu: "100m", memory: "128Mi" } },
      is_template: true,
    } as any);

    const session = await app.sessions.create({
      summary: "routing-fallback-test",
      repo: "foundry-test-repo",
      config: {
        remoteRepo: "https://bitbucket.org/paytmteam/foundry-test-repo.git",
        compute_handle: {
          kind: "k8s",
          name: "ark-mp-test",
          meta: {
            k8s: {
              podName: "ark-mp-test",
              namespace: "ark",
              portForwardPid: null,
              arkdLocalPort: 19999,
              podIp: "10.0.0.1",
            },
          },
        },
      },
    } as any);
    await app.sessions.update(session.id, { compute_name: "docs-k8s-template" });

    const fresh = await app.sessions.get(session.id);
    const routing = await resolveRemoteRouting(app, fresh as any);
    // The 60s+ runtime is the K8s ensureReachable port-forward timeout
    // against the fake pod -- not a real assertion target. The function
    // catches that error and returns remote=true via the persistedHandle.
    expect(routing.remote).toBe(true);
    if (routing.remote) {
      expect(routing.remoteWorkdir).toBe(`/workspace/${session.id}/foundry-test-repo`);
    }
  }, 120_000);

  it("returns remote=false when both attachExistingHandle and config.compute_handle are missing", async () => {
    const session = await app.sessions.create({
      summary: "routing-no-handle",
      repo: "foundry-test-repo",
      config: { remoteRepo: "https://bitbucket.org/paytmteam/foundry-test-repo.git" },
    } as any);
    await app.sessions.update(session.id, { compute_name: "docs-k8s-template" });

    const fresh = await app.sessions.get(session.id);
    const routing = await resolveRemoteRouting(app, fresh as any);
    expect(routing.remote).toBe(false);
  }, 120_000);
});
