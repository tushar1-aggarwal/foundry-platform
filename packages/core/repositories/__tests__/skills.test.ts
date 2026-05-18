/**
 * SkillRepository + SkillVersionRepository tests.
 *
 * Coverage:
 *   - CHECK constraint enforcement (good shapes accepted, bad shapes rejected)
 *   - visibility-aware listing (user-scope, team-scope, tenant-scope, consultant pattern)
 *   - put() create vs update; transactional version + skill write
 *   - body-unchanged update doesn't write a new skill_versions row
 *   - softDelete idempotency + hides row from reads
 *   - SkillVersionRepository.getByHash + listBySkill
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "crypto";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database/index.js";
import { MigrationRunner } from "../../migrations/runner.js";
import { TenantManager } from "../../auth/tenants.js";
import { TeamManager } from "../../auth/teams.js";
import { UserManager } from "../../auth/users.js";
import { SkillRepository, SkillVersionRepository, SkillVersionConflictError, type PutInput } from "../skills.js";

async function freshDb(): Promise<DatabaseAdapter> {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  await new MigrationRunner(db, "sqlite").apply();
  return db;
}

/**
 * Common PutInput template. Tests override only what they care about.
 */
function makePut(overrides: Partial<PutInput>): PutInput {
  return {
    tenant_id: null,
    team_id: null,
    owner_user_id: null,
    visibility: "user",
    name: "test-skill",
    description: "A test skill",
    body: "Test body content.",
    supporting_files: [],
    category: null,
    tags: [],
    harness_hints: {},
    actor: "u-test",
    ...overrides,
  };
}

describe("SkillRepository — CHECK constraint", () => {
  it("accepts a well-formed user-scope row (tenant_id NULL, owner_user_id set)", async () => {
    const db = await freshDb();
    const user = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);

    const result = await repo.put(makePut({ visibility: "user", owner_user_id: user.id, name: "alice-personal" }));

    expect(result.skill.visibility).toBe("user");
    expect(result.skill.tenant_id).toBeNull();
    expect(result.skill.owner_user_id).toBe(user.id);
    expect(result.versionWritten).toBe(true);
    await db.close();
  });

  it("accepts a well-formed team-scope row (tenant_id + team_id set)", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "acme", name: "Acme" });
    const team = await new TeamManager(db).create({ tenant_id: tenant.id, slug: "eng", name: "Eng" });
    const repo = new SkillRepository(db);

    const result = await repo.put(
      makePut({ visibility: "team", tenant_id: tenant.id, team_id: team.id, name: "team-style" }),
    );

    expect(result.skill.visibility).toBe("team");
    expect(result.skill.tenant_id).toBe(tenant.id);
    expect(result.skill.team_id).toBe(team.id);
    expect(result.skill.owner_user_id).toBeNull();
    await db.close();
  });

  it("accepts a well-formed tenant-scope row (tenant_id set, others NULL)", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "acme", name: "Acme" });
    const repo = new SkillRepository(db);

    const result = await repo.put(makePut({ visibility: "tenant", tenant_id: tenant.id, name: "paytm-conventions" }));

    expect(result.skill.visibility).toBe("tenant");
    expect(result.skill.tenant_id).toBe(tenant.id);
    expect(result.skill.team_id).toBeNull();
    expect(result.skill.owner_user_id).toBeNull();
    await db.close();
  });

  it("rejects user-scope row that includes a tenant_id (CHECK constraint)", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "acme", name: "Acme" });
    const user = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);

    await expect(
      repo.put(makePut({ visibility: "user", tenant_id: tenant.id, owner_user_id: user.id, name: "bad" })),
    ).rejects.toThrow();
    await db.close();
  });

  it("rejects team-scope row that omits team_id (CHECK constraint)", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "acme", name: "Acme" });
    const repo = new SkillRepository(db);

    await expect(
      repo.put(makePut({ visibility: "team", tenant_id: tenant.id, team_id: null, name: "bad" })),
    ).rejects.toThrow();
    await db.close();
  });

  it("rejects tenant-scope row that omits tenant_id (CHECK constraint)", async () => {
    const db = await freshDb();
    const repo = new SkillRepository(db);

    await expect(repo.put(makePut({ visibility: "tenant", tenant_id: null, name: "bad" }))).rejects.toThrow();
    await db.close();
  });
});

