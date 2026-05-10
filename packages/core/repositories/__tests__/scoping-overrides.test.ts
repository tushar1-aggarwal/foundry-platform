/**
 * ScopingOverrideRepository tests.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database/index.js";
import { MigrationRunner } from "../../migrations/runner.js";
import { ScopingOverrideRepository } from "../scoping-overrides.js";

async function freshDb(): Promise<DatabaseAdapter> {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  await new MigrationRunner(db, "sqlite").apply();
  return db;
}

describe("ScopingOverrideRepository", () => {
  it("set() inserts a new row; get() returns it", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);

    const row = await repo.set({ scope_kind: "user", scope_id: "u-1", key: "flow.allowlist", tenant_id: "t-1" }, [
      "docs",
      "fix-bug",
    ]);
    expect(row.scope_kind).toBe("user");
    expect(row.scope_id).toBe("u-1");
    expect(row.tenant_id).toBe("t-1");
    expect(JSON.parse(row.value_json)).toEqual(["docs", "fix-bug"]);

    const fetched = await repo.get({
      scope_kind: "user",
      scope_id: "u-1",
      key: "flow.allowlist",
      tenant_id: "t-1",
    });
    expect(fetched).not.toBeNull();
    expect(JSON.parse(fetched!.value_json)).toEqual(["docs", "fix-bug"]);
  });

  it("set() updates the value_json of an existing live row in place", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    const k = { scope_kind: "team" as const, scope_id: "team-1", key: "compute.default", tenant_id: "t-1" };

    const first = await repo.set(k, "k8s-pool-a");
    const second = await repo.set(k, "k8s-pool-b");
    expect(second.id).toBe(first.id);
    expect(JSON.parse(second.value_json)).toBe("k8s-pool-b");
  });

  it("get() does not return rows from a different tenant even when scope_id collides", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);

    await repo.set({ scope_kind: "user", scope_id: "shared-id", key: "flow.allowlist", tenant_id: "t-A" }, ["a-only"]);
    await repo.set({ scope_kind: "user", scope_id: "shared-id", key: "flow.allowlist", tenant_id: "t-B" }, ["b-only"]);

    const fromA = await repo.get({
      scope_kind: "user",
      scope_id: "shared-id",
      key: "flow.allowlist",
      tenant_id: "t-A",
    });
    const fromB = await repo.get({
      scope_kind: "user",
      scope_id: "shared-id",
      key: "flow.allowlist",
      tenant_id: "t-B",
    });
    expect(JSON.parse(fromA!.value_json)).toEqual(["a-only"]);
    expect(JSON.parse(fromB!.value_json)).toEqual(["b-only"]);
  });

  it("delete() soft-deletes; get() returns null afterwards", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    // Sample key + complex JSON value -- exercises soft-delete on a
    // non-string value type.
    const k = { scope_kind: "tenant" as const, scope_id: "t-1", key: "example.setting", tenant_id: "t-1" };

    await repo.set(k, { mode: "auto" });
    expect(await repo.get(k)).not.toBeNull();

    const deleted = await repo.delete(k);
    expect(deleted).toBe(true);
    expect(await repo.get(k)).toBeNull();

    const idempotent = await repo.delete(k);
    expect(idempotent).toBe(false);
  });

  it("set() after delete() inserts a fresh row, leaving the tombstone in place", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    const k = { scope_kind: "user" as const, scope_id: "u-1", key: "flow.allowlist", tenant_id: "t-1" };

    const a = await repo.set(k, ["v1"]);
    await repo.delete(k);
    const b = await repo.set(k, ["v2"]);

    expect(b.id).not.toBe(a.id);
    expect(JSON.parse(b.value_json)).toEqual(["v2"]);
  });

  it("getMany() batch-fetches across scope_ids, scoped by tenant", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);

    await repo.set({ scope_kind: "team", scope_id: "team-1", key: "flow.allowlist", tenant_id: "t-1" }, ["x"]);
    await repo.set({ scope_kind: "team", scope_id: "team-2", key: "flow.allowlist", tenant_id: "t-1" }, ["y"]);
    await repo.set({ scope_kind: "team", scope_id: "team-3", key: "flow.allowlist", tenant_id: "t-OTHER" }, ["z"]);

    const rows = await repo.getMany({
      scope_kind: "team",
      scope_ids: ["team-1", "team-2", "team-3"],
      key: "flow.allowlist",
      tenant_id: "t-1",
    });
    const ids = rows.map((r) => r.scope_id).sort();
    expect(ids).toEqual(["team-1", "team-2"]);
  });

  it("complex object value round-trips through value_json", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    const k = { scope_kind: "tenant" as const, scope_id: "t-1", key: "compute.default", tenant_id: "t-1" };
    const value = { provider: "k8s", pool: "pool-a", weights: { gpu: 0.5, cpu: 0.5 }, tags: ["dev", "us-west"] };

    await repo.set(k, value);
    const row = await repo.get(k);
    expect(JSON.parse(row!.value_json)).toEqual(value);
  });
});
