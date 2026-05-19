import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AppContext } from "../../core/app.js";
import {
  attachTemporalTestHarness,
  drainTemporalTestHarness,
  waitForSessionStatus,
} from "../../core/temporal/test-harness.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { registerResourceHandlers } from "../handlers/resource.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse } from "../../protocol/types.js";

let app: AppContext;
let detach: (() => void) | undefined;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  const flowDir = join(app.config.dirs.ark, "flows");
  mkdirSync(flowDir, { recursive: true });
  writeFileSync(
    join(flowDir, "x-auto.yaml"),
    `name: x-auto\nstages:\n  - name: work\n    agent: implementer\n    gate: auto\n`,
  );
  await app.boot();
  detach = await attachTemporalTestHarness(app);
});
afterEach(async () => {
  await drainTemporalTestHarness();
});
afterAll(async () => {
  detach?.();
  await app?.shutdown();
});

function sessionId(res: unknown): string {
  return ((res as JsonRpcResponse).result as { session?: { id?: string } })?.session?.id ?? "";
}
async function drive(res: unknown): Promise<void> {
  const id = sessionId(res);
  if (id) await waitForSessionStatus(app, id, ["completed", "failed"]);
}

let router: Router;

beforeEach(() => {
  router = new Router();
  registerSessionHandlers(router, app);
  registerResourceHandlers(router, app);
});

function ok(res: unknown): Record<string, unknown> {
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

// ── Session list ────────────────────────────────────────────────────────────

describe("session/list", async () => {
  it("returns an array of sessions", async () => {
    const a = await router.dispatch(
      createRequest(1, "session/start", { summary: "list-a", repo: ".", flow: "x-auto" }),
    );
    const b = await router.dispatch(
      createRequest(2, "session/start", { summary: "list-b", repo: ".", flow: "x-auto" }),
    );
    const res = ok(await router.dispatch(createRequest(3, "session/list", {})));
    const sessions = res.sessions as Array<{ summary: string }>;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.some((s) => s.summary === "list-a")).toBe(true);
    expect(sessions.some((s) => s.summary === "list-b")).toBe(true);
    await drive(a);
    await drive(b);
  }, 45_000);

  it("filters by status", async () => {
    const a = await router.dispatch(
      createRequest(1, "session/start", { summary: "status-filter", repo: ".", flow: "x-auto" }),
    );
    const res = ok(await router.dispatch(createRequest(2, "session/list", { status: "pending" })));
    const sessions = res.sessions as Array<{ status: string }>;
    for (const s of sessions) {
      expect(s.status).toBe("pending");
    }
    await drive(a);
  }, 45_000);

  it("filters by repo", async () => {
    const a = await router.dispatch(
      createRequest(1, "session/start", { summary: "repo-filter", repo: "/tmp/test-repo", flow: "x-auto" }),
    );
    const res = ok(await router.dispatch(createRequest(2, "session/list", { repo: "/tmp/test-repo" })));
    const sessions = res.sessions as Array<{ repo: string }>;
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    for (const s of sessions) {
      expect(s.repo).toBe("/tmp/test-repo");
    }
    await drive(a);
  }, 45_000);

  it("filters by flow", async () => {
    const a = await router.dispatch(
      createRequest(1, "session/start", { summary: "flow-filter", repo: ".", flow: "x-auto" }),
    );
    const res = ok(await router.dispatch(createRequest(2, "session/list", { flow: "x-auto" })));
    const sessions = res.sessions as Array<{ flow: string }>;
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    for (const s of sessions) {
      expect(s.flow).toBe("x-auto");
    }
    await drive(a);
  }, 45_000);

  it("respects limit", async () => {
    const a = await router.dispatch(createRequest(1, "session/start", { summary: "lim-1", repo: ".", flow: "x-auto" }));
    const b = await router.dispatch(createRequest(2, "session/start", { summary: "lim-2", repo: ".", flow: "x-auto" }));
    const res = ok(await router.dispatch(createRequest(3, "session/list", { limit: 1 })));
    const sessions = res.sessions as unknown[];
    expect(sessions.length).toBe(1);
    await drive(a);
    await drive(b);
  }, 45_000);

  it("returns empty array when no sessions match filter", async () => {
    const res = ok(await router.dispatch(createRequest(1, "session/list", { repo: "/nonexistent/repo/xyz" })));
    const sessions = res.sessions as unknown[];
    expect(sessions).toEqual([]);
  });
});

// ── Resource list handlers ──────────────────────────────────────────────────

