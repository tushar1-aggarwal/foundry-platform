/**
 * Git author identity on remote-compute prepareWorkspace.
 *
 * The conductor's setupSessionWorktree short-circuits for K8s/EC2/Firecracker
 * (any compute with supportsWorktree=false), so the per-worktree
 * `applyWorktreeGitIdentity` write never runs. Without a fix, the sandbox
 * pod has NO git config -- the agent invents an identity at commit time
 * (e.g. "Planner <planner@foundry.local>" on session s-tdthtvenac), which
 * Bitbucket's BB Violator rewrites and the repo loses real authorship.
 *
 * Spec: `Compute.prepareWorkspace` (K8s + Local-docker + EC2 + Firecracker)
 * resolves the agent identity via the same chain as the conductor and
 * issues two extra arkd exec ops AFTER the checkout:
 *   git -C <wd> config user.name <name>
 *   git -C <wd> config user.email <email>
 *
 * Resolution chain (first non-placeholder wins):
 *   1. app.config.git.{authorName, authorEmail}
 *   2. ARK_GIT_AUTHOR_NAME / ARK_GIT_AUTHOR_EMAIL env
 *   3. tenant secret via app.secrets.get(tenantId, name)
 *   4. placeholder "Ark Agent" / "agent@ark.local"
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../app.js";
import { K8sCompute } from "../k8s.js";
import { cloneWorkspaceViaArkd, type RemoteCloneOpts } from "../workspace-clone.js";
import { resolveAgentIdentityForRemoteCompute } from "../git-identity.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

function makeK8sHandle() {
  return {
    kind: "k8s" as const,
    name: "ark-test",
    meta: {
      k8s: {
        podName: "ark-test",
        namespace: "ark",
        arkdLocalPort: 54321,
        portForwardPid: null,
        podIp: null,
      },
    },
  };
}

// ── cloneWorkspaceViaArkd: author opts wired into the arkd exec sequence ──

describe("cloneWorkspaceViaArkd -- author git config", () => {
  async function captureCalls(opts: RemoteCloneOpts) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      if (body) calls.push({ command: body.command, args: body.args });
      return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await cloneWorkspaceViaArkd(opts);
    } finally {
      globalThis.fetch = originalFetch;
    }
    return calls;
  }

  it("issues 'git config user.name' + 'git config user.email' after clone+checkout when authorName+authorEmail are set", async () => {
    const calls = await captureCalls({
      arkdUrl: "http://localhost:1",
      arkdToken: null,
      source: "git@example.com:org/repo.git",
      remoteWorkdir: "/workspace/s-abc/repo",
      branch: "ark-s-abc",
      authorName: "Zineng Yuan",
      authorEmail: "zineng.yuan@paytm.com",
    });

    // mkdir, clone, checkout -B, config user.name, config user.email
    expect(calls).toHaveLength(5);
    expect(calls[0].command).toBe("mkdir");
    expect(calls[1].args.slice(0, 2)).toEqual(["clone", "git@example.com:org/repo.git"]);
    expect(calls[2].args).toEqual(["-C", "/workspace/s-abc/repo", "checkout", "-B", "ark-s-abc"]);
    expect(calls[3]).toEqual({
      command: "git",
      args: ["-C", "/workspace/s-abc/repo", "config", "user.name", "Zineng Yuan"],
    });
    expect(calls[4]).toEqual({
      command: "git",
      args: ["-C", "/workspace/s-abc/repo", "config", "user.email", "zineng.yuan@paytm.com"],
    });
  });

  it("does NOT issue config user.{name,email} when authorName/authorEmail are not set (back-compat)", async () => {
    const calls = await captureCalls({
      arkdUrl: "http://localhost:1",
      arkdToken: null,
      source: "git@example.com:org/repo.git",
      remoteWorkdir: "/workspace/s-abc/repo",
      branch: "ark-s-abc",
    });
    expect(calls).toHaveLength(3); // mkdir, clone, checkout -- no config
  });

  it("requires both authorName and authorEmail -- partial sets skip the git config step entirely", async () => {
    // Mismatched / partial identity is operator misconfiguration; rather than
    // pin one half and let git inherit the other from a stale source, we no-op.
    const calls = await captureCalls({
      arkdUrl: "http://localhost:1",
      arkdToken: null,
      source: "x",
      remoteWorkdir: "/a/b",
      branch: "ark-s-x",
      authorName: "Zineng Yuan",
      // authorEmail omitted
    });
    expect(calls.filter((c) => c.args[0] === "-C" && c.args[2] === "config")).toHaveLength(0);
  });
});

// ── resolution chain ──────────────────────────────────────────────────────

describe("resolveAgentIdentityForRemoteCompute -- resolution chain", () => {
  const placeholder = { name: "Ark Agent", email: "agent@ark.local" };

  it("step 1: app.config.git.{authorName, authorEmail} when non-placeholder", async () => {
    (app.config as any).git = { authorName: "Bot Override", authorEmail: "bot@example.com" };
    const id = await resolveAgentIdentityForRemoteCompute(app, "default");
    expect(id).toEqual({ name: "Bot Override", email: "bot@example.com" });
  });

  it("step 1 treats the literal placeholder in app.config.git as 'no override'", async () => {
    (app.config as any).git = { authorName: "Ark Agent", authorEmail: "agent@ark.local" };
    const id = await resolveAgentIdentityForRemoteCompute(app, "default");
    // No env, no tenant secret in test profile -- should fall through to placeholder.
    expect(id).toEqual(placeholder);
  });

  it("step 2: ARK_GIT_AUTHOR_NAME / ARK_GIT_AUTHOR_EMAIL env when config is placeholder", async () => {
    (app.config as any).git = undefined;
    const originalName = process.env.ARK_GIT_AUTHOR_NAME;
    const originalEmail = process.env.ARK_GIT_AUTHOR_EMAIL;
    process.env.ARK_GIT_AUTHOR_NAME = "Env Author";
    process.env.ARK_GIT_AUTHOR_EMAIL = "env@example.org";
    try {
      const id = await resolveAgentIdentityForRemoteCompute(app, "default");
      expect(id).toEqual({ name: "Env Author", email: "env@example.org" });
    } finally {
      if (originalName === undefined) delete process.env.ARK_GIT_AUTHOR_NAME;
      else process.env.ARK_GIT_AUTHOR_NAME = originalName;
      if (originalEmail === undefined) delete process.env.ARK_GIT_AUTHOR_EMAIL;
      else process.env.ARK_GIT_AUTHOR_EMAIL = originalEmail;
    }
  });

  it("step 3: tenant secret via app.secrets.get when config + env are empty", async () => {
    (app.config as any).git = undefined;
    delete process.env.ARK_GIT_AUTHOR_NAME;
    delete process.env.ARK_GIT_AUTHOR_EMAIL;
    // Seed tenant secrets in the test-profile secrets backend.
    await app.secrets.set("default", "ARK_GIT_AUTHOR_NAME", "Tenant Author", { type: "env-var" });
    await app.secrets.set("default", "ARK_GIT_AUTHOR_EMAIL", "tenant@example.org", { type: "env-var" });
    try {
      const id = await resolveAgentIdentityForRemoteCompute(app, "default");
      expect(id).toEqual({ name: "Tenant Author", email: "tenant@example.org" });
    } finally {
      await app.secrets.delete("default", "ARK_GIT_AUTHOR_NAME");
      await app.secrets.delete("default", "ARK_GIT_AUTHOR_EMAIL");
    }
  });

  it("step 4: placeholder fallback when nothing resolves", async () => {
    (app.config as any).git = undefined;
    delete process.env.ARK_GIT_AUTHOR_NAME;
    delete process.env.ARK_GIT_AUTHOR_EMAIL;
    const id = await resolveAgentIdentityForRemoteCompute(app, "default");
    expect(id).toEqual(placeholder);
  });
});

// ── K8sCompute.prepareWorkspace threads resolved identity into clone helper ──

describe("K8sCompute.prepareWorkspace -- threads author identity through", () => {
  it("passes authorName + authorEmail (from config override) into the clone helper", async () => {
    (app.config as any).git = { authorName: "Config Author", authorEmail: "config@example.com" };
    const session = await app.sessions.create({ summary: "k8s-author-config" });
    const captured: RemoteCloneOpts[] = [];
    const k8s = new K8sCompute(app);
    k8s.setCloneHelperForTesting(async (opts) => {
      captured.push(opts);
    });

    await k8s.prepareWorkspace(makeK8sHandle(), {
      source: "https://example.com/foo.git",
      remoteWorkdir: "/workspace/" + session.id + "/foo",
      sessionId: session.id,
      branch: null,
    } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0].authorName).toBe("Config Author");
    expect(captured[0].authorEmail).toBe("config@example.com");
  });

  it("passes tenant-secret-resolved identity when config is empty", async () => {
    (app.config as any).git = undefined;
    delete process.env.ARK_GIT_AUTHOR_NAME;
    delete process.env.ARK_GIT_AUTHOR_EMAIL;
    await app.secrets.set("default", "ARK_GIT_AUTHOR_NAME", "Secret Author", { type: "env-var" });
    await app.secrets.set("default", "ARK_GIT_AUTHOR_EMAIL", "secret@paytm.com", { type: "env-var" });
    try {
      const session = await app.sessions.create({ summary: "k8s-author-secret" });
      const captured: RemoteCloneOpts[] = [];
      const k8s = new K8sCompute(app);
      k8s.setCloneHelperForTesting(async (opts) => {
        captured.push(opts);
      });
      await k8s.prepareWorkspace(makeK8sHandle(), {
        source: "https://example.com/foo.git",
        remoteWorkdir: "/workspace/" + session.id + "/foo",
        sessionId: session.id,
        branch: null,
      } as any);
      expect(captured[0].authorName).toBe("Secret Author");
      expect(captured[0].authorEmail).toBe("secret@paytm.com");
    } finally {
      await app.secrets.delete("default", "ARK_GIT_AUTHOR_NAME");
      await app.secrets.delete("default", "ARK_GIT_AUTHOR_EMAIL");
    }
  });
});