describe("SkillRepository — listVisibleTo (visibility-aware listing)", () => {
  it("returns only the caller's own user-scope rows, not other users' user-scope", async () => {
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const bob = await new UserManager(db).create({ email: "bob@example.com" });
    const repo = new SkillRepository(db);

    await repo.put(makePut({ visibility: "user", owner_user_id: alice.id, name: "alice-skill" }));
    await repo.put(makePut({ visibility: "user", owner_user_id: bob.id, name: "bob-skill" }));

    const aliceList = await repo.listVisibleTo(alice.id, "default", []);
    expect(aliceList.map((s) => s.name).sort()).toEqual(["alice-skill"]);

    const bobList = await repo.listVisibleTo(bob.id, "default", []);
    expect(bobList.map((s) => s.name).sort()).toEqual(["bob-skill"]);
    await db.close();
  });

  it("returns team-scope rows when team is in caller's team-chain", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "acme", name: "Acme" });
    const teamEng = await new TeamManager(db).create({ tenant_id: tenant.id, slug: "eng", name: "Eng" });
    const teamSec = await new TeamManager(db).create({ tenant_id: tenant.id, slug: "sec", name: "Sec" });
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);

    await repo.put(makePut({ visibility: "team", tenant_id: tenant.id, team_id: teamEng.id, name: "eng-skill" }));
    await repo.put(makePut({ visibility: "team", tenant_id: tenant.id, team_id: teamSec.id, name: "sec-skill" }));

    // alice is only in team-eng's chain
    const aliceList = await repo.listVisibleTo(alice.id, tenant.id, [teamEng.id]);
    expect(aliceList.map((s) => s.name).sort()).toEqual(["eng-skill"]);

    // If alice is in both teams' chains, she sees both
    const bothList = await repo.listVisibleTo(alice.id, tenant.id, [teamEng.id, teamSec.id]);
    expect(bothList.map((s) => s.name).sort()).toEqual(["eng-skill", "sec-skill"]);
    await db.close();
  });

  it("returns tenant-scope rows to anyone in that tenant", async () => {
    const db = await freshDb();
    const tenant = await new TenantManager(db).create({ slug: "acme", name: "Acme" });
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);

    await repo.put(makePut({ visibility: "tenant", tenant_id: tenant.id, name: "paytm-conventions" }));

    const list = await repo.listVisibleTo(alice.id, tenant.id, []);
    expect(list.map((s) => s.name).sort()).toEqual(["paytm-conventions"]);
    await db.close();
  });

  it("consultant pattern: user-scope rows are visible regardless of tenant context", async () => {
    const db = await freshDb();
    const tenantA = await new TenantManager(db).create({ slug: "a", name: "A" });
    const tenantB = await new TenantManager(db).create({ slug: "b", name: "B" });
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);

    // Alice creates her personal skill (tenant_id=NULL by user-scope shape)
    await repo.put(makePut({ visibility: "user", owner_user_id: alice.id, name: "alice-personal" }));

    // Alice authenticated in tenant A: sees the skill
    const fromA = await repo.listVisibleTo(alice.id, tenantA.id, []);
    expect(fromA.map((s) => s.name)).toContain("alice-personal");

    // Alice authenticated in tenant B: also sees the skill (tenant-agnostic)
    const fromB = await repo.listVisibleTo(alice.id, tenantB.id, []);
    expect(fromB.map((s) => s.name)).toContain("alice-personal");
    await db.close();
  });

  it("cross-tenant isolation: team/tenant skills do NOT cross tenant boundaries", async () => {
    const db = await freshDb();
    const tenantA = await new TenantManager(db).create({ slug: "a", name: "A" });
    const tenantB = await new TenantManager(db).create({ slug: "b", name: "B" });
    const teamA = await new TeamManager(db).create({ tenant_id: tenantA.id, slug: "eng-a", name: "EngA" });
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);

    await repo.put(
      makePut({ visibility: "team", tenant_id: tenantA.id, team_id: teamA.id, name: "tenant-a-team-skill" }),
    );
    await repo.put(makePut({ visibility: "tenant", tenant_id: tenantA.id, name: "tenant-a-tenant-skill" }));

    // Alice authenticated in tenant A with team-a in the chain: sees both.
    const fromA = await repo.listVisibleTo(alice.id, tenantA.id, [teamA.id]);
    expect(fromA.map((s) => s.name).sort()).toEqual(["tenant-a-team-skill", "tenant-a-tenant-skill"]);

    // Alice authenticated in tenant B, with a STALE/buggy teamChain that
    // still contains team-a (a tenant-A team): the repo must refuse to
    // leak either skill across tenants — strict isolation per Q1. The
    // team-branch's tenantId predicate is the defense-in-depth that
    // catches this even if the handler forgets to filter the chain.
    const fromB = await repo.listVisibleTo(alice.id, tenantB.id, [teamA.id]);
    expect(fromB.map((s) => s.name)).not.toContain("tenant-a-team-skill");
    expect(fromB.map((s) => s.name)).not.toContain("tenant-a-tenant-skill");
    await db.close();
  });

  it("hides soft-deleted rows", async () => {
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);

    const created = await repo.put(makePut({ visibility: "user", owner_user_id: alice.id, name: "alice-skill" }));
    expect((await repo.listVisibleTo(alice.id, "default", [])).length).toBe(1);

    await repo.softDelete(created.skill.id, alice.id);
    expect(await repo.getById(created.skill.id)).toBeNull();
    expect((await repo.listVisibleTo(alice.id, "default", [])).length).toBe(0);
    await db.close();
  });
});

