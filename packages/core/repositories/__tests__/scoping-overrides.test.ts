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

  it("set() records setBy on insert", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    const k = { scope_kind: "user" as const, scope_id: "u-1", key: "runtime", tenant_id: "t-1" };
    const row = await repo.set(k, "codex", "admin-u-rachna");
    expect(row.set_by).toBe("admin-u-rachna");
  });

  it("set() updates setBy on subsequent upsert", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    const k = { scope_kind: "user" as const, scope_id: "u-1", key: "runtime", tenant_id: "t-1" };
    await repo.set(k, "codex", "admin-1");
    const second = await repo.set(k, "claude-code", "admin-2");
    expect(second.set_by).toBe("admin-2");
  });

  it("delete() records deletedBy", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    const k = { scope_kind: "user" as const, scope_id: "u-1", key: "runtime", tenant_id: "t-1" };
    await repo.set(k, "codex");
    await repo.delete(k, "admin-deleter");
    const dRow = await repo.listForTenant("t-1", { includeDeleted: true });
    const tombstone = dRow.find((r) => r.scope_id === "u-1" && r.key === "runtime");
    expect(tombstone?.deleted_by).toBe("admin-deleter");
  });

  it("getById() returns tenant-scoped row only", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    const row = await repo.set({ scope_kind: "user", scope_id: "u-1", key: "runtime", tenant_id: "t-a" }, "codex");
    const fromA = await repo.getById(row.id, "t-a");
    expect(fromA?.id).toBe(row.id);
    const fromB = await repo.getById(row.id, "t-b");
    expect(fromB).toBeNull();
  });

  it("getById() returns tombstoned rows (audit drill-down contract)", async () => {
    // Deliberate asymmetry with get / getMany / listForTenant (which all
    // filter `deleted_at IS NULL`). The audit drill-down path -- CLI
    // `ark scoping get <id>`, dashboard's ScopingAuditDrawer -- needs to
    // surface tombstones so operators can inspect "(deleted)" rows after
    // soft-delete. The cross-tenant guard is still strict; the row's
    // deleted_at field carries the tombstone signal so callers can render
    // appropriately.
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    const k = { scope_kind: "user" as const, scope_id: "u-1", key: "runtime", tenant_id: "t-1" };
    const row = await repo.set(k, "codex");
    await repo.delete(k, "admin-deleter");

    const tombstone = await repo.getById(row.id, "t-1");
    expect(tombstone).not.toBeNull();
    expect(tombstone?.id).toBe(row.id);
    expect(tombstone?.deleted_at).not.toBeNull();
    expect(tombstone?.deleted_by).toBe("admin-deleter");

    // Cross-tenant guard still applies to tombstones.
    expect(await repo.getById(row.id, "t-OTHER")).toBeNull();
  });

  it("listForTenant() filters out other tenants regardless of filters", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    await repo.set({ scope_kind: "user", scope_id: "u-1", key: "runtime", tenant_id: "t-a" }, "codex");
    await repo.set({ scope_kind: "user", scope_id: "u-1", key: "runtime", tenant_id: "t-b" }, "claude-code");
    const rows = await repo.listForTenant("t-a");
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe("t-a");
  });

  it("listForTenant() honors scope_kind / scope_id / key filters", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    await repo.set({ scope_kind: "user", scope_id: "u-1", key: "runtime", tenant_id: "t-1" }, "codex");
    await repo.set({ scope_kind: "team", scope_id: "team-eng", key: "runtime", tenant_id: "t-1" }, "claude-code");
    await repo.set({ scope_kind: "tenant", scope_id: "t-1", key: "model", tenant_id: "t-1" }, "opus");

    expect(await repo.listForTenant("t-1", { scope_kind: "user" })).toHaveLength(1);
    expect(await repo.listForTenant("t-1", { key: "runtime" })).toHaveLength(2);
    expect(await repo.listForTenant("t-1", { scope_kind: "team", key: "runtime" })).toHaveLength(1);
  });

  it("listForTenant() includes tombstones only when includeDeleted=true", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    const k = { scope_kind: "user" as const, scope_id: "u-1", key: "runtime", tenant_id: "t-1" };
    await repo.set(k, "codex");
    await repo.delete(k);

    expect(await repo.listForTenant("t-1")).toHaveLength(0);
    expect(await repo.listForTenant("t-1", { includeDeleted: true })).toHaveLength(1);
  });

  it("set() is concurrent-safe: parallel calls produce one live row", async () => {
    // M1: the partial unique index on (scope_kind, scope_id, key, tenant_id)
    // WHERE deleted_at IS NULL means two concurrent inserts race -- the
    // second hits a UNIQUE violation. The repo must catch + retry-as-update
    // instead of leaking SQLITE_CONSTRAINT_UNIQUE to the caller.
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    const k = { scope_kind: "user" as const, scope_id: "u-race", key: "runtime", tenant_id: "t-1" };

    const settled = await Promise.allSettled([
      repo.set(k, "codex", "actor-A"),
      repo.set(k, "claude-code", "actor-B"),
      repo.set(k, "gemini", "actor-C"),
    ]);
    for (const r of settled) {
      expect(r.status).toBe("fulfilled");
    }
    const live = await repo.listForTenant("t-1");
    const matching = live.filter((r) => r.scope_id === "u-race" && r.key === "runtime");
    expect(matching).toHaveLength(1);
  });

  it("deleteById() is tenant-scoped + idempotent on re-delete", async () => {
    const db = await freshDb();
    const repo = new ScopingOverrideRepository(db);
    const row = await repo.set({ scope_kind: "user", scope_id: "u-1", key: "runtime", tenant_id: "t-a" }, "codex");

    // Wrong-tenant attempt: no-op.
    expect(await repo.deleteById(row.id, "t-b", "attacker")).toBe(false);
    // Correct tenant: deletes.
    expect(await repo.deleteById(row.id, "t-a", "admin-deleter")).toBe(true);
    // Re-delete: no live row left.
    expect(await repo.deleteById(row.id, "t-a", "admin-deleter")).toBe(false);

    // Row still has correct deleted_by recorded.
    const fetched = await repo.getById(row.id, "t-a");
    expect(fetched?.deleted_by).toBe("admin-deleter");
  });
});
