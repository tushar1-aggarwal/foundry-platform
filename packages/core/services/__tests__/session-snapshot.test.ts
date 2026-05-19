/**
 * Unit tests for pauseWithSnapshot / resumeFromSnapshot / resolveSessionCompute.
 *
 * Tests the core pause/resume-with-snapshot orchestration independently from
 * the RPC layer. Uses a minimal fake compute + in-memory snapshot store to
 * exercise all branches: success, session not found, compute not found,
 * capability not supported, snapshot/restore errors, and persist failures.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../app.js";
import { pauseWithSnapshot, resumeFromSnapshot, resolveSessionCompute } from "../session-snapshot.js";
import { depsFromApp } from "../deps.js";
import type {
  Compute,
  ComputeCapabilities,
  ComputeHandle,
  ComputeKind,
  ProvisionOpts,
  Snapshot,
} from "../../compute/types.js";
import { NotSupportedError } from "../../compute/types.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

// ── Fake computes ─────────────────────────────────────────────────────────

class FakeSnapshotCompute implements Compute {
  readonly kind: ComputeKind = "ec2";
  readonly capabilities: ComputeCapabilities = {
    snapshot: true,
    networkIsolation: true,
    provisionLatency: "seconds",
  };
  snapshotCalls = 0;
  restoreCalls = 0;
  lastRestored: Snapshot | null = null;
  snapshotError: Error | null = null;
  restoreError: Error | null = null;

  setApp(_app: AppContext): void {}
  async provision(_opts: ProvisionOpts): Promise<ComputeHandle> {
    return { kind: this.kind, name: "fake-fc", meta: {} };
  }
  async start(_h: ComputeHandle): Promise<void> {}
  async stop(_h: ComputeHandle): Promise<void> {}
  async destroy(_h: ComputeHandle): Promise<void> {}
  getArkdUrl(_h: ComputeHandle): string {
    return "http://localhost:19300";
  }
  async snapshot(_h: ComputeHandle): Promise<Snapshot> {
    this.snapshotCalls++;
    if (this.snapshotError) throw this.snapshotError;
    return {
      id: "snap-native",
      computeKind: this.kind,
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: { memFilePath: "/tmp/m", stateFilePath: "/tmp/s" },
    };
  }
  async restore(s: Snapshot): Promise<ComputeHandle> {
    this.restoreCalls++;
    this.lastRestored = s;
    if (this.restoreError) throw this.restoreError;
    return { kind: this.kind, name: "fake-fc", meta: { restored: true } };
  }
}

async function seedSession(computeName?: string): Promise<string> {
  // Row factory only: these tests exercise pause/resume-with-snapshot
  // orchestration, not workflow start. sessions.create() avoids spinning a
  // real Temporal sessionWorkflow (Temporal is the sole orchestrator now).
  const session = await app.sessions.create({ summary: "pause-snap-test", repo: ".", flow: "bare" });
  if (computeName) {
    await app.sessions.update(session.id, { compute_name: computeName });
  }
  return session.id;
}

async function ensureCompute(name: string, provider: string, computeKind?: string): Promise<void> {
  if (await app.computes.get(name)) return;
  // Map the provider-name string the test passes to a (compute, isolation)
  // pair. Surviving compute kinds: local | ec2 | k8s -- each maps 1:1.
  const compute = (computeKind ?? (provider === "ec2" ? "ec2" : provider === "k8s" ? "k8s" : "local")) as any;
  await app.computeService.create({
    name,
    compute,
    isolation: "direct",
    config: {},
  });
}

// ── resolveSessionCompute ─────────────────────────────────────────────────

describe("resolveSessionCompute", async () => {
  it("returns null for nonexistent session", async () => {
    expect(await resolveSessionCompute(depsFromApp(app), "s-does-not-exist")).toBeNull();
  });

  it("resolves local compute by default", async () => {
    const id = await seedSession();
    const resolved = await resolveSessionCompute(depsFromApp(app), id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("local");
    expect(resolved!.handle.kind).toBe("local");
  });

  it("resolves k8s compute from compute_kind column", async () => {
    // k8s only auto-registers when @kubernetes/client-node is present
    // (absent on default test runners). Stand up a fake first so
    // `computeService.create` finds a Compute for the kind.
    const fake = new FakeSnapshotCompute();
    (fake as any).kind = "k8s";
    app.registerCompute(fake);
    await ensureCompute("k8s-test", "k8s", "k8s");
    const id = await seedSession("k8s-test");
    const resolved = await resolveSessionCompute(depsFromApp(app), id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("k8s");
  });

  it("resolves ec2 compute from compute_kind column", async () => {
    await ensureCompute("ec2-large", "ec2");
    const id = await seedSession("ec2-large");
    const resolved = await resolveSessionCompute(depsFromApp(app), id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("ec2");
  });

  // Regression: the old helper derived kind from the compute name prefix
  // (e.g. "ec2-prod" -> "local"). Now that we read `compute.compute_kind`
  // directly, a user-chosen name pointing at an ec2 compute resolves to
  // the correct kind.
  it("reads compute_kind column for user-named compute", async () => {
    await ensureCompute("prod-box", "ec2");
    const id = await seedSession("prod-box");
    const resolved = await resolveSessionCompute(depsFromApp(app), id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("ec2");
  });

  it("returns null when compute_name points at a missing compute row", async () => {
    const id = await seedSession("does-not-exist");
    expect(await resolveSessionCompute(depsFromApp(app), id)).toBeNull();
  });

  it("includes compute_handle metadata from session config", async () => {
    const id = await seedSession();
    await app.sessions.update(id, {
      config: { compute_handle: { instanceId: "i-abc" } },
    });
    const resolved = await resolveSessionCompute(depsFromApp(app), id);
    expect(resolved).not.toBeNull();
    expect(resolved!.handle.meta).toEqual({ instanceId: "i-abc" });
  });
});

// ── pauseWithSnapshot ─────────────────────────────────────────────────────

describe("pauseWithSnapshot", async () => {
  let fake: FakeSnapshotCompute;

  beforeEach(async () => {
    fake = new FakeSnapshotCompute();
    fake.snapshotError = null;
    fake.restoreError = null;
    fake.snapshotCalls = 0;
    fake.restoreCalls = 0;
    app.registerCompute(fake);
    await ensureCompute("ec2-snap", "ec2", "ec2");
  });

  it("snapshots + persists + marks session blocked", async () => {
    const id = await seedSession("ec2-snap");
    const result = await pauseWithSnapshot(depsFromApp(app), id, { reason: "test pause" });

    expect(result.ok).toBe(true);
    expect(result.message).toBe("Paused");
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.computeKind).toBe("ec2");
    expect(result.snapshot!.sessionId).toBe(id);
    expect(result.snapshot!.metadata).toEqual({ memFilePath: "/tmp/m", stateFilePath: "/tmp/s" });
    expect(fake.snapshotCalls).toBe(1);

    const session = await app.sessions.get(id)!;
    expect(session.status).toBe("blocked");
    expect(session.breakpoint_reason).toBe("test pause");
    expect((session.config as Record<string, unknown>).last_snapshot_id).toBe(result.snapshot!.id);
  });

  it("defaults reason to 'User paused'", async () => {
    const id = await seedSession("ec2-snap");
    await pauseWithSnapshot(depsFromApp(app), id);
    expect((await app.sessions.get(id))!.breakpoint_reason).toBe("User paused");
  });

  it("returns not-found for missing session", async () => {
    const result = await pauseWithSnapshot(depsFromApp(app), "s-ghost");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns notSupported for non-snapshot compute", async () => {
    const id = await seedSession(); // local compute
    const result = await pauseWithSnapshot(depsFromApp(app), id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("returns error when compute.snapshot() throws generic error", async () => {
    fake.snapshotError = new Error("VM crashed");
    const id = await seedSession("ec2-snap");
    const result = await pauseWithSnapshot(depsFromApp(app), id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("VM crashed");
    expect(result.notSupported).toBeUndefined();
  });

  it("returns notSupported when compute.snapshot() throws NotSupportedError", async () => {
    fake.snapshotError = new NotSupportedError("ec2", "snapshot");
    const id = await seedSession("ec2-snap");
    const result = await pauseWithSnapshot(depsFromApp(app), id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("logs session_paused event with snapshot data", async () => {
    const id = await seedSession("ec2-snap");
    const result = await pauseWithSnapshot(depsFromApp(app), id, { reason: "deploy" });
    const evts = await app.events.list(id, { type: "session_paused" });
    expect(evts.length).toBeGreaterThanOrEqual(1);
    const latest = evts[evts.length - 1];
    expect(latest.data).toBeDefined();
    const data = typeof latest.data === "string" ? JSON.parse(latest.data) : latest.data;
    expect(data.snapshot_id).toBe(result.snapshot!.id);
  });
});

// ── resumeFromSnapshot ────────────────────────────────────────────────────

describe("resumeFromSnapshot", async () => {
  let fake: FakeSnapshotCompute;

  beforeEach(async () => {
    fake = new FakeSnapshotCompute();
    fake.snapshotError = null;
    fake.restoreError = null;
    fake.snapshotCalls = 0;
    fake.restoreCalls = 0;
    app.registerCompute(fake);
    await ensureCompute("ec2-res", "ec2", "ec2");
  });

  it("restores from session's last_snapshot_id", async () => {
    const id = await seedSession("ec2-res");
    const pauseResult = await pauseWithSnapshot(depsFromApp(app), id);
    expect(pauseResult.ok).toBe(true);

    const result = await resumeFromSnapshot(depsFromApp(app), id);
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(pauseResult.snapshot!.id);
    expect(fake.restoreCalls).toBe(1);

    const session = await app.sessions.get(id)!;
    expect(session.status).toBe("ready");
    expect(session.breakpoint_reason).toBeNull();
  });

  it("accepts explicit snapshotId", async () => {
    const id = await seedSession("ec2-res");
    const pauseResult = await pauseWithSnapshot(depsFromApp(app), id);

    const result = await resumeFromSnapshot(depsFromApp(app), id, { snapshotId: pauseResult.snapshot!.id });
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(pauseResult.snapshot!.id);
  });

  it("falls back to latest snapshot from store when no last_snapshot_id", async () => {
    const id = await seedSession("ec2-res");
    const pauseResult = await pauseWithSnapshot(depsFromApp(app), id);

    // Clear last_snapshot_id from config
    await app.sessions.update(id, { config: {} });

    const result = await resumeFromSnapshot(depsFromApp(app), id);
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe(pauseResult.snapshot!.id);
  });

  it("returns not-found for missing session", async () => {
    const result = await resumeFromSnapshot(depsFromApp(app), "s-ghost");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns error when no snapshot available", async () => {
    const id = await seedSession("ec2-res");
    const result = await resumeFromSnapshot(depsFromApp(app), id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No snapshot available");
  });

  it("returns error when compute.restore() throws generic error", async () => {
    const id = await seedSession("ec2-res");
    await pauseWithSnapshot(depsFromApp(app), id);
    fake.restoreError = new Error("disk full");
    const result = await resumeFromSnapshot(depsFromApp(app), id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("disk full");
  });

  it("returns notSupported when compute.restore() throws NotSupportedError", async () => {
    const id = await seedSession("ec2-res");
    await pauseWithSnapshot(depsFromApp(app), id);
    fake.restoreError = new NotSupportedError("ec2", "restore");
    const result = await resumeFromSnapshot(depsFromApp(app), id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("returns notSupported when referenced compute lacks restore capability", async () => {
    const id = await seedSession(); // local compute (no snapshot support)

    // Manually save a snapshot referencing "local" compute kind
    const blob = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    const saved = await app.snapshotStore.save({ computeKind: "local", sessionId: id, metadata: {} }, blob);
    await app.sessions.update(id, {
      config: { last_snapshot_id: saved.id },
    });

    const result = await resumeFromSnapshot(depsFromApp(app), id);
    expect(result.ok).toBe(false);
    expect(result.notSupported).toBe(true);
  });

  it("logs session_resumed event with snapshot data", async () => {
    const id = await seedSession("ec2-res");
    await pauseWithSnapshot(depsFromApp(app), id);
    const result = await resumeFromSnapshot(depsFromApp(app), id);
    expect(result.ok).toBe(true);

    const evts = await app.events.list(id, { type: "session_resumed" });
    expect(evts.length).toBeGreaterThanOrEqual(1);
    const latest = evts[evts.length - 1];
    const data = typeof latest.data === "string" ? JSON.parse(latest.data) : latest.data;
    expect(data.snapshot_id).toBe(result.snapshotId);
  });

  it("round-trips pause + resume preserving snapshot metadata", async () => {
    const id = await seedSession("ec2-res");
    const pauseResult = await pauseWithSnapshot(depsFromApp(app), id, { reason: "round-trip" });
    expect(pauseResult.snapshot!.metadata).toEqual({ memFilePath: "/tmp/m", stateFilePath: "/tmp/s" });

    const resumeResult = await resumeFromSnapshot(depsFromApp(app), id);
    expect(resumeResult.ok).toBe(true);
    expect(fake.lastRestored!.metadata).toEqual({ memFilePath: "/tmp/m", stateFilePath: "/tmp/s" });
  });
});