describe("agent/list", async () => {
  it("returns builtin agents", async () => {
    const res = ok(await router.dispatch(createRequest(1, "agent/list", {})));
    const agents = res.agents as Array<{ name: string; _source: string }>;
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.some((a) => a._source === "builtin")).toBe(true);
  });

  it("each agent has required fields", async () => {
    const res = ok(await router.dispatch(createRequest(1, "agent/list", {})));
    const agents = res.agents as Array<Record<string, unknown>>;
    for (const a of agents) {
      expect(a.name).toBeDefined();
      expect(a.model).toBeDefined();
      expect(Array.isArray(a.tools)).toBe(true);
    }
  });
});

describe("flow/list", async () => {
  it("returns builtin flows", async () => {
    const res = ok(await router.dispatch(createRequest(1, "flow/list", {})));
    const flows = res.flows as Array<{ name: string }>;
    expect(flows.length).toBeGreaterThan(0);
  });

  it("each flow has name and stages", async () => {
    const res = ok(await router.dispatch(createRequest(1, "flow/list", {})));
    const flows = res.flows as Array<Record<string, unknown>>;
    for (const f of flows) {
      expect(f.name).toBeDefined();
      expect(f.stages).toBeDefined();
    }
  });

  it("filters flows by tenant-level flow.allowlist override (Phase 1)", async () => {
    // No override -> all flows visible.
    const before = ok(await router.dispatch(createRequest(1, "flow/list", {}))).flows as Array<{ name: string }>;
    expect(before.length).toBeGreaterThan(1);
    const allow = before.slice(0, 1).map((f) => f.name);

    // Tenant-level override scoped to the local-admin caller's tenant ("default").
    await app.scopingOverrides.set(
      { scope_kind: "tenant", scope_id: "default", key: "flow.allowlist", tenant_id: "default" },
      allow,
    );
    try {
      const after = ok(await router.dispatch(createRequest(2, "flow/list", {}))).flows as Array<{ name: string }>;
      const names = after.map((f) => f.name);
      expect(names).toEqual(allow);
    } finally {
      await app.scopingOverrides.delete({
        scope_kind: "tenant",
        scope_id: "default",
        key: "flow.allowlist",
        tenant_id: "default",
      });
    }
  });
});

describe("session/start runtime scoping override (Phase 1)", () => {
  const tenantOverrideKey = {
    scope_kind: "tenant" as const,
    scope_id: "default",
    key: "runtime",
    tenant_id: "default",
  };

  it("no override -> session created without scoping_runtime_hint", async () => {
    const res = (await router.dispatch(
      createRequest(1, "session/start", { summary: "rt-no-override", repo: ".", flow: "x-auto" }),
    )) as JsonRpcResponse;
    const session = (res.result as { session: { id: string; config: Record<string, unknown> } }).session;
    expect(session.config?.scoping_runtime_hint).toBeUndefined();
    await drive(res);
  }, 45_000);

  it("override naming a known runtime -> session.config.scoping_runtime_hint is set", async () => {
    const knownRuntime = (await app.runtimes.list()).find((r) => r.name)?.name;
    if (!knownRuntime) throw new Error("test setup: at least one runtime must exist");
    await app.scopingOverrides.set(tenantOverrideKey, knownRuntime);
    try {
      const res = (await router.dispatch(
        createRequest(1, "session/start", { summary: "rt-known-override", repo: ".", flow: "x-auto" }),
      )) as JsonRpcResponse;
      const session = (res.result as { session: { config: Record<string, unknown> } }).session;
      expect(session.config?.scoping_runtime_hint).toBe(knownRuntime);
      await drive(res);
    } finally {
      await app.scopingOverrides.delete(tenantOverrideKey);
    }
  }, 45_000);

  it("override naming an UNKNOWN runtime -> session/start fails with INVALID_PARAMS", async () => {
    await app.scopingOverrides.set(tenantOverrideKey, "ghost-runtime-xyz");
    try {
      const res = (await router.dispatch(
        createRequest(1, "session/start", { summary: "rt-bad-override", repo: ".", flow: "x-auto" }),
      )) as { error?: { code: number; message: string } };
      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32602); // ErrorCodes.INVALID_PARAMS
      expect(res.error?.message).toContain("ghost-runtime-xyz");
      expect(res.error?.message).toContain("not a registered runtime");
    } finally {
      await app.scopingOverrides.delete(tenantOverrideKey);
    }
  });

  it("explicit caller-provided opts.runtime wins -- override is not validated, no hint stashed", async () => {
    // A bad tenant override should NOT block a caller who explicitly
    // chose their runtime via opts.runtime. The explicit caller intent
    // takes precedence; the resolver does not run.
    await app.scopingOverrides.set(tenantOverrideKey, "ghost-runtime-xyz");
    try {
      const knownRuntime = (await app.runtimes.list()).find((r) => r.name)?.name;
      const res = (await router.dispatch(
        createRequest(1, "session/start", {
          summary: "rt-explicit-wins",
          repo: ".",
          flow: "x-auto",
          runtime: knownRuntime,
        }),
      )) as JsonRpcResponse;
      const session = (res.result as { session: { config: Record<string, unknown> } }).session;
      expect(session.config?.scoping_runtime_hint).toBeUndefined();
      await drive(res);
    } finally {
      await app.scopingOverrides.delete(tenantOverrideKey);
    }
  }, 45_000);
});

