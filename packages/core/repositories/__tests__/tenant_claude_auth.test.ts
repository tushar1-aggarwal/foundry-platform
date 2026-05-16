/**
 * Tests for TenantClaudeAuthRepository -- per-tenant Claude credential
 * binding (api_key | subscription_blob).
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database/index.js";
import { MigrationRunner } from "../../migrations/runner.js";
import { TenantClaudeAuthRepository } from "../tenant_claude_auth.js";

async function freshDb(): Promise<DatabaseAdapter> {
  const raw = new Database(":memory:");
  raw.run("PRAGMA foreign_keys = ON");
  const db = new BunSqliteAdapter(raw);
  await new MigrationRunner(db, "sqlite").apply();
  return db;
}

describe("TenantClaudeAuthRepository", () => {
  it("set with api_key persists and get returns the row", async () => {
    const db = await freshDb();
    const r = new TenantClaudeAuthRepository(db);
    const row = await r.set("tenant-a", "api_key", "ANTHROPIC_API_KEY");
    expect(row.tenant_id).toBe("tenant-a");
    expect(row.kind).toBe("api_key");
    expect(row.secret_ref).toBe("ANTHROPIC_API_KEY");
    const fetched = await r.get("tenant-a");
    expect(fetched).not.toBeNull();
    expect(fetched!.kind).toBe("api_key");
    expect(fetched!.secret_ref).toBe("ANTHROPIC_API_KEY");
  });

  it("set with subscription_blob persists", async () => {
    const db = await freshDb();
    const r = new TenantClaudeAuthRepository(db);
    const row = await r.set("tenant-b", "subscription_blob", "claude-subscription");
    expect(row.kind).toBe("subscription_blob");
    expect(row.secret_ref).toBe("claude-subscription");
    const fetched = await r.get("tenant-b");
    expect(fetched!.kind).toBe("subscription_blob");
  });

  it("set overwrites a prior binding", async () => {
    const db = await freshDb();
    const r = new TenantClaudeAuthRepository(db);
    await r.set("t1", "api_key", "OLD_KEY");
    await r.set("t1", "subscription_blob", "claude-sub");
    const row = await r.get("t1");
    expect(row!.kind).toBe("subscription_blob");
    expect(row!.secret_ref).toBe("claude-sub");
  });

  it("clear removes the binding, then get returns null", async () => {
    const db = await freshDb();
    const r = new TenantClaudeAuthRepository(db);
    await r.set("t1", "api_key", "K");
    const removed = await r.clear("t1");
    expect(removed).toBe(true);
    expect(await r.get("t1")).toBeNull();
    // Second clear is idempotent-false.
    expect(await r.clear("t1")).toBe(false);
  });

  it("rejects invalid kind", async () => {
    const db = await freshDb();
    const r = new TenantClaudeAuthRepository(db);
    await expect(r.set("t1", "wat" as any, "ref")).rejects.toThrow(/Invalid claude auth kind/);
  });

  it("rejects empty secret_ref", async () => {
    const db = await freshDb();
    const r = new TenantClaudeAuthRepository(db);
    await expect(r.set("t1", "api_key", "")).rejects.toThrow(/secretRef/);
  });

  it("isolates tenants", async () => {
    const db = await freshDb();
    const r = new TenantClaudeAuthRepository(db);
    await r.set("t1", "api_key", "K1");
    await r.set("t2", "subscription_blob", "blob2");
    expect((await r.get("t1"))!.kind).toBe("api_key");
    expect((await r.get("t2"))!.kind).toBe("subscription_blob");
  });
});
