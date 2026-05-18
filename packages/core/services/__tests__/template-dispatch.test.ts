/**
 * Template-dispatch integration tests.
 *
 * A stage that references a template row resolves to the template's own
 * name -- it is NOT cloned into a per-session row. The template is a
 * read-only spec; the provision path materializes an ephemeral pod from it
 * and binds the pod to the session via its handle. Nothing to GC.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../../app.js";
import { garbageCollectComputeIfTemplate } from "../compute-lifecycle.js";
import { depsFromApp } from "../deps.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
});

describe("resolveComputeForStage + template materialization", () => {
  it("resolves a template to its own name (no clone row created)", async () => {
    await app.computeService.create({
      name: "k8s-tmpl",
      compute: "k8s",
      isolation: "direct",
      config: { context: "ctx", namespace: "ns", image: "img" },
      is_template: true,
    });

    const sessionId = "abcdef1234567890";
    const stageDef = { compute: "k8s-tmpl" } as any;

    const resolved = await app.dispatchService.resolveComputeForStage(stageDef, sessionId);
    expect(resolved).toBe("k8s-tmpl");

    // No per-session clone row exists -- materialization is at provision.
    expect(await app.computes.get("k8s-tmpl-abcdef12")).toBeNull();

    // Template row stays intact and remains a template.
    const tmpl = await app.computes.get("k8s-tmpl");
    expect(tmpl?.is_template).toBe(true);
  });

  it("returns concrete compute name as-is (no cloning)", async () => {
    await app.computeService.create({
      name: "shared-ec2",
      compute: "ec2",
      isolation: "direct",
      config: {},
    });
    const sessionId = "abcdef1234567890";
    const stageDef = { compute: "shared-ec2" } as any;
    const resolved = await app.dispatchService.resolveComputeForStage(stageDef, sessionId);
    expect(resolved).toBe("shared-ec2");

    expect(await app.computes.get("shared-ec2-abcdef12")).toBeNull();
  });

  it("legacy compute_template field resolves to the template name", async () => {
    await app.computeService.create({
      name: "legacy-tmpl",
      compute: "k8s",
      isolation: "direct",
      config: { context: "c", namespace: "ns", image: "img" },
      is_template: true,
    });
    const sessionId = "fedcba0987654321";
    const stageDef = { compute_template: "legacy-tmpl" } as any;

    const resolved = await app.dispatchService.resolveComputeForStage(stageDef, sessionId);
    expect(resolved).toBe("legacy-tmpl");
    expect(await app.computes.get("legacy-tmpl-fedcba09")).toBeNull();
  });

  it("returns null when the named row is not found", async () => {
    const stageDef = { compute: "does-not-exist" } as any;
    const resolved = await app.dispatchService.resolveComputeForStage(stageDef, "abcdef1234567890");
    expect(resolved).toBeNull();
  });

  it("a referenced template is never GC'd and spawns no clone to prune", async () => {
    await app.computeService.create({
      name: "k8s-tmpl2",
      compute: "k8s",
      isolation: "direct",
      config: { context: "c", namespace: "ns", image: "img" },
      is_template: true,
    });

    const sessionId = "1111222233334444";
    const resolved = await app.dispatchService.resolveComputeForStage({ compute: "k8s-tmpl2" } as any, sessionId);
    expect(resolved).toBe("k8s-tmpl2");

    // A session pointed at the template, driven terminal.
    const s = await app.sessions.create({
      repo: "/tmp",
      flow: "quick",
      task: "test",
      agent: "default",
      compute_name: "k8s-tmpl2",
    });
    await app.sessions.update(s.id, { status: "completed" });

    // GC must NOT delete a template (it is a reusable spec, not a clone).
    const gc = await garbageCollectComputeIfTemplate(depsFromApp(app), "k8s-tmpl2");
    expect(gc).toBe(false);
    const tmpl = await app.computes.get("k8s-tmpl2");
    expect(tmpl).not.toBeNull();
    expect(tmpl?.is_template).toBe(true);

    // No per-session clone row was ever created.
    expect(await app.computes.get("k8s-tmpl2-11112222")).toBeNull();
  });
});
