/**
 * Tests for migration 020 -- compute PK swap from (name) to (name, tenant_id).
 *
 * Covers:
 *   - Fresh installs already land on the composite PK.
 *   - Existing rows are preserved through the SQLite rebuild dance.
 *   - Indexes are recreated on the new table.
 *   - Two tenants can hold rows with the same compute name post-migration.
 *   - Re-running the migration on a post-migration DB is a no-op.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database/types.js";
import { MigrationRunner } from "../runner.js";

async function freshDb(): Promise<DatabaseAdapter> {
  const raw = new Database(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  return new BunSqliteAdapter(raw);
}

async function tableCreateSql(db: DatabaseAdapter, table: string): Promise<string> {
  const row = (await db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(table)) as { sql: string | null } | undefined;
  return row?.sql ?? "";
}

async function indexExists(db: DatabaseAdapter, name: string): Promise<boolean> {
  const row = (await db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1`)
    .get(name)) as { present: number } | undefined;
  return !!row;
}

describe("Migration 018 -- compute composite PK", () => {
  it("fresh install ends with PRIMARY KEY (name, tenant_id)", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    const sql = await tableCreateSql(db, "compute");
    expect(sql).toMatch(/PRIMARY KEY\s*\(\s*"?name"?\s*,\s*"?tenant_id"?\s*\)/i);

    await db.close();
  });

  it("preserves existing rows through the rebuild dance", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply({ targetVersion: 19 });

    const ts = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO compute (name, compute_kind, isolation_kind, status, config, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("alpha", "local", "direct", "running", "{}", "default", ts, ts);
    await db
      .prepare(
        `INSERT INTO compute (name, compute_kind, isolation_kind, status, config, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("beta", "ec2", "direct", "stopped", '{"region":"us-east-1"}', "default", ts, ts);

    await new MigrationRunner(db, "sqlite").apply();

    const rows = (await db
      .prepare("SELECT name, compute_kind, isolation_kind, status, config, tenant_id FROM compute ORDER BY name")
      .all()) as Array<{
      name: string;
      compute_kind: string;
      isolation_kind: string;
      status: string;
      config: string;
      tenant_id: string;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.name === "alpha")).toMatchObject({
      compute_kind: "local",
      status: "running",
      tenant_id: "default",
    });
    expect(rows.find((r) => r.name === "beta")).toMatchObject({
      compute_kind: "ec2",
      isolation_kind: "direct",
      status: "stopped",
      config: '{"region":"us-east-1"}',
      tenant_id: "default",
    });

    await db.close();
  });

  it("recreates indexes after the rebuild", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    expect(await indexExists(db, "idx_compute_kind")).toBe(true);
    expect(await indexExists(db, "idx_compute_isolation_kind")).toBe(true);
    expect(await indexExists(db, "idx_compute_status")).toBe(true);
    expect(await indexExists(db, "idx_compute_tenant")).toBe(true);

    await db.close();
  });

  it("allows two tenants to hold the same compute name", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    const ts = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO compute (name, compute_kind, isolation_kind, status, config, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("local", "local", "direct", "running", "{}", "tenant-a", ts, ts);
    await db
      .prepare(
        `INSERT INTO compute (name, compute_kind, isolation_kind, status, config, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("local", "local", "direct", "running", "{}", "tenant-b", ts, ts);

    const rows = (await db
      .prepare("SELECT tenant_id FROM compute WHERE name = 'local' ORDER BY tenant_id")
      .all()) as Array<{ tenant_id: string }>;

    expect(rows.map((r) => r.tenant_id)).toEqual(["tenant-a", "tenant-b"]);

    await db.close();
  });

  it("re-running migration 018 on a post-migration DB is a no-op", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    const before = await tableCreateSql(db, "compute");
    const ts = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO compute (name, compute_kind, isolation_kind, status, config, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("survivor", "local", "direct", "running", "{}", "default", ts, ts);

    const { applySqliteComputeCompositePk } = await import("../020_compute_composite_pk_sqlite.js");
    await applySqliteComputeCompositePk(db);

    const after = await tableCreateSql(db, "compute");
    expect(after).toBe(before);

    const survivor = (await db.prepare(`SELECT name, tenant_id FROM compute WHERE name = 'survivor'`).get()) as
      | { name: string; tenant_id: string }
      | undefined;
    expect(survivor).toMatchObject({ name: "survivor", tenant_id: "default" });

    await db.close();
  });
});
