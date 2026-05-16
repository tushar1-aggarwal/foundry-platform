/**
 * Integration tests for skillhub/* handlers.
 *
 * Covers the matrix from RFC §8:
 *   - auth gate (anonymous -> FORBIDDEN)
 *   - skillhub/list + skillhub/get visibility (user, team, tenant + consultant)
 *   - skillhub/sync_status four cases (up-to-date, server-changed, unknown, not-found)
 *   - skillhub/get_with_ancestor with + without ancestor; ancestor-not-found
 *   - skillhub/put create (visibility gates), update (CAS), force (per-visibility)
 *   - skillhub/delete (per-visibility admin gate)
 *   - skillhub/search substring match on name/description/tags; visibility honored
 *   - skillhub/published_after filters by updated_at >= since; visibility honored
 *   - admin/skillhub/list cross-team within tenant, admin-gated, excludes user-scope
 *   - server-side normalization (Claude tokens, original_body preserved when changed)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerSkillHandlers } from "../skill.js";
import { createRequest, ErrorCodes, type JsonRpcError, type JsonRpcResponse } from "../../../protocol/types.js";
import { anonymousContext, type TenantContext } from "../../../core/auth/context.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(async () => {
  router = new Router();
  registerSkillHandlers(router, app);
  // Order-independent tests: hard-delete the skill state. FK cascade
  // from skills -> skill_versions handles the history rows.
  await app.db.exec("DELETE FROM skills");
});

function dispatchAs(method: string, params: Record<string, unknown>, ctx: TenantContext) {
  return router.dispatch(createRequest(1, method, params), undefined, ctx);
}

async function ok<T = unknown>(res: unknown): Promise<T> {
  const r = res as JsonRpcResponse;
  if ("error" in r) throw new Error(`expected ok response, got error: ${JSON.stringify(r.error)}`);
  return r.result as T;
}

function errOf(res: unknown): JsonRpcError["error"] {
  const r = res as JsonRpcError;
  if (!("error" in r)) throw new Error(`expected error response, got ok: ${JSON.stringify(r)}`);
  return r.error;
}

function memberCtx(tenantId: string, userId: string, teamChain: string[] = []): TenantContext {
  return { tenantId, userId, role: "member", isAdmin: false, scopingUserId: userId, teamChain };
}

function adminCtx(tenantId: string, userId: string, teamChain: string[] = []): TenantContext {
  return { tenantId, userId, role: "admin", isAdmin: true, scopingUserId: userId, teamChain };
}

// Common fixture seed.
async function seedTenant(slug: string) {
  return app.tenants.create({ slug, name: slug });
}
async function seedTeam(tenantId: string, slug: string) {
  return app.teams.create({ tenant_id: tenantId, slug, name: slug });
}
async function seedUser(email: string) {
  return app.users.upsertByEmail({ email });
}

// Make a minimal valid skillhub/put body for a user-scope create.
function userCreatePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    harness: "claude",
    visibility: "user",
    name: "test-skill",
    description: "A test skill",
    body: "Test body content.",
    supporting_files: [],
    harness_hints: {},
    tags: [],
    ...overrides,
  };
}

// ── auth gate ─────────────────────────────────────────────────────────────

describe("skillhub/* auth gate", () => {
  it("anonymous -> FORBIDDEN on every method", async () => {
    const anon = anonymousContext();
    for (const method of [
      "skillhub/list",
      "skillhub/get",
      "skillhub/sync_status",
      "skillhub/get_with_ancestor",
      "skillhub/put",
      "skillhub/delete",
    ]) {
      const res = await dispatchAs(method, {}, anon);
      expect(errOf(res).code).toBe(ErrorCodes.FORBIDDEN);
    }
  });
});

// ── skillhub/put (create) ─────────────────────────────────────────────────

describe("skillhub/put — create", () => {
  it("user-scope: anyone with a user id can create their own; tenant_id is null", async () => {
    const alice = await seedUser("alice@example.com");
    const ctx = memberCtx("default", alice.id);
    const res = await ok<{
      skill: { id: string; visibility: string; tenant_id: string | null; owner_user_id: string };
    }>(await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-skill" }), ctx));
    expect(res.skill.visibility).toBe("user");
    expect(res.skill.tenant_id).toBeNull(); // consultant pattern
    expect(res.skill.owner_user_id).toBe(alice.id);
  });

  it("team-scope: non-admin -> FORBIDDEN", async () => {
    const tenant = await seedTenant("acme-team-gate");
    const team = await seedTeam(tenant.id, "eng");
    const alice = await seedUser("alice-team-member@example.com");
    const res = await dispatchAs(
      "skillhub/put",
      userCreatePayload({ visibility: "team", team_id: team.id, name: "team-skill" }),
      memberCtx(tenant.id, alice.id, [team.id]),
    );
    expect(errOf(res).code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("team-scope: admin in tenant (regardless of team-chain) -> created", async () => {
    // RFC §4 gate: requireAdmin in skill.tenant_id. No team-chain
    // requirement at create time, matching the mutation gate
    // (canMutate) — any tenant admin can act as janitor.
    const tenant = await seedTenant("acme-team-chain");
    const team = await seedTeam(tenant.id, "eng");
    const admin = await seedUser("admin-no-chain@example.com");
    const res = await ok<{ skill: { visibility: string; team_id: string | null } }>(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "team", team_id: team.id, name: "team-skill" }),
        adminCtx(tenant.id, admin.id, []), // empty chain
      ),
    );
    expect(res.skill.visibility).toBe("team");
    expect(res.skill.team_id).toBe(team.id);
  });

  it("team-scope: admin with team in chain -> created", async () => {
    const tenant = await seedTenant("acme-team-create");
    const team = await seedTeam(tenant.id, "eng");
    const admin = await seedUser("admin-with-chain@example.com");
    const res = await ok<{ skill: { visibility: string; tenant_id: string | null; team_id: string | null } }>(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "team", team_id: team.id, name: "team-skill" }),
        adminCtx(tenant.id, admin.id, [team.id]),
      ),
    );
    expect(res.skill.visibility).toBe("team");
    expect(res.skill.tenant_id).toBe(tenant.id);
    expect(res.skill.team_id).toBe(team.id);
  });

  it("tenant-scope: non-admin -> FORBIDDEN", async () => {
    const tenant = await seedTenant("acme-tenant-gate");
    const alice = await seedUser("alice-tenant-nonadmin@example.com");
    const res = await dispatchAs(
      "skillhub/put",
      userCreatePayload({ visibility: "tenant", name: "tenant-skill" }),
      memberCtx(tenant.id, alice.id),
    );
    expect(errOf(res).code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("tenant-scope: admin -> created", async () => {
    const tenant = await seedTenant("acme-tenant-create");
    const admin = await seedUser("admin-tenant@example.com");
    const res = await ok<{ skill: { visibility: string; tenant_id: string | null } }>(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "tenant", name: "tenant-skill" }),
        adminCtx(tenant.id, admin.id),
      ),
    );
    expect(res.skill.visibility).toBe("tenant");
    expect(res.skill.tenant_id).toBe(tenant.id);
  });

  it("cross_tenant visibility -> INVALID_PARAMS (RFC §9 Q1)", async () => {
    const alice = await seedUser("alice-cross-tenant@example.com");
    const res = await dispatchAs(
      "skillhub/put",
      userCreatePayload({ visibility: "cross_tenant", name: "cross" }),
      adminCtx("default", alice.id),
    );
    expect(errOf(res).code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  // Regression: api-key callers carry `ctx.userId === "ak-*"` and the real
  // user id sits on `ctx.scopingUserId`. Skill ownership / audit MUST use
  // the real user id so a skill follows its owner across keys (rotation,
  // multi-key setups) and the audit drawer surfaces the human, not the
  // sentinel. Service api-keys (scopingUserId === null) get refused on
  // user-scope create.
  it("api-key caller: user-scope owner_user_id is the real user, not the ak-* sentinel", async () => {
    const alice = await seedUser("alice-apikey@example.com");
    const apiKeyCtx: TenantContext = {
      tenantId: "default",
      userId: "ak-deadbeef", // api-key sentinel
      role: "member",
      isAdmin: false,
      scopingUserId: alice.id, // real user behind the key
      teamChain: [],
    };
    const created = await ok<{ skill: { id: string; owner_user_id: string; created_by: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-apikey" }), apiKeyCtx),
    );
    expect(created.skill.owner_user_id).toBe(alice.id);
    // created_by mirrors the real user (scopingUserId), not the ak-*
    // sentinel — so the audit drawer surfaces the human across key
    // rotations.
    expect(created.skill.created_by).toBe(alice.id);

    // The same api-key caller can read / list / mutate their skill.
    const got = await ok<{ skill: { id: string } }>(
      await dispatchAs("skillhub/get", { id: created.skill.id }, apiKeyCtx),
    );
    expect(got.skill.id).toBe(created.skill.id);

    // A *different* api-key for the same user (e.g. after rotation) still
    // sees the skill, because ownership is anchored to the user id.
    const rotatedKeyCtx: TenantContext = { ...apiKeyCtx, userId: "ak-rotated" };
    const got2 = await ok<{ skill: { id: string } }>(
      await dispatchAs("skillhub/get", { id: created.skill.id }, rotatedKeyCtx),
    );
    expect(got2.skill.id).toBe(created.skill.id);

    // A *different* user's api-key (different scopingUserId) cannot see it -
    // existence-leak defense via visibility filter.
    const bob = await seedUser("bob-apikey@example.com");
    const bobKeyCtx: TenantContext = { ...apiKeyCtx, userId: "ak-bob", scopingUserId: bob.id };
    const refuse = await dispatchAs("skillhub/get", { id: created.skill.id }, bobKeyCtx);
    expect(errOf(refuse).code).toBe(ErrorCodes.NOT_FOUND);
  });

  it("service api-key (no bound user) -> FORBIDDEN on user-scope create", async () => {
    const serviceCtx: TenantContext = {
      tenantId: "default",
      userId: "ak-service",
      role: "admin",
      isAdmin: true,
      scopingUserId: null,
      teamChain: [],
    };
    const res = await dispatchAs("skillhub/put", userCreatePayload({ name: "svc-user-scope" }), serviceCtx);
    expect(errOf(res).code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("missing required fields in create -> INVALID_PARAMS", async () => {
    const alice = await seedUser("alice-missing@example.com");
    const ctx = memberCtx("default", alice.id);
    const cases = [
      { body: "x", harness: "claude", name: "x", description: "d" }, // missing visibility
      { body: "x", harness: "claude", visibility: "user", description: "d" }, // missing name
      { body: "x", harness: "claude", visibility: "user", name: "x" }, // missing description
    ];
    for (const params of cases) {
      const res = await dispatchAs("skillhub/put", params, ctx);
      expect(errOf(res).code).toBe(ErrorCodes.INVALID_PARAMS);
    }
  });
});

// ── skillhub/put — normalization on create ────────────────────────────────

describe("skillhub/put — normalization", () => {
  it("normalizes Claude tokens; preserves raw under harness_hints.claude.original_body when changed", async () => {
    const alice = await seedUser("alice-norm@example.com");
    const ctx = memberCtx("default", alice.id);
    const res = await ok<{
      skill: { body: string; harness_hints: Record<string, Record<string, unknown>> };
    }>(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({
          name: "norm-test",
          body: "Run $ARGUMENTS[0] in $ARGUMENTS[1].",
          harness_hints: { claude: { "disable-model-invocation": true } },
        }),
        ctx,
      ),
    );
    // Body is the canonical form (Claude tokens replaced).
    expect(res.skill.body).toBe("Run <the first argument> in <the second argument>.");
    // Raw original_body preserved under the claude harness's hints, since
    // normalization changed something. Existing hints are preserved too.
    expect(res.skill.harness_hints.claude).toMatchObject({
      "disable-model-invocation": true,
      original_body: "Run $ARGUMENTS[0] in $ARGUMENTS[1].",
    });
  });

  it("does NOT add original_body when body is already canonical", async () => {
    const alice = await seedUser("alice-already-canonical@example.com");
    const ctx = memberCtx("default", alice.id);
    const res = await ok<{ skill: { body: string; harness_hints: Record<string, Record<string, unknown>> } }>(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ name: "canon-test", body: "Plain canonical body, no tokens." }),
        ctx,
      ),
    );
    expect(res.skill.body).toBe("Plain canonical body, no tokens.");
    // claude entry exists (from the request's harness_hints={}); but no
    // original_body since canonical === raw.
    expect(res.skill.harness_hints.claude?.original_body).toBeUndefined();
  });
});

// ── skillhub/put — update ─────────────────────────────────────────────────

describe("skillhub/put — update", () => {
  it("happy path: bumps current_hash; preserves visibility/scoping from existing row", async () => {
    const alice = await seedUser("alice-update@example.com");
    const ctx = memberCtx("default", alice.id);
    const v1 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-skill", body: "v1" }), ctx),
    );
    const v2 = await ok<{ skill: { id: string; current_hash: string; body: string }; version_written: boolean }>(
      await dispatchAs(
        "skillhub/put",
        {
          skill_id: v1.skill.id,
          expected_current_hash: v1.skill.current_hash,
          harness: "claude",
          body: "v2",
          supporting_files: [],
        },
        ctx,
      ),
    );
    expect(v2.skill.id).toBe(v1.skill.id);
    expect(v2.skill.body).toBe("v2");
    expect(v2.skill.current_hash).not.toBe(v1.skill.current_hash);
    expect(v2.version_written).toBe(true);
  });

  it("missing expected_current_hash on non-force update -> INVALID_PARAMS", async () => {
    const alice = await seedUser("alice-no-hash@example.com");
    const ctx = memberCtx("default", alice.id);
    const v1 = await ok<{ skill: { id: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-skill" }), ctx),
    );
    const res = await dispatchAs(
      "skillhub/put",
      { skill_id: v1.skill.id, harness: "claude", body: "v2", supporting_files: [] },
      ctx,
    );
    expect(errOf(res).code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it("stale expected_current_hash -> CONFLICT", async () => {
    const alice = await seedUser("alice-cas@example.com");
    const ctx = memberCtx("default", alice.id);
    const v1 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-skill", body: "v1" }), ctx),
    );
    // Concurrent winner.
    await ok(
      await dispatchAs(
        "skillhub/put",
        {
          skill_id: v1.skill.id,
          expected_current_hash: v1.skill.current_hash,
          harness: "claude",
          body: "winner",
          supporting_files: [],
        },
        ctx,
      ),
    );
    // Loser carrying stale hash.
    const res = await dispatchAs(
      "skillhub/put",
      {
        skill_id: v1.skill.id,
        expected_current_hash: v1.skill.current_hash,
        harness: "claude",
        body: "loser",
        supporting_files: [],
      },
      ctx,
    );
    expect(errOf(res).code).toBe(ErrorCodes.CONFLICT);
  });

  it("force=true bypasses CAS for ownership-passing caller (user-scope)", async () => {
    const alice = await seedUser("alice-force@example.com");
    const ctx = memberCtx("default", alice.id);
    const v1 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-skill", body: "v1" }), ctx),
    );
    // Server advances to v2.
    await ok(
      await dispatchAs(
        "skillhub/put",
        {
          skill_id: v1.skill.id,
          expected_current_hash: v1.skill.current_hash,
          harness: "claude",
          body: "v2",
          supporting_files: [],
        },
        ctx,
      ),
    );
    // Alice (owner) forces with the original stale hash; should succeed.
    const v3 = await ok<{ skill: { body: string } }>(
      await dispatchAs(
        "skillhub/put",
        {
          skill_id: v1.skill.id,
          expected_current_hash: v1.skill.current_hash, // stale
          force: true,
          harness: "claude",
          body: "alice-forced",
          supporting_files: [],
        },
        ctx,
      ),
    );
    expect(v3.skill.body).toBe("alice-forced");
  });

  it("non-owner cannot force on a user-scope skill -> NOT_FOUND (visibility masks)", async () => {
    const alice = await seedUser("alice-victim@example.com");
    const bob = await seedUser("bob-attacker@example.com");
    const v1 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-skill" }), memberCtx("default", alice.id)),
    );
    // Bob tries to force-overwrite Alice's user-scope skill.
    const res = await dispatchAs(
      "skillhub/put",
      {
        skill_id: v1.skill.id,
        force: true,
        harness: "claude",
        body: "hijacked",
        supporting_files: [],
      },
      memberCtx("default", bob.id),
    );
    // Visibility masks: bob can't even see alice's user-scope skill.
    expect(errOf(res).code).toBe(ErrorCodes.NOT_FOUND);
  });

  it("non-admin cannot force on a team-scope skill -> FORBIDDEN", async () => {
    const tenant = await seedTenant("acme-team-force");
    const team = await seedTeam(tenant.id, "eng");
    const admin = await seedUser("admin-team-force@example.com");
    const member = await seedUser("member-team-force@example.com");
    const v1 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "team", team_id: team.id, name: "team-skill" }),
        adminCtx(tenant.id, admin.id, [team.id]),
      ),
    );
    // Non-admin member of the same team tries to force.
    const res = await dispatchAs(
      "skillhub/put",
      {
        skill_id: v1.skill.id,
        force: true,
        harness: "claude",
        body: "hijacked",
        supporting_files: [],
      },
      memberCtx(tenant.id, member.id, [team.id]),
    );
    expect(errOf(res).code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("empty-string name/description does NOT nuke existing values on update", async () => {
    const alice = await seedUser("alice-empty@example.com");
    const ctx = memberCtx("default", alice.id);
    const v1 = await ok<{ skill: { id: string; name: string; description: string; current_hash: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-skill", description: "Original desc" }), ctx),
    );
    const v2 = await ok<{ skill: { name: string; description: string } }>(
      await dispatchAs(
        "skillhub/put",
        {
          skill_id: v1.skill.id,
          expected_current_hash: v1.skill.current_hash,
          harness: "claude",
          body: "body change only",
          supporting_files: [],
          name: "", // attempt to nuke
          description: "   ", // whitespace-only attempt to nuke
        },
        ctx,
      ),
    );
    expect(v2.skill.name).toBe("alice-skill");
    expect(v2.skill.description).toBe("Original desc");
  });

  it("visibility change via update -> UNSUPPORTED (v1 limitation)", async () => {
    const alice = await seedUser("alice-promote@example.com");
    const ctx = memberCtx("default", alice.id);
    const v1 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-skill" }), ctx),
    );
    const res = await dispatchAs(
      "skillhub/put",
      {
        skill_id: v1.skill.id,
        expected_current_hash: v1.skill.current_hash,
        harness: "claude",
        body: "body",
        supporting_files: [],
        visibility: "tenant", // attempting to promote user -> tenant
      },
      ctx,
    );
    expect(errOf(res).code).toBe(ErrorCodes.UNSUPPORTED);
  });

  it("merge_input passthrough: CLI-supplied audit blob lands on the new skill_versions row", async () => {
    // After a client-side 3-way merge (RFC §7), the CLI attaches a
    // merge_input blob to skillhub/put so the audit trail captures
    // provenance (which LLM, which ancestor, per-file strategies).
    // Verify the handler forwards it to skill_versions.merge_input_json.
    const alice = await seedUser("alice-merge-input@example.com");
    const ctx = memberCtx("default", alice.id);
    const v1 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-merged", body: "v1" }), ctx),
    );
    const mergeInput = {
      ancestor_hash: v1.skill.current_hash,
      mine_hash: "mine-h",
      theirs_hash: "theirs-h",
      llm_model: "claude-sonnet-4-6",
      per_file_strategies: { "SKILL.md": "llm" },
      accepted_by: alice.id,
    };
    const v2 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs(
        "skillhub/put",
        {
          skill_id: v1.skill.id,
          expected_current_hash: v1.skill.current_hash,
          harness: "claude",
          body: "v2 (merged)",
          supporting_files: [],
          merge_input: mergeInput,
        },
        ctx,
      ),
    );
    // Verify the version row carries the merge metadata.
    const version = await app.skillVersions.getByHash(v2.skill.id, v2.skill.current_hash);
    expect(version).not.toBeNull();
    expect(version!.merge_input_json).toEqual(mergeInput);
  });
});

// ── skillhub/list — visibility ────────────────────────────────────────────

describe("skillhub/list — visibility", () => {
  it("returns only caller's user-scope rows + accessible team/tenant rows", async () => {
    const tenant = await seedTenant("acme-list");
    const team = await seedTeam(tenant.id, "eng");
    const alice = await seedUser("alice-list@example.com");
    const bob = await seedUser("bob-list@example.com");
    const admin = await seedUser("admin-list@example.com");

    // Alice's user-scope skill (tenant-agnostic, consultant pattern).
    await ok(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-personal" }), memberCtx(tenant.id, alice.id)),
    );
    // Bob's user-scope skill in same tenant.
    await ok(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "bob-personal" }), memberCtx(tenant.id, bob.id)),
    );
    // Team-scope skill via admin.
    await ok(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "team", team_id: team.id, name: "team-eng-shared" }),
        adminCtx(tenant.id, admin.id, [team.id]),
      ),
    );
    // Tenant-scope skill via admin.
    await ok(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "tenant", name: "tenant-shared" }),
        adminCtx(tenant.id, admin.id),
      ),
    );

    // Alice (in team) sees: alice-personal + team-eng-shared + tenant-shared.
    // She does NOT see bob-personal.
    const aliceList = await ok<{ skills: { name: string }[] }>(
      await dispatchAs("skillhub/list", {}, memberCtx(tenant.id, alice.id, [team.id])),
    );
    expect(aliceList.skills.map((s) => s.name).sort()).toEqual(["alice-personal", "team-eng-shared", "tenant-shared"]);

    // Bob (NOT in team) sees: bob-personal + tenant-shared.
    const bobList = await ok<{ skills: { name: string }[] }>(
      await dispatchAs("skillhub/list", {}, memberCtx(tenant.id, bob.id)),
    );
    expect(bobList.skills.map((s) => s.name).sort()).toEqual(["bob-personal", "tenant-shared"]);
  });

  it("consultant pattern: user-scope skills follow user across tenants", async () => {
    const tenantA = await seedTenant("acme-consult-a");
    const tenantB = await seedTenant("acme-consult-b");
    const alice = await seedUser("alice-consult@example.com");
    // Alice creates her user-scope skill while authenticated in tenant A.
    await ok(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ name: "alice-everywhere" }),
        memberCtx(tenantA.id, alice.id),
      ),
    );
    // Alice authenticated in tenant B - should still see her own skill.
    const listInB = await ok<{ skills: { name: string }[] }>(
      await dispatchAs("skillhub/list", {}, memberCtx(tenantB.id, alice.id)),
    );
    expect(listInB.skills.map((s) => s.name)).toEqual(["alice-everywhere"]);
  });

  it("strict isolation: tenant-scope rows do NOT leak across tenants", async () => {
    const tenantA = await seedTenant("acme-iso-a");
    const tenantB = await seedTenant("acme-iso-b");
    const adminA = await seedUser("admin-iso-a@example.com");
    const userB = await seedUser("user-iso-b@example.com");
    await ok(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "tenant", name: "tenant-a-only" }),
        adminCtx(tenantA.id, adminA.id),
      ),
    );
    const listInB = await ok<{ skills: { name: string }[] }>(
      await dispatchAs("skillhub/list", {}, memberCtx(tenantB.id, userB.id)),
    );
    expect(listInB.skills.map((s) => s.name)).toEqual([]);
  });
});

// ── skillhub/get ──────────────────────────────────────────────────────────

describe("skillhub/get", () => {
  it("returns the skill when visible", async () => {
    const alice = await seedUser("alice-get@example.com");
    const ctx = memberCtx("default", alice.id);
    const v1 = await ok<{ skill: { id: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-skill" }), ctx),
    );
    const got = await ok<{ skill: { id: string; name: string } }>(
      await dispatchAs("skillhub/get", { id: v1.skill.id }, ctx),
    );
    expect(got.skill.id).toBe(v1.skill.id);
    expect(got.skill.name).toBe("alice-skill");
  });

  it("masks invisible skills as NOT_FOUND (don't leak existence)", async () => {
    const alice = await seedUser("alice-mask@example.com");
    const bob = await seedUser("bob-mask@example.com");
    const v1 = await ok<{ skill: { id: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-private" }), memberCtx("default", alice.id)),
    );
    const res = await dispatchAs("skillhub/get", { id: v1.skill.id }, memberCtx("default", bob.id));
    expect(errOf(res).code).toBe(ErrorCodes.NOT_FOUND);
  });

  it("non-existent id -> NOT_FOUND", async () => {
    const alice = await seedUser("alice-404@example.com");
    const res = await dispatchAs("skillhub/get", { id: "skl-doesnotexist" }, memberCtx("default", alice.id));
    expect(errOf(res).code).toBe(ErrorCodes.NOT_FOUND);
  });
});

// ── skillhub/sync_status ──────────────────────────────────────────────────

describe("skillhub/sync_status", () => {
  it("up-to-date / server-changed / unknown / not-found", async () => {
    const alice = await seedUser("alice-sync@example.com");
    const bob = await seedUser("bob-sync@example.com");
    const ctxAlice = memberCtx("default", alice.id);
    const ctxBob = memberCtx("default", bob.id);
    const v1 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-skill" }), ctxAlice),
    );
    // bob also has a skill alice can't see.
    const bobSkill = await ok<{ skill: { id: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "bob-skill" }), ctxBob),
    );

    const res = await ok<{
      results: { skill_id: string; status: string; server_hash: string | null }[];
    }>(
      await dispatchAs(
        "skillhub/sync_status",
        {
          local_versions: [
            { skill_id: v1.skill.id, local_hash: v1.skill.current_hash }, // up-to-date
            { skill_id: v1.skill.id, local_hash: "deadbeef".repeat(8) }, // server-changed
            { skill_id: v1.skill.id }, // unknown (missing local_hash)
            { skill_id: bobSkill.skill.id, local_hash: "anything" }, // not-found (invisible)
            { skill_id: "skl-missing", local_hash: "x" }, // not-found (doesn't exist)
          ],
        },
        ctxAlice,
      ),
    );

    expect(res.results.map((r) => r.status)).toEqual([
      "up-to-date",
      "server-changed",
      "unknown",
      "not-found",
      "not-found",
    ]);
  });
});

// ── skillhub/get_with_ancestor ────────────────────────────────────────────

describe("skillhub/get_with_ancestor", () => {
  it("without ancestor_hash returns only server fields", async () => {
    const alice = await seedUser("alice-anc-1@example.com");
    const ctx = memberCtx("default", alice.id);
    const v1 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({
          name: "alice-anc-1",
          body: "v1 body",
          supporting_files: [{ path: "refs/spec.md", content: "v1 spec" }],
        }),
        ctx,
      ),
    );
    const got = await ok<Record<string, unknown>>(
      await dispatchAs("skillhub/get_with_ancestor", { skill_id: v1.skill.id }, ctx),
    );
    expect(got.server_body).toBe("v1 body");
    expect(got.server_supporting_files).toEqual([{ path: "refs/spec.md", content: "v1 spec" }]);
    // Skill metadata (needed by CLI adapter.render so SKILL.md
    // frontmatter has a non-empty description on FF-pull / merge-accept).
    expect(got.server_name).toBe("alice-anc-1");
    expect(got.server_description).toBe("A test skill");
    expect(got.server_category).toBeNull();
    expect(got.server_tags).toEqual([]);
    expect(got.server_hash).toBe(v1.skill.current_hash);
    expect(got.ancestor_body).toBeUndefined();
    expect(got.ancestor_supporting_files).toBeUndefined();
  });

  it("with ancestor_hash returns both current and ancestor bundles", async () => {
    const alice = await seedUser("alice-anc-2@example.com");
    const ctx = memberCtx("default", alice.id);
    const v1 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({
          name: "alice-anc-2",
          body: "v1 body",
          supporting_files: [{ path: "refs/spec.md", content: "v1 spec" }],
        }),
        ctx,
      ),
    );
    const v2 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs(
        "skillhub/put",
        {
          skill_id: v1.skill.id,
          expected_current_hash: v1.skill.current_hash,
          harness: "claude",
          body: "v2 body",
          supporting_files: [{ path: "refs/spec.md", content: "v2 spec" }],
        },
        ctx,
      ),
    );
    const got = await ok<Record<string, unknown>>(
      await dispatchAs(
        "skillhub/get_with_ancestor",
        { skill_id: v1.skill.id, ancestor_hash: v1.skill.current_hash },
        ctx,
      ),
    );
    expect(got.server_body).toBe("v2 body");
    expect(got.server_hash).toBe(v2.skill.current_hash);
    expect(got.ancestor_body).toBe("v1 body");
    expect(got.ancestor_supporting_files).toEqual([{ path: "refs/spec.md", content: "v1 spec" }]);
    expect(got.ancestor_hash).toBe(v1.skill.current_hash);
  });

  it("ancestor_hash supplied but not found -> NOT_FOUND", async () => {
    const alice = await seedUser("alice-anc-3@example.com");
    const ctx = memberCtx("default", alice.id);
    const v1 = await ok<{ skill: { id: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-anc-3" }), ctx),
    );
    const res = await dispatchAs(
      "skillhub/get_with_ancestor",
      { skill_id: v1.skill.id, ancestor_hash: "deadbeef".repeat(8) },
      ctx,
    );
    expect(errOf(res).code).toBe(ErrorCodes.NOT_FOUND);
  });
});

// ── skillhub/delete ───────────────────────────────────────────────────────

describe("skillhub/delete", () => {
  it("user-scope: owner can delete; non-owner gets NOT_FOUND", async () => {
    const alice = await seedUser("alice-del@example.com");
    const bob = await seedUser("bob-del@example.com");
    const v1 = await ok<{ skill: { id: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-del-skill" }), memberCtx("default", alice.id)),
    );
    // Bob can't see it, so delete masks to NOT_FOUND.
    const denied = await dispatchAs("skillhub/delete", { id: v1.skill.id }, memberCtx("default", bob.id));
    expect(errOf(denied).code).toBe(ErrorCodes.NOT_FOUND);

    // Alice can delete.
    const ok1 = await ok<{ ok: boolean }>(
      await dispatchAs("skillhub/delete", { id: v1.skill.id }, memberCtx("default", alice.id)),
    );
    expect(ok1.ok).toBe(true);

    // Idempotent second delete from alice now sees the soft-deleted row
    // as invisible -> NOT_FOUND, which matches "can't find live row".
    const again = await dispatchAs("skillhub/delete", { id: v1.skill.id }, memberCtx("default", alice.id));
    expect(errOf(again).code).toBe(ErrorCodes.NOT_FOUND);
  });

  it("team-scope: non-admin in team -> FORBIDDEN; admin -> ok", async () => {
    const tenant = await seedTenant("acme-del-team");
    const team = await seedTeam(tenant.id, "eng");
    const admin = await seedUser("admin-del-team@example.com");
    const member = await seedUser("member-del-team@example.com");
    const v1 = await ok<{ skill: { id: string } }>(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "team", team_id: team.id, name: "team-del-skill" }),
        adminCtx(tenant.id, admin.id, [team.id]),
      ),
    );
    const denied = await dispatchAs("skillhub/delete", { id: v1.skill.id }, memberCtx(tenant.id, member.id, [team.id]));
    expect(errOf(denied).code).toBe(ErrorCodes.FORBIDDEN);
    const ok1 = await ok<{ ok: boolean }>(
      await dispatchAs("skillhub/delete", { id: v1.skill.id }, adminCtx(tenant.id, admin.id, [team.id])),
    );
    expect(ok1.ok).toBe(true);
  });
});

// ── skillhub/search ───────────────────────────────────────────────────────

describe("skillhub/search", () => {
  it("matches against name, description, and tags within visible scope", async () => {
    const alice = await seedUser("alice-search@example.com");
    const ctx = memberCtx("default", alice.id);
    await ok(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ name: "code-review", description: "linting + style", tags: ["lint"] }),
        ctx,
      ),
    );
    await ok(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ name: "design-doc", description: "drafts a design doc", tags: ["writing"] }),
        ctx,
      ),
    );
    await ok(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ name: "deploy", description: "deploys to prod", tags: ["devops", "code"] }),
        ctx,
      ),
    );

    // Substring match on name.
    const r1 = await ok<{ skills: { name: string }[] }>(await dispatchAs("skillhub/search", { query: "design" }, ctx));
    expect(r1.skills.map((s) => s.name)).toEqual(["design-doc"]);

    // Substring match on description.
    const r2 = await ok<{ skills: { name: string }[] }>(await dispatchAs("skillhub/search", { query: "linting" }, ctx));
    expect(r2.skills.map((s) => s.name)).toEqual(["code-review"]);

    // Substring match on tag - hits two via name AND tag.
    const r3 = await ok<{ skills: { name: string }[] }>(await dispatchAs("skillhub/search", { query: "code" }, ctx));
    expect(r3.skills.map((s) => s.name).sort()).toEqual(["code-review", "deploy"]);

    // Case-insensitive.
    const r4 = await ok<{ skills: { name: string }[] }>(await dispatchAs("skillhub/search", { query: "DESIGN" }, ctx));
    expect(r4.skills.map((s) => s.name)).toEqual(["design-doc"]);
  });

  it("respects visibility: another user's user-scope skills do not appear", async () => {
    const alice = await seedUser("alice-search-iso@example.com");
    const bob = await seedUser("bob-search-iso@example.com");
    await ok(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ name: "alice-private", description: "secret" }),
        memberCtx("default", alice.id),
      ),
    );
    const res = await ok<{ skills: { name: string }[] }>(
      await dispatchAs("skillhub/search", { query: "alice" }, memberCtx("default", bob.id)),
    );
    expect(res.skills).toEqual([]);
  });
});

// ── skillhub/published_after ──────────────────────────────────────────────

describe("skillhub/published_after", () => {
  it("returns only skills updated_at >= since, within visible scope", async () => {
    const alice = await seedUser("alice-pub-after@example.com");
    const ctx = memberCtx("default", alice.id);

    // Create one skill, capture its updated_at.
    const v1 = await ok<{ skill: { id: string; updated_at: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "older" }), ctx),
    );
    // Force a strict time gap so the second skill's updated_at is
    // unambiguously later. ISO timestamps tick at millisecond resolution;
    // we need >0ms between writes for the comparison to be deterministic
    // on fast hardware.
    await Bun.sleep(5);
    const v2 = await ok<{ skill: { id: string; updated_at: string } }>(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "newer" }), ctx),
    );

    // since = v2.updated_at -> only v2 matches.
    const r1 = await ok<{ skills: { id: string }[] }>(
      await dispatchAs("skillhub/published_after", { since: v2.skill.updated_at }, ctx),
    );
    expect(r1.skills.map((s) => s.id)).toEqual([v2.skill.id]);

    // since = v1.updated_at -> both match, ordered newest-first.
    const r2 = await ok<{ skills: { id: string }[] }>(
      await dispatchAs("skillhub/published_after", { since: v1.skill.updated_at }, ctx),
    );
    expect(r2.skills.map((s) => s.id)).toEqual([v2.skill.id, v1.skill.id]);

    // since far in the future -> empty.
    const r3 = await ok<{ skills: unknown[] }>(
      await dispatchAs("skillhub/published_after", { since: "9999-01-01T00:00:00Z" }, ctx),
    );
    expect(r3.skills).toEqual([]);
  });
});

// ── admin/skillhub/list ───────────────────────────────────────────────────

describe("admin/skillhub/list", () => {
  it("non-admin -> FORBIDDEN", async () => {
    const tenant = await seedTenant("acme-admin-list-gate");
    const alice = await seedUser("alice-admin-list-gate@example.com");
    const res = await dispatchAs("admin/skillhub/list", {}, memberCtx(tenant.id, alice.id));
    expect(errOf(res).code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("admin sees every team-scope and tenant-scope skill in their tenant, regardless of team-chain", async () => {
    const tenant = await seedTenant("acme-admin-list");
    const teamA = await seedTeam(tenant.id, "team-a");
    const teamB = await seedTeam(tenant.id, "team-b");
    const admin = await seedUser("admin-list@example.com");

    // Admin (in team-a only) creates skills across both teams + tenant scope.
    await ok(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "team", team_id: teamA.id, name: "team-a-skill" }),
        adminCtx(tenant.id, admin.id, [teamA.id]),
      ),
    );
    await ok(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "team", team_id: teamB.id, name: "team-b-skill" }),
        adminCtx(tenant.id, admin.id, [teamA.id]),
      ),
    );
    await ok(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "tenant", name: "tenant-skill" }),
        adminCtx(tenant.id, admin.id),
      ),
    );

    // Admin queries the cross-team list (chain has only team-a, but
    // admin/* surface should not be team-chain-gated).
    const res = await ok<{ skills: { name: string; visibility: string }[] }>(
      await dispatchAs("admin/skillhub/list", {}, adminCtx(tenant.id, admin.id, [teamA.id])),
    );
    expect(res.skills.map((s) => s.name).sort()).toEqual(["team-a-skill", "team-b-skill", "tenant-skill"]);
  });

  it("excludes user-scope skills (those follow the user across tenants, not bound to one)", async () => {
    const tenant = await seedTenant("acme-admin-list-userscope");
    const alice = await seedUser("alice-admin-list-userscope@example.com");
    const admin = await seedUser("admin-list-userscope@example.com");

    // Alice creates a user-scope skill while authenticated in this tenant.
    await ok(
      await dispatchAs("skillhub/put", userCreatePayload({ name: "alice-private" }), memberCtx(tenant.id, alice.id)),
    );
    // Admin queries cross-team list - should NOT see alice's user-scope row.
    const res = await ok<{ skills: { name: string }[] }>(
      await dispatchAs("admin/skillhub/list", {}, adminCtx(tenant.id, admin.id)),
    );
    expect(res.skills.map((s) => s.name)).toEqual([]);
  });

  it("strict tenant isolation: admin does NOT see skills from another tenant", async () => {
    const tenantA = await seedTenant("acme-admin-iso-a");
    const tenantB = await seedTenant("acme-admin-iso-b");
    const adminA = await seedUser("admin-iso-a@example.com");
    const adminB = await seedUser("admin-iso-b@example.com");
    await ok(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "tenant", name: "tenant-a-skill" }),
        adminCtx(tenantA.id, adminA.id),
      ),
    );
    const res = await ok<{ skills: { name: string }[] }>(
      await dispatchAs("admin/skillhub/list", {}, adminCtx(tenantB.id, adminB.id)),
    );
    expect(res.skills.map((s) => s.name)).toEqual([]);
  });
});

// ── admin/skillhub/version_history ────────────────────────────────────────

describe("admin/skillhub/version_history", () => {
  it("non-admin -> FORBIDDEN", async () => {
    const tenant = await seedTenant("acme-hist-gate");
    const alice = await seedUser("alice-hist-gate@example.com");
    const res = await dispatchAs(
      "admin/skillhub/version_history",
      { skill_id: "skl-x" },
      memberCtx(tenant.id, alice.id),
    );
    expect(errOf(res).code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("returns the skill_versions list newest-first for an in-tenant skill", async () => {
    const tenant = await seedTenant("acme-hist-history");
    const admin = await seedUser("admin-hist@example.com");
    const v1 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "tenant", name: "history-skill", body: "v1" }),
        adminCtx(tenant.id, admin.id),
      ),
    );
    const v2 = await ok<{ skill: { id: string; current_hash: string } }>(
      await dispatchAs(
        "skillhub/put",
        {
          skill_id: v1.skill.id,
          expected_current_hash: v1.skill.current_hash,
          harness: "claude",
          body: "v2",
          supporting_files: [],
        },
        adminCtx(tenant.id, admin.id),
      ),
    );
    const res = await ok<{ versions: { version_hash: string; body: string }[] }>(
      await dispatchAs("admin/skillhub/version_history", { skill_id: v1.skill.id }, adminCtx(tenant.id, admin.id)),
    );
    expect(res.versions.length).toBe(2);
    expect(res.versions[0].body).toBe("v2"); // newest first
    expect(res.versions[1].body).toBe("v1");
    expect(res.versions[0].version_hash).toBe(v2.skill.current_hash);
    expect(res.versions[1].version_hash).toBe(v1.skill.current_hash);
  });

  it("refuses cross-tenant access: admin in tenant B cannot read tenant A's history", async () => {
    const tenantA = await seedTenant("acme-hist-iso-a");
    const tenantB = await seedTenant("acme-hist-iso-b");
    const adminA = await seedUser("admin-hist-iso-a@example.com");
    const adminB = await seedUser("admin-hist-iso-b@example.com");
    const v1 = await ok<{ skill: { id: string } }>(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "tenant", name: "iso-skill" }),
        adminCtx(tenantA.id, adminA.id),
      ),
    );
    const res = await dispatchAs(
      "admin/skillhub/version_history",
      { skill_id: v1.skill.id },
      adminCtx(tenantB.id, adminB.id),
    );
    expect(errOf(res).code).toBe(ErrorCodes.NOT_FOUND);
  });

  it("refuses user-scope skills (their tenant_id is NULL by the consultant pattern)", async () => {
    const tenant = await seedTenant("acme-hist-userscope");
    const alice = await seedUser("alice-hist-userscope@example.com");
    const admin = await seedUser("admin-hist-userscope@example.com");
    const v1 = await ok<{ skill: { id: string } }>(
      await dispatchAs(
        "skillhub/put",
        userCreatePayload({ visibility: "user", name: "alice-personal" }),
        memberCtx(tenant.id, alice.id),
      ),
    );
    // Admin in same tenant - still refused because user-scope skills
    // don't belong to a tenant.
    const res = await dispatchAs(
      "admin/skillhub/version_history",
      { skill_id: v1.skill.id },
      adminCtx(tenant.id, admin.id),
    );
    expect(errOf(res).code).toBe(ErrorCodes.NOT_FOUND);
  });
});