describe("session/start model scoping override (Phase 1)", () => {
  const tenantOverrideKey = {
    scope_kind: "tenant" as const,
    scope_id: "default",
    key: "model",
    tenant_id: "default",
  };

  it("no override -> session created without scoping_model_hint", async () => {
    const res = (await router.dispatch(
      createRequest(1, "session/start", { summary: "model-no-override", repo: ".", flow: "x-auto" }),
    )) as JsonRpcResponse;
    const session = (res.result as { session: { config: Record<string, unknown> } }).session;
    expect(session.config?.scoping_model_hint).toBeUndefined();
    await drive(res);
  }, 45_000);

  it("override naming a known model -> session.config.scoping_model_hint is set", async () => {
    const knownModel = (await app.models.list()).find((m) => m.id)?.id;
    if (!knownModel) throw new Error("test setup: at least one model must exist in the catalog");
    await app.scopingOverrides.set(tenantOverrideKey, knownModel);
    try {
      const res = (await router.dispatch(
        createRequest(1, "session/start", { summary: "model-known-override", repo: ".", flow: "x-auto" }),
      )) as JsonRpcResponse;
      const session = (res.result as { session: { config: Record<string, unknown> } }).session;
      expect(session.config?.scoping_model_hint).toBe(knownModel);
      await drive(res);
    } finally {
      await app.scopingOverrides.delete(tenantOverrideKey);
    }
  }, 45_000);

  it("override naming an UNKNOWN model -> session/start fails with INVALID_PARAMS", async () => {
    await app.scopingOverrides.set(tenantOverrideKey, "ghost-model-xyz");
    try {
      const res = (await router.dispatch(
        createRequest(1, "session/start", { summary: "model-bad-override", repo: ".", flow: "x-auto" }),
      )) as { error?: { code: number; message: string } };
      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32602); // INVALID_PARAMS
      expect(res.error?.message).toContain("ghost-model-xyz");
      expect(res.error?.message).toContain("not a registered model");
    } finally {
      await app.scopingOverrides.delete(tenantOverrideKey);
    }
  });

  it("alias override (e.g. 'sonnet') is accepted by the catalog", async () => {
    // Aliases are a first-class lookup path on ModelStore.get(); they
    // should validate exactly the same as concrete model ids.
    const aliasModel = (await app.models.list()).find((m) => Array.isArray(m.aliases) && m.aliases.length > 0);
    if (!aliasModel || !aliasModel.aliases) {
      throw new Error("test setup: catalog must have at least one model with aliases");
    }
    const alias = aliasModel.aliases[0];
    await app.scopingOverrides.set(tenantOverrideKey, alias);
    try {
      const res = (await router.dispatch(
        createRequest(1, "session/start", { summary: "model-alias-override", repo: ".", flow: "x-auto" }),
      )) as JsonRpcResponse;
      const session = (res.result as { session: { config: Record<string, unknown> } }).session;
      expect(session.config?.scoping_model_hint).toBe(alias);
      await drive(res);
    } finally {
      await app.scopingOverrides.delete(tenantOverrideKey);
    }
  }, 45_000);
});