describe("SkillRepository — put() versioning", () => {
  it("create writes a new skill row and a skill_versions row", async () => {
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);
    const versions = new SkillVersionRepository(db);

    const created = await repo.put(
      makePut({ visibility: "user", owner_user_id: alice.id, name: "alice-skill", body: "v1" }),
    );

    expect(created.versionWritten).toBe(true);
    const history = await versions.listBySkill(created.skill.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.version_hash).toBe(created.skill.current_hash);
    expect(history[0]?.body).toBe("v1");
    await db.close();
  });

  it("update with body change appends a new skill_versions row", async () => {
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);
    const versions = new SkillVersionRepository(db);

    const created = await repo.put(
      makePut({ visibility: "user", owner_user_id: alice.id, name: "alice-skill", body: "v1" }),
    );
    const updated = await repo.put(
      makePut({
        skill_id: created.skill.id,
        expected_current_hash: created.skill.current_hash,
        visibility: "user",
        owner_user_id: alice.id,
        name: "alice-skill",
        body: "v2",
      }),
    );

    expect(updated.versionWritten).toBe(true);
    expect(updated.skill.current_hash).not.toBe(created.skill.current_hash);
    expect(updated.skill.body).toBe("v2");

    const history = await versions.listBySkill(created.skill.id);
    expect(history).toHaveLength(2);
    expect(history[0]?.body).toBe("v2"); // newest first (desc order)
    expect(history[1]?.body).toBe("v1");
    await db.close();
  });

  it("update with unchanged body does NOT append a new version row", async () => {
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);
    const versions = new SkillVersionRepository(db);

    const created = await repo.put(
      makePut({ visibility: "user", owner_user_id: alice.id, name: "alice-skill", body: "same" }),
    );
    const metadataOnly = await repo.put(
      makePut({
        skill_id: created.skill.id,
        expected_current_hash: created.skill.current_hash,
        visibility: "user",
        owner_user_id: alice.id,
        name: "alice-skill",
        body: "same",
        description: "edited description only",
      }),
    );

    expect(metadataOnly.versionWritten).toBe(false);
    expect(metadataOnly.skill.current_hash).toBe(created.skill.current_hash);
    expect(metadataOnly.skill.description).toBe("edited description only");

    const history = await versions.listBySkill(created.skill.id);
    expect(history).toHaveLength(1);
    await db.close();
  });

  it("create + update are atomic: the new current_hash always has a matching skill_versions row", async () => {
    // Lookup invariant from RFC §3 schema notes.
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);
    const versions = new SkillVersionRepository(db);

    const created = await repo.put(
      makePut({ visibility: "user", owner_user_id: alice.id, name: "alice-skill", body: "v1" }),
    );
    const matching = await versions.getByHash(created.skill.id, created.skill.current_hash);
    expect(matching).not.toBeNull();
    expect(matching!.body).toBe("v1");

    const updated = await repo.put(
      makePut({
        skill_id: created.skill.id,
        expected_current_hash: created.skill.current_hash,
        visibility: "user",
        owner_user_id: alice.id,
        name: "alice-skill",
        body: "v2",
      }),
    );
    const matchingV2 = await versions.getByHash(updated.skill.id, updated.skill.current_hash);
    expect(matchingV2).not.toBeNull();
    expect(matchingV2!.body).toBe("v2");
    await db.close();
  });

  it("update throws SkillVersionConflictError when expected_current_hash is stale", async () => {
    // Simulates the race the compare-and-set is defending against:
    // someone else's put landed between our handler-layer check and
    // this call. Our expected_current_hash no longer matches the DB's
    // current_hash; the UPDATE matches 0 rows; we throw.
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);
    const versions = new SkillVersionRepository(db);

    const created = await repo.put(
      makePut({ visibility: "user", owner_user_id: alice.id, name: "alice-skill", body: "v1" }),
    );
    // Simulate a concurrent winner.
    await repo.put(
      makePut({
        skill_id: created.skill.id,
        expected_current_hash: created.skill.current_hash,
        visibility: "user",
        owner_user_id: alice.id,
        name: "alice-skill",
        body: "winner",
      }),
    );

    // Our stale put using the original (now obsolete) hash.
    await expect(
      repo.put(
        makePut({
          skill_id: created.skill.id,
          expected_current_hash: created.skill.current_hash, // stale
          visibility: "user",
          owner_user_id: alice.id,
          name: "alice-skill",
          body: "loser",
        }),
      ),
    ).rejects.toBeInstanceOf(SkillVersionConflictError);

    // The transaction rolled back, so no "loser" version row got stranded
    // in skill_versions.
    const history = await versions.listBySkill(created.skill.id);
    expect(history.map((h) => h.body).sort()).toEqual(["v1", "winner"]);
    await db.close();
  });

  it("update requires expected_current_hash when skill_id is provided", async () => {
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);

    const created = await repo.put(
      makePut({ visibility: "user", owner_user_id: alice.id, name: "alice-skill", body: "v1" }),
    );

    await expect(
      repo.put(
        makePut({
          skill_id: created.skill.id,
          // expected_current_hash deliberately omitted
          visibility: "user",
          owner_user_id: alice.id,
          name: "alice-skill",
          body: "v2",
        }),
      ),
    ).rejects.toThrow(/expected_current_hash is required/);
    await db.close();
  });

  it("revert to a prior body: current_hash points back at the original version, no new row written", async () => {
    // B1 → B2 → revert to byte-identical B1. The third put computes
    // newHash = H1 (same as the original); the UPDATE's CAS on H2
    // succeeds (current was H2); the version INSERT must NOT throw a
    // UNIQUE-constraint violation on (skill_id, H1). Instead, ON
    // CONFLICT DO NOTHING leaves the original H1 version row intact
    // and the skills.current_hash rolls back to H1.
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const bob = await new UserManager(db).create({ email: "bob@example.com" });
    const repo = new SkillRepository(db);
    const versions = new SkillVersionRepository(db);

    // Original B1 authored by alice.
    const v1 = await repo.put(
      makePut({ visibility: "user", owner_user_id: alice.id, name: "alice-skill", body: "B1", actor: alice.id }),
    );
    const h1 = v1.skill.current_hash;
    const originalH1Row = await versions.getByHash(v1.skill.id, h1);
    expect(originalH1Row?.changed_by).toBe(alice.id);

    // Update to B2 authored by alice.
    const v2 = await repo.put(
      makePut({
        skill_id: v1.skill.id,
        expected_current_hash: h1,
        visibility: "user",
        owner_user_id: alice.id,
        name: "alice-skill",
        body: "B2",
        actor: alice.id,
      }),
    );
    const h2 = v2.skill.current_hash;
    expect(h2).not.toBe(h1);

    // Revert to byte-identical B1, this time authored by bob.
    // The version row at (skill_id, H1) ALREADY exists from the
    // original put; ON CONFLICT DO NOTHING ensures we don't try to
    // overwrite it. versionWritten should be false because no new row
    // was inserted.
    const reverted = await repo.put(
      makePut({
        skill_id: v1.skill.id,
        expected_current_hash: h2,
        visibility: "user",
        owner_user_id: alice.id,
        name: "alice-skill",
        body: "B1",
        actor: bob.id,
      }),
    );

    expect(reverted.versionWritten).toBe(false);
    expect(reverted.skill.current_hash).toBe(h1);
    expect(reverted.skill.body).toBe("B1");

    // skill_versions should still have exactly TWO rows (H1 + H2),
    // not three. The H1 row's author and timestamp should be unchanged
    // from the original creation — bob's revert didn't author it.
    const history = await versions.listBySkill(v1.skill.id);
    expect(history).toHaveLength(2);
    const h1Row = history.find((row) => row.version_hash === h1);
    expect(h1Row).toBeDefined();
    expect(h1Row?.changed_by).toBe(alice.id);
    expect(h1Row?.changed_at).toBe(originalH1Row!.changed_at);
    await db.close();
  });

  it("update against non-existent skill_id throws a conflict", async () => {
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);

    // The compare-and-set matches zero rows because no skl-deadbeef
    // skill exists in the first place. From the caller's perspective
    // "skill missing" and "skill concurrently moved on" are both
    // conflict-class outcomes that map to HTTP 409.
    await expect(
      repo.put(
        makePut({
          skill_id: "skl-deadbeef",
          expected_current_hash: "h-anything",
          visibility: "user",
          owner_user_id: alice.id,
          name: "alice-skill",
          body: "anything",
        }),
      ),
    ).rejects.toBeInstanceOf(SkillVersionConflictError);
    await db.close();
  });

  it("captures merge_input on the version row when present (LLM-merge provenance)", async () => {
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);
    const versions = new SkillVersionRepository(db);

    const result = await repo.put({
      ...makePut({ visibility: "user", owner_user_id: alice.id, name: "merged-skill", body: "merged-v1" }),
      merge_input: {
        ancestor_hash: "h-ancestor",
        mine_hash: "h-mine",
        theirs_hash: "h-theirs",
        llm_model: "claude-sonnet-4-6",
      },
    });

    const history = await versions.listBySkill(result.skill.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.merge_input_json).toEqual({
      ancestor_hash: "h-ancestor",
      mine_hash: "h-mine",
      theirs_hash: "h-theirs",
      llm_model: "claude-sonnet-4-6",
    });
    await db.close();
  });
});

