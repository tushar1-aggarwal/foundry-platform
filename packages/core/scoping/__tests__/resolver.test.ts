/**
 * ScopingResolver tests -- override resolution against a real
 * scoping_overrides repo backed by an in-memory SQLite.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database/index.js";
import { MigrationRunner } from "../../migrations/runner.js";
import { ScopingOverrideRepository } from "../../repositories/scoping-overrides.js";
import { ScopingResolver } from "../resolver.js";
import type { TenantContext } from "../../../types/index.js";

async function freshRepo(): Promise<{ db: DatabaseAdapter; repo: ScopingOverrideRepository }> {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  await new MigrationRunner(db, "sqlite").apply();
  return { db, repo: new ScopingOverrideRepository(db) };
}

function ctx(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: "t-1",
    userId: "u-1",
    role: "member",
    scopingUserId: "u-1",
    teamChain: [],
    ...overrides,
  };
}

describe("ScopingResolver", () => {
  it("returns null when no override exists at any level", async () => {
    const { repo } = await freshRepo();
    const resolver = new ScopingResolver(repo);
    const value = await resolver.resolve<string[]>(ctx({ teamChain: ["team-1"] }), "flow.allowlist");
    expect(value).toBeNull();
  });

  it("user-level override wins over team and tenant", async () => {
    const { repo } = await freshRepo();
    const resolver = new ScopingResolver(repo);

    await repo.set({ scope_kind: "tenant", scope_id: "t-1", key: "flow.allowlist", tenant_id: "t-1" }, ["tenant-flow"]);
    await repo.set({ scope_kind: "team", scope_id: "team-1", key: "flow.allowlist", tenant_id: "t-1" }, ["team-flow"]);
    await repo.set({ scope_kind: "user", scope_id: "u-1", key: "flow.allowlist", tenant_id: "t-1" }, ["user-flow"]);

    const value = await resolver.resolve<string[]>(ctx({ teamChain: ["team-1"] }), "flow.allowlist");
    expect(value).toEqual(["user-flow"]);
  });

  it("team-level override wins over tenant when no user override exists", async () => {
    const { repo } = await freshRepo();
    const resolver = new ScopingResolver(repo);

    await repo.set({ scope_kind: "tenant", scope_id: "t-1", key: "flow.allowlist", tenant_id: "t-1" }, ["tenant-flow"]);
    await repo.set({ scope_kind: "team", scope_id: "team-1", key: "flow.allowlist", tenant_id: "t-1" }, ["team-flow"]);

    const value = await resolver.resolve<string[]>(ctx({ teamChain: ["team-1"] }), "flow.allowlist");
    expect(value).toEqual(["team-flow"]);
  });

  it("immediate team beats parent team within the chain", async () => {
    const { repo } = await freshRepo();
    const resolver = new ScopingResolver(repo);

    await repo.set({ scope_kind: "team", scope_id: "parent", key: "compute.default", tenant_id: "t-1" }, "parent-pool");
    await repo.set({ scope_kind: "team", scope_id: "team-1", key: "compute.default", tenant_id: "t-1" }, "team-pool");

    const value = await resolver.resolve<string>(ctx({ teamChain: ["team-1", "parent"] }), "compute.default");
    expect(value).toBe("team-pool");
  });

  it("falls through to tenant-level when no user/team override matches", async () => {
    const { repo } = await freshRepo();
    const resolver = new ScopingResolver(repo);

    // Sample key + complex JSON value -- this test exercises the
    // resolver's chain walk + JSON.parse, not any specific consumer.
    await repo.set(
      { scope_kind: "tenant", scope_id: "t-1", key: "example.setting", tenant_id: "t-1" },
      { mode: "auto" },
    );

    const value = await resolver.resolve<{ mode: string }>(ctx({ teamChain: ["team-1"] }), "example.setting");
    expect(value).toEqual({ mode: "auto" });
  });

  it("ignores soft-deleted overrides", async () => {
    const { repo } = await freshRepo();
    const resolver = new ScopingResolver(repo);
    const k = { scope_kind: "user" as const, scope_id: "u-1", key: "flow.allowlist", tenant_id: "t-1" };

    await repo.set(k, ["tombstoned"]);
    await repo.delete(k);

    const value = await resolver.resolve<string[]>(ctx(), "flow.allowlist");
    expect(value).toBeNull();
  });

  it("skips the user level when scopingUserId is null", async () => {
    const { repo } = await freshRepo();
    const resolver = new ScopingResolver(repo);

    // A row that would match if user-level was queried -- but ctx.scopingUserId
    // is null (admin-minted api key path), so the resolver should skip past it
    // and match nothing at team/tenant.
    await repo.set({ scope_kind: "user", scope_id: "u-1", key: "flow.allowlist", tenant_id: "t-1" }, ["should-skip"]);

    const value = await resolver.resolve<string[]>(ctx({ userId: "ak-admin", scopingUserId: null }), "flow.allowlist");
    expect(value).toBeNull();
  });

  it("uses scopingUserId (not userId) for the user-level query", async () => {
    const { repo } = await freshRepo();
    const resolver = new ScopingResolver(repo);

    // Self-service api-key scenario: userId is the ak-... sentinel, but the
    // override is keyed against the real owner's users.id.
    await repo.set({ scope_kind: "user", scope_id: "owner-real-id", key: "flow.allowlist", tenant_id: "t-1" }, [
      "owner-pref",
    ]);

    const value = await resolver.resolve<string[]>(
      ctx({ userId: "ak-c0565083", scopingUserId: "owner-real-id" }),
      "flow.allowlist",
    );
    expect(value).toEqual(["owner-pref"]);
  });

  it("does not return overrides from a different tenant even when scope_id collides", async () => {
    const { repo } = await freshRepo();
    const resolver = new ScopingResolver(repo);

    await repo.set({ scope_kind: "user", scope_id: "u-shared", key: "flow.allowlist", tenant_id: "t-OTHER" }, [
      "leaked",
    ]);

    const value = await resolver.resolve<string[]>(
      ctx({ tenantId: "t-1", scopingUserId: "u-shared", teamChain: [] }),
      "flow.allowlist",
    );
    expect(value).toBeNull();
  });

  it("complex JSON values round-trip via the resolver", async () => {
    const { repo } = await freshRepo();
    const resolver = new ScopingResolver(repo);
    const value = { provider: "k8s", weights: { gpu: 0.5, cpu: 0.5 }, tags: ["us-west"] };

    await repo.set({ scope_kind: "tenant", scope_id: "t-1", key: "compute.default", tenant_id: "t-1" }, value);

    const got = await resolver.resolve<typeof value>(ctx(), "compute.default");
    expect(got).toEqual(value);
  });
});
