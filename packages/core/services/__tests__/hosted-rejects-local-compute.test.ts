/**
 * Per-stage-pod invariant guard.
 *
 * In hosted mode, `local` compute would run the agent in-process on the
 * control-plane / temporal-worker pod with zero isolation -- breaking the
 * "one pod per flow stage" model. `SessionService.start` must reject it
 * (explicit "local" OR the implicit fallback) loudly, not silently run it
 * in the worker. Local mode must keep accepting `local`.
 *
 * Regression guard for the 2026-05-17 live-k8s smoke finding.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { asValue } from "awilix";
import { AppContext } from "../../app.js";
import { buildHostedAppMode } from "../../modes/app-mode.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown().catch(() => undefined);
});

function makeHosted(): void {
  const hostedMode = buildHostedAppMode({ dialect: "postgres", url: "postgres://x" }, app.config as any);
  (app as any)._container.register({ mode: asValue(hostedMode) });
}

describe("hosted mode rejects local compute (per-stage-pod invariant)", () => {
  it("rejects an explicit compute_name=local in hosted mode", async () => {
    makeHosted();
    await expect(app.sessionService.start({ summary: "x", compute_name: "local" })).rejects.toThrow(
      /non-local compute|zero isolation|per-stage|control-plane\/temporal-worker/i,
    );
  });

  it("rejects the implicit local fallback (no compute_name) in hosted mode", async () => {
    makeHosted();
    await expect(app.sessionService.start({ summary: "x" })).rejects.toThrow(/non-local compute|zero isolation/i);
  });

  it("does not reject an explicit non-local compute in hosted mode", async () => {
    makeHosted();
    // May fail later (no real compute target wired in this minimal test),
    // but it MUST NOT be the per-stage-pod rejection.
    try {
      await app.sessionService.start({ summary: "x", compute_name: "k8s-agent" });
    } catch (e: any) {
      expect(String(e?.message ?? e)).not.toMatch(/non-local compute|zero isolation|per-stage/i);
    }
  });

  it("local mode still accepts local compute (no regression)", async () => {
    const s = await app.sessionService.start({ summary: "x", compute_name: "local" });
    expect(s.id).toMatch(/^s-/);
    expect(s.compute_name).toBe("local");
  });
});
