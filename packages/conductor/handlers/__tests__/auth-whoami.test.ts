/**
 * auth/whoami handler tests.
 *
 * Anonymous detection MUST key off `ctx.userId === null`, never the
 * `tenantId === "anonymous"` sentinel string. These tests pin the
 * contract.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerAuthWhoamiHandlers } from "../auth-whoami.js";
import { createRequest, type JsonRpcResponse } from "../../../protocol/types.js";
import { anonymousContext, localAdminContext, type TenantContext } from "../../../core/auth/context.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerAuthWhoamiHandlers(router, app);
});

function dispatchAs(ctx: TenantContext) {
  return router.dispatch(createRequest(1, "auth/whoami", {}), undefined, ctx);
}

interface WhoAmIResult {
  identity: {
    userId: string;
    email: string | null;
    tenantId: string;
    role: string;
  } | null;
}

describe("auth/whoami", () => {
  it("returns identity=null for anonymous context", async () => {
    const res = (await dispatchAs(anonymousContext())) as JsonRpcResponse;
    expect((res.result as WhoAmIResult).identity).toBeNull();
  });

  it("uses ctx.userId === null for anonymous detection (NOT tenantId === 'anonymous')", async () => {
    // Construct a context that has tenantId "anonymous" but a non-null
    // userId -- the handler should NOT treat this as anonymous, because
    // the contract is keyed off userId, not the tenantId sentinel.
    const weirdCtx: TenantContext = {
      tenantId: "anonymous",
      userId: "u-real",
      role: "member",
      isAdmin: false,
    };
    const res = (await dispatchAs(weirdCtx)) as JsonRpcResponse;
    const ident = (res.result as WhoAmIResult).identity;
    expect(ident).not.toBeNull();
    expect(ident!.userId).toBe("u-real");
    expect(ident!.tenantId).toBe("anonymous");
  });

  it("returns synthetic identity for local-mode admin (userId='local'), no DB lookup", async () => {
    const admin = localAdminContext("default");
    const res = (await dispatchAs(admin)) as JsonRpcResponse;
    const ident = (res.result as WhoAmIResult).identity!;
    expect(ident.userId).toBe("local");
    expect(ident.email).toBeNull();
    expect(ident.tenantId).toBe("default");
    expect(ident.role).toBe("admin");
  });

  it("looks up the user row and returns email for a real user (cookie / bearer path)", async () => {
    const tenant = await app.tenants.create({ slug: "ocl-whoami", name: "OCL" });
    const team = await app.teams.create({ tenant_id: tenant.id, slug: "agentic-whoami", name: "Agentic" });
    const user = await app.users.create({ email: "alice@paytm.com", name: "Alice" });
    await app.teams.addMember(team.id, user.id, "member");

    const realCtx: TenantContext = {
      tenantId: tenant.id,
      userId: user.id,
      role: "member",
      isAdmin: false,
    };
    const res = (await dispatchAs(realCtx)) as JsonRpcResponse;
    const ident = (res.result as WhoAmIResult).identity!;
    expect(ident.userId).toBe(user.id);
    expect(ident.email).toBe("alice@paytm.com");
    expect(ident.tenantId).toBe(tenant.id);
    expect(ident.role).toBe("member");
  });

  it("returns email=null when the user row is missing (defensive: shouldn't happen, but no crash)", async () => {
    const ghostCtx: TenantContext = {
      tenantId: "t-ghost",
      userId: "u-does-not-exist",
      role: "viewer",
      isAdmin: false,
    };
    const res = (await dispatchAs(ghostCtx)) as JsonRpcResponse;
    const ident = (res.result as WhoAmIResult).identity!;
    expect(ident.userId).toBe("u-does-not-exist");
    expect(ident.email).toBeNull();
  });
});