describe("SkillRepository — softDelete", () => {
  it("returns true on first call, true on second (idempotent), hides from getById", async () => {
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);

    const created = await repo.put(makePut({ visibility: "user", owner_user_id: alice.id, name: "alice-skill" }));
    expect(await repo.softDelete(created.skill.id, alice.id)).toBe(true);
    expect(await repo.getById(created.skill.id)).toBeNull();

    // Second call: row is already soft-deleted; nothing to update; returns false (no rows changed).
    expect(await repo.softDelete(created.skill.id, alice.id)).toBe(false);
    await db.close();
  });
});

describe("SkillVersionRepository", () => {
  it("getByHash returns the matching version, null otherwise", async () => {
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);
    const versions = new SkillVersionRepository(db);

    const created = await repo.put(
      makePut({ visibility: "user", owner_user_id: alice.id, name: "alice-skill", body: "v1" }),
    );

    expect(await versions.getByHash(created.skill.id, created.skill.current_hash)).not.toBeNull();
    expect(await versions.getByHash(created.skill.id, "deadbeef".repeat(8))).toBeNull();
    expect(await versions.getByHash("skl-missing", created.skill.current_hash)).toBeNull();
    await db.close();
  });

  it("listBySkill returns versions newest-first", async () => {
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);
    const versions = new SkillVersionRepository(db);

    const v1 = await repo.put(
      makePut({ visibility: "user", owner_user_id: alice.id, name: "alice-skill", body: "v1" }),
    );
    const v2 = await repo.put(
      makePut({
        skill_id: v1.skill.id,
        expected_current_hash: v1.skill.current_hash,
        visibility: "user",
        owner_user_id: alice.id,
        name: "alice-skill",
        body: "v2",
      }),
    );
    await repo.put(
      makePut({
        skill_id: v1.skill.id,
        expected_current_hash: v2.skill.current_hash,
        visibility: "user",
        owner_user_id: alice.id,
        name: "alice-skill",
        body: "v3",
      }),
    );

    const history = await versions.listBySkill(v1.skill.id);
    expect(history.map((h) => h.body)).toEqual(["v3", "v2", "v1"]);
    await db.close();
  });

  it("skill_versions row round-trips supporting_files at the version's hash", async () => {
    // version_hash is sha256 of the full canonical bundle ({body,
    // supporting_files}). The row must persist both halves so an ancestor
    // lookup reconstructs the same bundle that produced the hash. This is
    // load-bearing for skill/get_with_ancestor → 3-way merge in §7.
    const db = await freshDb();
    const alice = await new UserManager(db).create({ email: "alice@example.com" });
    const repo = new SkillRepository(db);
    const versions = new SkillVersionRepository(db);

    const v1 = await repo.put(
      makePut({
        visibility: "user",
        owner_user_id: alice.id,
        name: "alice-skill",
        body: "v1 body",
        supporting_files: [
          { path: "references/spec.md", content: "v1 spec" },
          { path: "scripts/run.py", content: "print('v1')" },
        ],
      }),
    );
    const v2 = await repo.put(
      makePut({
        skill_id: v1.skill.id,
        expected_current_hash: v1.skill.current_hash,
        visibility: "user",
        owner_user_id: alice.id,
        name: "alice-skill",
        body: "v2 body",
        supporting_files: [
          { path: "references/spec.md", content: "v2 spec" },
          { path: "scripts/run.py", content: "print('v2')" },
        ],
      }),
    );

    const ancestor = await versions.getByHash(v1.skill.id, v1.skill.current_hash);
    expect(ancestor).not.toBeNull();
    expect(ancestor!.body).toBe("v1 body");
    expect(ancestor!.supporting_files).toEqual([
      { path: "references/spec.md", content: "v1 spec" },
      { path: "scripts/run.py", content: "print('v1')" },
    ]);

    const current = await versions.getByHash(v2.skill.id, v2.skill.current_hash);
    expect(current).not.toBeNull();
    expect(current!.body).toBe("v2 body");
    expect(current!.supporting_files).toEqual([
      { path: "references/spec.md", content: "v2 spec" },
      { path: "scripts/run.py", content: "print('v2')" },
    ]);

    await db.close();
  });
});