describe("session/start compute.default scoping override (Phase 1)", () => {
  const tenantOverrideKey = {
    scope_kind: "tenant" as const,
    scope_id: "default",
    key: "compute.default",
    tenant_id: "default",
  };

  it("no override -> session created with caller-supplied or default compute", async () => {
    const res = (await router.dispatch(
      createRequest(1, "session/start", { summary: "compute-no-override", repo: ".", flow: "x-auto" }),
    )) as JsonRpcResponse;
    const session = (res.result as { session: { compute_name: string | null } }).session;
    // No override and no caller-explicit compute -> falls through to
    // SessionCreator's existing default ("local").
    expect(session.compute_name).toBe("local");
    await drive(res);
  }, 45_000);

  it("override naming a known compute -> session.compute_name is set from the resolver", async () => {
    // Pick any compute that exists in the test tenant ("local" is the
    // auto-seeded one).
    const known = (await app.computes.list()).find((c) => c.name)?.name;
    if (!known) throw new Error("test setup: at least one compute must exist");
    await app.scopingOverrides.set(tenantOverrideKey, known);
    try {
      const res = (await router.dispatch(
        createRequest(1, "session/start", { summary: "compute-known-override", repo: ".", flow: "x-auto" }),
      )) as JsonRpcResponse;
      const session = (res.result as { session: { compute_name: string } }).session;
      expect(session.compute_name).toBe(known);
      await drive(res);
    } finally {
      await app.scopingOverrides.delete(tenantOverrideKey);
    }
  }, 45_000);

  it("override naming an UNKNOWN compute -> session/start fails with INVALID_PARAMS", async () => {
    await app.scopingOverrides.set(tenantOverrideKey, "ghost-compute-xyz");
    try {
      const res = (await router.dispatch(
        createRequest(1, "session/start", { summary: "compute-bad-override", repo: ".", flow: "x-auto" }),
      )) as { error?: { code: number; message: string } };
      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32602); // INVALID_PARAMS
      expect(res.error?.message).toContain("ghost-compute-xyz");
      expect(res.error?.message).toContain("not a registered compute target");
    } finally {
      await app.scopingOverrides.delete(tenantOverrideKey);
    }
  });

  it("explicit caller-provided opts.compute_name wins -- override is not validated, hint not applied", async () => {
    // A bad tenant override should NOT block a caller who explicitly
    // chose their compute. Same caller-explicit short-circuit pattern
    // as runtime.
    await app.scopingOverrides.set(tenantOverrideKey, "ghost-compute-xyz");
    try {
      const res = (await router.dispatch(
        createRequest(1, "session/start", {
          summary: "compute-explicit-wins",
          repo: ".",
          flow: "x-auto",
          compute_name: "local",
        }),
      )) as JsonRpcResponse;
      const session = (res.result as { session: { compute_name: string } }).session;
      expect(session.compute_name).toBe("local");
      await drive(res);
    } finally {
      await app.scopingOverrides.delete(tenantOverrideKey);
    }
  }, 45_000);
});

describe("skill/list", async () => {
  it("returns builtin skills", async () => {
    const res = ok(await router.dispatch(createRequest(1, "skill/list", {})));
    const skills = res.skills as Array<{ name: string }>;
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some((s) => s.name === "code-review")).toBe(true);
  });
});

describe("runtime/list", async () => {
  it("returns available runtimes", async () => {
    const res = ok(await router.dispatch(createRequest(1, "runtime/list", {})));
    const runtimes = res.runtimes as Array<{ name: string; type: string }>;
    expect(runtimes.length).toBeGreaterThan(0);
  });

  it("each runtime has name and type", async () => {
    const res = ok(await router.dispatch(createRequest(1, "runtime/list", {})));
    const runtimes = res.runtimes as Array<Record<string, unknown>>;
    for (const r of runtimes) {
      expect(r.name).toBeDefined();
      expect(r.type).toBeDefined();
    }
  });
});

describe("compute/list", async () => {
  it("returns compute targets", async () => {
    const res = ok(await router.dispatch(createRequest(1, "compute/list", {})));
    const targets = res.targets as unknown[];
    expect(Array.isArray(targets)).toBe(true);
  });

  it("includes the auto-created local compute", async () => {
    const res = ok(await router.dispatch(createRequest(1, "compute/list", {})));
    const targets = res.targets as Array<{ name: string; provider: string }>;
    expect(targets.some((t) => t.provider === "local")).toBe(true);
  });
});

describe("compute/kinds", async () => {
  it("returns compute kind names", async () => {
    const res = ok(await router.dispatch(createRequest(1, "compute/kinds", {})));
    const kinds = res.kinds as string[];
    expect(Array.isArray(kinds)).toBe(true);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toContain("local");
  });
});

describe("runtime/kinds", async () => {
  it("returns runtime kind names", async () => {
    const res = ok(await router.dispatch(createRequest(1, "runtime/kinds", {})));
    const kinds = res.kinds as string[];
    expect(Array.isArray(kinds)).toBe(true);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toContain("direct");
  });
});

describe("group/list", async () => {
  it("returns session groups", async () => {
    const res = ok(await router.dispatch(createRequest(1, "group/list", {})));
    const groups = res.groups as unknown[];
    expect(Array.isArray(groups)).toBe(true);
  });

  it("includes a created group", async () => {
    await router.dispatch(createRequest(1, "group/create", { name: "test-list-group" }));
    const res = ok(await router.dispatch(createRequest(2, "group/list", {})));
    const groups = res.groups as Array<{ name: string }>;
    expect(groups.some((g) => g.name === "test-list-group")).toBe(true);
    await router.dispatch(createRequest(3, "group/delete", { name: "test-list-group" }));
  });
});
