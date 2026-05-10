/**
 * Tests for API key management (create, validate, revoke, rotate, expiry).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { AppContext } from "../app.js";

let app: AppContext;

beforeEach(async () => {
  if (app) {
    await app.shutdown();
  }
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  if (app) {
    await app.shutdown();
  }
});

describe("ApiKeyManager", async () => {
  describe("create", async () => {
    it("creates a key with the correct format", async () => {
      const result = await app.apiKeys.create("test-tenant", "my key", "member");
      expect(result.key).toMatch(/^ark_test-tenant_[a-f0-9]+$/);
      expect(result.id).toMatch(/^ak-[a-f0-9]+$/);
    });

    it("creates keys with different roles", async () => {
      const admin = await app.apiKeys.create("t1", "admin key", "admin");
      const member = await app.apiKeys.create("t1", "member key", "member");
      const viewer = await app.apiKeys.create("t1", "viewer key", "viewer");

      expect(admin.key).toBeTruthy();
      expect(member.key).toBeTruthy();
      expect(viewer.key).toBeTruthy();

      // All should be different
      expect(new Set([admin.key, member.key, viewer.key]).size).toBe(3);
    });
  });

  describe("validate", async () => {
    it("validates a valid key and returns tenant context", async () => {
      const { key } = await app.apiKeys.create("acme", "ci-key", "member");
      const ctx = await app.apiKeys.validate(key);

      expect(ctx).not.toBeNull();
      expect(ctx!.tenantId).toBe("acme");
      expect(ctx!.role).toBe("member");
    });

    it("returns null for invalid key", async () => {
      const ctx = await app.apiKeys.validate("ark_fake_notreal");
      expect(ctx).toBeNull();
    });

    it("returns null for malformed key", async () => {
      expect(await app.apiKeys.validate("not-an-ark-key")).toBeNull();
      expect(await app.apiKeys.validate("")).toBeNull();
      expect(await app.apiKeys.validate("ark_")).toBeNull();
    });

    it("updates last_used_at on successful validation", async () => {
      const { key, id } = await app.apiKeys.create("acme", "track-usage", "admin");
      const keysBefore = await app.apiKeys.list("acme");
      const before = keysBefore.find((k) => k.id === id);
      expect(before!.lastUsedAt).toBeNull();

      await app.apiKeys.validate(key);

      const keysAfter = await app.apiKeys.list("acme");
      const after = keysAfter.find((k) => k.id === id);
      expect(after!.lastUsedAt).not.toBeNull();
    });

    it("rejects expired keys", async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
      const { key } = await app.apiKeys.create("acme", "expired-key", "member", pastDate);
      const ctx = await app.apiKeys.validate(key);
      expect(ctx).toBeNull();
    });

    it("accepts non-expired keys", async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString(); // 1 day from now
      const { key } = await app.apiKeys.create("acme", "valid-key", "member", futureDate);
      const ctx = await app.apiKeys.validate(key);
      expect(ctx).not.toBeNull();
      expect(ctx!.tenantId).toBe("acme");
    });

    it("admin-minted key (NULL user_id): scopingUserId=null, teamChain=[]", async () => {
      const { key } = await app.apiKeys.create("acme", "admin-key", "admin");
      const ctx = await app.apiKeys.validate(key);
      expect(ctx).not.toBeNull();
      expect(ctx!.scopingUserId).toBeNull();
      expect(ctx!.teamChain).toEqual([]);
    });

    it("owned key: scopingUserId = api_keys.user_id; teamChain walks owner's primary membership", async () => {
      // Build a small org chain `parent <- team` under `default` and put
      // user `u-owner` on team. Mint a self-service key owned by them.
      const tenant = await app.tenants.create({ slug: "owned-key-t", name: "T" });
      const parent = await app.teams.create({ tenant_id: tenant.id, slug: "parent", name: "Parent" });
      const team = await app.teams.create({ tenant_id: tenant.id, slug: "leaf", name: "Leaf" });
      await app.db.exec(`UPDATE teams SET parent_team_id = '${parent.id}' WHERE id = '${team.id}'`);
      const u = await app.users.upsertByEmail({ email: "owner@paytm.com" });
      await app.teams.addMember(team.id, u.id, "member");

      const { key } = await app.apiKeys.create(tenant.id, "owner-key", "member", undefined, u.id);
      const ctx = await app.apiKeys.validate(key);
      expect(ctx).not.toBeNull();
      // userId stays the ak-... sentinel (identity gate); scopingUserId
      // is the owner's users.id (scoping gate).
      expect(ctx!.userId).toMatch(/^ak-/);
      expect(ctx!.scopingUserId).toBe(u.id);
      expect(ctx!.teamChain).toEqual([team.id, parent.id]);
    });
  });

  describe("list", async () => {
    it("lists keys for a specific tenant", async () => {
      await app.apiKeys.create("tenant-a", "key-1", "admin");
      await app.apiKeys.create("tenant-a", "key-2", "member");
      await app.apiKeys.create("tenant-b", "key-3", "viewer");

      const keysA = await app.apiKeys.list("tenant-a");
      expect(keysA.length).toBe(2);
      expect(keysA.every((k) => k.tenantId === "tenant-a")).toBe(true);

      const keysB = await app.apiKeys.list("tenant-b");
      expect(keysB.length).toBe(1);
      expect(keysB[0].tenantId).toBe("tenant-b");
    });

    it("returns empty array for nonexistent tenant", async () => {
      const keys = await app.apiKeys.list("nobody");
      expect(keys).toEqual([]);
    });
  });

  describe("revoke", async () => {
    it("revokes an existing key", async () => {
      const { key, id } = await app.apiKeys.create("acme", "to-revoke", "member");
      expect(await app.apiKeys.validate(key)).not.toBeNull();

      const ok = await app.apiKeys.revoke(id);
      expect(ok).toBe(true);

      // Key should no longer validate
      expect(await app.apiKeys.validate(key)).toBeNull();
    });

    it("returns false for nonexistent key", async () => {
      const ok = await app.apiKeys.revoke("ak-nonexistent");
      expect(ok).toBe(false);
    });

    it("refuses to revoke another tenant's key when tenantId is supplied", async () => {
      // Security: tenantId-scoped revoke must not touch other tenants'
      // rows. This is the guard that prevents cross-tenant API key
      // destruction via a guessed/enumerated id.
      const victim = await app.apiKeys.create("tenant-victim", "victim-key", "admin");
      const ok = await app.apiKeys.revoke(victim.id, "tenant-attacker");
      expect(ok).toBe(false);
      // Victim key still works.
      expect(await app.apiKeys.validate(victim.key)).not.toBeNull();
    });

    it("revokes within the supplied tenant scope", async () => {
      const own = await app.apiKeys.create("tenant-owner", "own-key", "member");
      const ok = await app.apiKeys.revoke(own.id, "tenant-owner");
      expect(ok).toBe(true);
      expect(await app.apiKeys.validate(own.key)).toBeNull();
    });
  });

  describe("revokeAsUser race condition", async () => {
    it("two concurrent self-service revokes from the same owner both report success (idempotent)", async () => {
      // The previous implementation did SELECT-then-UPDATE; the second
      // concurrent revoke saw `changes === 0` and returned `false`, which
      // the handler mapped to FORBIDDEN ("API key not found or not owned
      // by caller"). User saw a privilege-denial error on a successful
      // revoke. With the fix, both revokes return `true` because the
      // observable end-state ("the row is deleted, by this owner") is
      // the same.
      const u = await app.users.upsertByEmail({ email: "race@paytm.com" });
      const tenant = "race-tenant";
      const created = await app.apiKeys.create(tenant, "race-key", "member", undefined, u.id);

      const [a, b] = await Promise.all([
        app.apiKeys.revokeAsUser(u.id, tenant, created.id),
        app.apiKeys.revokeAsUser(u.id, tenant, created.id),
      ]);
      expect(a).toBe(true);
      expect(b).toBe(true);
      // The row is in fact revoked.
      const live = await app.apiKeys.listForUser(u.id, tenant);
      expect(live.find((k) => k.id === created.id)).toBeUndefined();
    });

    it("revokeAsUser still rejects when ownership is wrong even if the row is already deleted by someone else", async () => {
      // Defense in depth: an attacker calling revokeAsUser with a guessed
      // id that belonged to a different owner must NOT get success just
      // because that row was concurrently revoked by its real owner.
      const owner = await app.users.upsertByEmail({ email: "race-owner@paytm.com" });
      const attacker = await app.users.upsertByEmail({ email: "race-attacker@paytm.com" });
      const tenant = "race-tenant-2";
      const created = await app.apiKeys.create(tenant, "race-key-2", "member", undefined, owner.id);

      // Owner revokes successfully.
      expect(await app.apiKeys.revokeAsUser(owner.id, tenant, created.id)).toBe(true);

      // Now attacker tries the same id; even though the row is now
      // deleted, ownership doesn't match -> false.
      expect(await app.apiKeys.revokeAsUser(attacker.id, tenant, created.id)).toBe(false);
    });
  });

  describe("rotate", async () => {
    it("creates a new key and revokes the old one", async () => {
      const original = await app.apiKeys.create("acme", "rotate-me", "admin");
      const rotated = await app.apiKeys.rotate(original.id);

      expect(rotated).not.toBeNull();
      expect(rotated!.key).not.toBe(original.key);
      expect(rotated!.key).toMatch(/^ark_acme_/);

      // Old key should be invalid
      expect(await app.apiKeys.validate(original.key)).toBeNull();

      // New key should be valid
      const ctx = await app.apiKeys.validate(rotated!.key);
      expect(ctx).not.toBeNull();
      expect(ctx!.tenantId).toBe("acme");
      expect(ctx!.role).toBe("admin");
    });

    it("returns null for nonexistent key", async () => {
      const result = await app.apiKeys.rotate("ak-nonexistent");
      expect(result).toBeNull();
    });

    it("refuses to rotate another tenant's key when tenantId is supplied", async () => {
      // Security: a caller scoped to one tenant cannot rotate another
      // tenant's keys -- the rotate would both invalidate the victim's
      // existing key and leak a brand-new key for the victim tenant to
      // the attacker. Tenant scoping blocks this.
      const victim = await app.apiKeys.create("tenant-victim2", "victim-rot", "admin");
      const result = await app.apiKeys.rotate(victim.id, "tenant-attacker2");
      expect(result).toBeNull();
      // Victim key still works.
      expect(await app.apiKeys.validate(victim.key)).not.toBeNull();
    });
  });

  // Regression: ApiKeyManager used to be a process-boot-time singleton on
  // AppContext, not resolved through the DI container. Tests that wanted to
  // swap a double had no seam. With the manager registered in
  // `packages/core/di/persistence.ts`, callers can override it after boot by
  // re-registering the `apiKeys` key on the container.
  describe("DI container", () => {
    it("exposes the same ApiKeyManager instance on every read", () => {
      const first = app.apiKeys;
      const second = app.apiKeys;
      expect(first).toBe(second);
    });

    it("supports test-time override via container.register({ apiKeys: asValue(...) })", async () => {
      const { asValue } = await import("awilix");
      const fake = { validate: async () => null } as unknown as typeof app.apiKeys;
      app.container.register({ apiKeys: asValue(fake) });
      expect(app.apiKeys).toBe(fake);
    });
  });
});