// ── Postgres path — gated on DATABASE_URL ─────────────────────────────────
//
// Production runs Postgres, so the SQL-portability-sensitive paths in this
// repo (compare-and-set on UPDATE, ON CONFLICT DO NOTHING on the version
// insert) MUST work there. SQLite serializes-by-accident hides the race
// the CAS exists for; the revert path uses drizzle's onConflictDoNothing
// which compiles to different SQL on SQLite vs Postgres.
//
// Mirrors the gate pattern in migrations/__tests__/runner.test.ts:
// skip if DATABASE_URL is absent, else run against a per-test schema
// that gets dropped on cleanup so the tests don't pollute each other or
// the developer's database.
describe("SkillRepository — postgres (gated)", async () => {
  const url = process.env.DATABASE_URL;
  const isPg = !!url && (url.startsWith("postgres://") || url.startsWith("postgresql://"));

  if (!isPg) {
    it.skip("DATABASE_URL not set — skipping Postgres SkillRepository tests", () => {});
    return;
  }

  async function freshPg(): Promise<{ db: DatabaseAdapter; cleanup: () => Promise<void> }> {
    const { PostgresAdapter } = await import("../../database/postgres.js");
    // Per-test DATABASE for isolation. Using a separate schema with
    // `SET search_path` doesn't survive the PostgresAdapter's
    // connection pool (each pool checkout starts in the default
    // search_path). A fresh database sidesteps the issue entirely:
    // every connection from the new adapter lands on the same dedicated
    // db with all its tables, no per-query search_path gymnastics.
    const masterUrl = url as string;
    const dbName = `skill_test_${randomBytes(4).toString("hex")}`;

    const testUrl = masterUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    if (testUrl === masterUrl) {
      throw new Error("DATABASE_URL must include a database path (postgres://user:pass@host:port/dbname)");
    }

    const master = new PostgresAdapter(masterUrl);
    try {
      await master.exec(`CREATE DATABASE ${dbName}`);
    } finally {
      await master.close();
    }

    const db = new PostgresAdapter(testUrl);
    try {
      await new MigrationRunner(db, "postgres").apply();
    } catch (e) {
      // Migration failed - release the freshly-created db so we don't
      // strand it in the cluster.
      await db.close();
      const cm = new PostgresAdapter(masterUrl);
      try {
        await cm.exec(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally {
        await cm.close();
      }
      throw e;
    }

    return {
      db,
      cleanup: async () => {
        await db.close();
        // DROP DATABASE needs zero other connections to the target.
        // Closing `db` above is sufficient because the adapter is the
        // only connection holder in this test.
        const cleanupMaster = new PostgresAdapter(masterUrl);
        try {
          await cleanupMaster.exec(`DROP DATABASE IF EXISTS ${dbName}`);
        } finally {
          await cleanupMaster.close();
        }
      },
    };
  }

  it("CHECK constraint fires on Postgres: rejects user-scope row that includes a tenant_id", async () => {
    // Proves the named-CONSTRAINT form in 022_skills_postgres.ts actually
    // installed and enforces. Migration apply succeeding doesn't guarantee
    // the CHECK predicate parses & fires the way it does on SQLite.
    const { db, cleanup } = await freshPg();
    try {
      const tenant = await new TenantManager(db).create({ slug: "acme", name: "Acme" });
      const user = await new UserManager(db).create({ email: "alice-pg@example.com" });
      const repo = new SkillRepository(db);

      await expect(
        repo.put(makePut({ visibility: "user", tenant_id: tenant.id, owner_user_id: user.id, name: "bad" })),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("revert to a prior body works on Postgres (onConflictDoNothing path)", async () => {
    // Mirrors the SQLite revert test above. The interesting bit on
    // Postgres is that ON CONFLICT DO NOTHING is real ANSI SQL there;
    // SQLite's INSERT OR IGNORE is dialect-specific. Drizzle abstracts
    // both behind .onConflictDoNothing() — this test confirms the
    // abstraction holds.
    const { db, cleanup } = await freshPg();
    try {
      const alice = await new UserManager(db).create({ email: "alice-pg@example.com" });
      const repo = new SkillRepository(db);
      const versions = new SkillVersionRepository(db);

      const v1 = await repo.put(
        makePut({
          visibility: "user",
          owner_user_id: alice.id,
          name: "alice-skill",
          description: "First",
          body: "B1",
          actor: alice.id,
        }),
      );
      const h1 = v1.skill.current_hash;

      const v2 = await repo.put(
        makePut({
          skill_id: v1.skill.id,
          expected_current_hash: h1,
          visibility: "user",
          owner_user_id: alice.id,
          name: "alice-skill",
          description: "Second",
          body: "B2",
          actor: alice.id,
        }),
      );
      const h2 = v2.skill.current_hash;

      const reverted = await repo.put(
        makePut({
          skill_id: v1.skill.id,
          expected_current_hash: h2,
          visibility: "user",
          owner_user_id: alice.id,
          name: "alice-skill",
          description: "Revert",
          body: "B1",
          actor: alice.id,
        }),
      );

      expect(reverted.versionWritten).toBe(false);
      expect(reverted.skill.current_hash).toBe(h1);
      expect(reverted.skill.body).toBe("B1");

      const history = await versions.listBySkill(v1.skill.id);
      expect(history).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("compare-and-set rejects stale expected_current_hash on Postgres", async () => {
    // The CAS race the fix exists for is fundamentally a Postgres
    // concern — SQLite serializes-by-accident hides it. Verifying on
    // Postgres directly confirms the WHERE-clause hash filter
    // actually gates the UPDATE.
    const { db, cleanup } = await freshPg();
    try {
      const alice = await new UserManager(db).create({ email: "alice-pg@example.com" });
      const repo = new SkillRepository(db);

      const v1 = await repo.put(
        makePut({
          visibility: "user",
          owner_user_id: alice.id,
          name: "alice-skill",
          description: "First",
          body: "v1",
          actor: alice.id,
        }),
      );

      // Simulate a concurrent winner.
      await repo.put(
        makePut({
          skill_id: v1.skill.id,
          expected_current_hash: v1.skill.current_hash,
          visibility: "user",
          owner_user_id: alice.id,
          name: "alice-skill",
          description: "Winner",
          body: "winner",
          actor: alice.id,
        }),
      );

      // Our stale put.
      await expect(
        repo.put(
          makePut({
            skill_id: v1.skill.id,
            expected_current_hash: v1.skill.current_hash, // stale
            visibility: "user",
            owner_user_id: alice.id,
            name: "alice-skill",
            description: "Loser",
            body: "loser",
            actor: alice.id,
          }),
        ),
      ).rejects.toBeInstanceOf(SkillVersionConflictError);
    } finally {
      await cleanup();
    }
  });
});
