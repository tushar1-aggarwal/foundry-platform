/**
 * `Compute.prepareWorkspace` for remote computes (K8s, EC2) owns the
 * full workspace lifecycle: clone, checkout a session branch, and
 * persist both the resolved `session.workdir` and `session.branch` on
 * the session row. The conductor-side `setupSessionWorktree` is a
 * no-op for these (its capability guard short-circuits early), so
 * unless prepareWorkspace persists these columns, the row stays
 * null/wrong and downstream (PR action, status poller, web UI) breaks.
 *
 * Branch creation: `cloneWorkspaceViaArkd` accepts an optional
 * `branch` arg; when set, it issues a third arkd op:
 *   `git -C <remoteWorkdir> checkout -b <branch>`.
 * `Compute.prepareWorkspace` resolves the effective branch as
 * `opts.branch ?? "ark-<sessionId>"`, threads it through the helper,
 * and writes the resolved name back to `session.branch`.
 *
 * Companion to the conductor-side short-circuit fix in setup.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../app.js";
import { K8sCompute } from "../k8s.js";
import { EC2Compute, type EC2HandleMeta } from "../ec2/compute.js";
import { LocalCompute } from "../local.js";
import { FirecrackerCompute } from "../firecracker/compute.js";
import { cloneWorkspaceViaArkd, type RemoteCloneOpts } from "../workspace-clone.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

function makeEc2Handle(arkdLocalPort: number): { kind: "ec2"; name: string; meta: { ec2: EC2HandleMeta } } {
  return {
    kind: "ec2",
    name: "ec2-test",
    meta: {
      ec2: {
        instanceId: "i-abc",
        publicIp: null,
        privateIp: null,
        arkdLocalPort,
        portForwardPid: 1234,
        region: "us-east-1",
        stackName: "ark-compute-ec2-test",
        size: "m",
        arch: "x64",
      },
    },
  };
}

function makeK8sHandle(): {
  kind: "k8s";
  name: string;
  meta: {
    k8s: {
      podName: string;
      namespace: string;
      arkdLocalPort: number;
      portForwardPid: number | null;
      podIp: string | null;
    };
  };
} {
  return {
    kind: "k8s",
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

describe("cloneWorkspaceViaArkd branch checkout", () => {
  it("issues mkdir + clone + 'git -C <workdir> checkout -b <branch>' when branch is set", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      if (body) calls.push({ command: body.command, args: body.args });
      return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await cloneWorkspaceViaArkd({
        arkdUrl: "http://localhost:1",
        arkdToken: null,
        source: "git@example.com:org/repo.git",
        remoteWorkdir: "/workspace/s-abc/repo",
        branch: "ark-s-abc",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ command: "mkdir", args: ["-p", "/workspace/s-abc"] });
    expect(calls[1]).toEqual({
      command: "git",
      args: ["clone", "git@example.com:org/repo.git", "/workspace/s-abc/repo"],
    });
    // -B (uppercase): idempotent across retries -- creates the branch or
    // moves it to HEAD if it exists. -b would throw "already exists" on retry.
    expect(calls[2]).toEqual({ command: "git", args: ["-C", "/workspace/s-abc/repo", "checkout", "-B", "ark-s-abc"] });
  });

  it("does NOT issue checkout when branch is undefined (back-compat with callers that don't pass it)", async () => {
    const calls: Array<{ command: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      if (body) calls.push({ command: body.command });
      return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await cloneWorkspaceViaArkd({
        arkdUrl: "http://localhost:1",
        arkdToken: null,
        source: "x",
        remoteWorkdir: "/a/b",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.map((c) => c.command)).toEqual(["mkdir", "git"]); // no third "git checkout -b"
  });
});

describe("K8sCompute.prepareWorkspace persists session.workdir + branch", () => {
  it("writes opts.remoteWorkdir to session.workdir and resolves session.branch on the row", async () => {
    const session = await app.sessions.create({ summary: "k8s-persist" });
    const captured: RemoteCloneOpts[] = [];
    const k8s = new K8sCompute(app);
    k8s.setCloneHelperForTesting(async (opts) => {
      captured.push(opts);
    });

    await k8s.prepareWorkspace(makeK8sHandle(), {
      source: "https://example.com/foo.git",
      remoteWorkdir: "/workspace/" + session.id + "/foo",
      sessionId: session.id,
      branch: null, // simulate null branch -- compute should fall back to ark-<sid>
    } as any);

    // Helper got the resolved branch
    expect(captured).toHaveLength(1);
    expect(captured[0].branch).toBe("ark-" + session.id);
    expect(captured[0].remoteWorkdir).toBe("/workspace/" + session.id + "/foo");

    // Row got both fields persisted
    const after = await app.sessions.get(session.id);
    expect(after?.workdir).toBe("/workspace/" + session.id + "/foo");
    expect(after?.branch).toBe("ark-" + session.id);
  });

  it("preserves an explicit session.branch (does NOT overwrite with the ark-<sid> default)", async () => {
    const session = await app.sessions.create({ summary: "k8s-explicit-branch", branch: "feat/explicit" });
    const captured: RemoteCloneOpts[] = [];
    const k8s = new K8sCompute(app);
    k8s.setCloneHelperForTesting(async (opts) => {
      captured.push(opts);
    });

    await k8s.prepareWorkspace(makeK8sHandle(), {
      source: "https://example.com/foo.git",
      remoteWorkdir: "/workspace/" + session.id + "/foo",
      sessionId: session.id,
      branch: "feat/explicit",
    } as any);

    expect(captured[0].branch).toBe("feat/explicit");
    const after = await app.sessions.get(session.id);
    expect(after?.branch).toBe("feat/explicit");
  });

  it("does NOT touch session.workdir or session.branch on early-return (source=null)", async () => {
    const session = await app.sessions.create({ summary: "k8s-noop" });
    const k8s = new K8sCompute(app);
    k8s.setCloneHelperForTesting(async () => {});

    await k8s.prepareWorkspace(makeK8sHandle(), {
      source: null,
      remoteWorkdir: "/workspace/x/y",
      sessionId: session.id,
      branch: null,
    } as any);

    const after = await app.sessions.get(session.id);
    expect(after?.workdir).toBeFalsy();
    expect(after?.branch).toBeFalsy();
  });
});

describe("LocalCompute.prepareWorkspace persists session.workdir + branch (docker isolation)", () => {
  it("writes opts.remoteWorkdir to session.workdir and resolves session.branch on the row", async () => {
    const session = await app.sessions.create({ summary: "local-persist" });
    const captured: RemoteCloneOpts[] = [];
    const local = new LocalCompute(app);
    local.setCloneHelperForTesting(async (opts) => {
      captured.push(opts);
    });

    await local.prepareWorkspace(
      { kind: "local", name: "local", meta: {} } as any,
      {
        source: "https://example.com/foo.git",
        remoteWorkdir: "/work/" + session.id + "/foo",
        sessionId: session.id,
        branch: null,
      } as any,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].branch).toBe("ark-" + session.id);
    const after = await app.sessions.get(session.id);
    expect(after?.workdir).toBe("/work/" + session.id + "/foo");
    expect(after?.branch).toBe("ark-" + session.id);
  });
});

describe("FirecrackerCompute.prepareWorkspace persists session.workdir + branch", () => {
  it("writes opts.remoteWorkdir to session.workdir and resolves session.branch on the row", async () => {
    const session = await app.sessions.create({ summary: "fc-persist" });
    const captured: RemoteCloneOpts[] = [];
    const fc = new FirecrackerCompute(app);
    fc.setCloneHelperForTesting(async (opts) => {
      captured.push(opts);
    });

    const fcHandle = {
      kind: "firecracker" as const,
      name: "fc-test",
      meta: {
        firecracker: {
          vmId: "vm-abc",
          arkdUrl: "http://192.168.127.2:19300",
          guestHome: "/home/ubuntu",
        } as any,
      },
    };

    await fc.prepareWorkspace(
      fcHandle as any,
      {
        source: "https://example.com/foo.git",
        remoteWorkdir: "/home/ubuntu/Projects/" + session.id + "/foo",
        sessionId: session.id,
        branch: null,
      } as any,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].branch).toBe("ark-" + session.id);
    const after = await app.sessions.get(session.id);
    expect(after?.workdir).toBe("/home/ubuntu/Projects/" + session.id + "/foo");
    expect(after?.branch).toBe("ark-" + session.id);
  });
});

describe("EC2Compute.prepareWorkspace persists session.workdir + branch", () => {
  it("writes opts.remoteWorkdir to session.workdir and resolves session.branch on the row", async () => {
    const session = await app.sessions.create({ summary: "ec2-persist" });
    const captured: RemoteCloneOpts[] = [];
    const ec2 = new EC2Compute(app);
    ec2.setCloneHelperForTesting(async (opts) => {
      captured.push(opts);
    });

    await ec2.prepareWorkspace!(makeEc2Handle(54321), {
      source: "git@example.com:org/repo.git",
      remoteWorkdir: "/home/ubuntu/Projects/" + session.id + "/repo",
      sessionId: session.id,
      branch: null,
    } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0].branch).toBe("ark-" + session.id);

    const after = await app.sessions.get(session.id);
    expect(after?.workdir).toBe("/home/ubuntu/Projects/" + session.id + "/repo");
    expect(after?.branch).toBe("ark-" + session.id);
  });
});
