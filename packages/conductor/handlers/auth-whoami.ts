/**
 * `auth/whoami` -- identity-only RPC for the web UI.
 *
 * Returns the caller's `{ userId, email, tenantId, role }` resolved from
 * the request's TenantContext. The Phase 1 web dashboard calls this
 * once at boot to populate the user-menu / identity widget; subsequent
 * RPCs can rely on the same context.
 *
 * IMPORTANT: this handler does NOT report deployment configuration
 * (whether Google OIDC is wired, etc.). It answers "who am I?" and
 * nothing else. Coupling identity to config-discovery here would
 * complicate `whoami`'s contract and make the response shape
 * deployment-dependent. Surface that information through a separate
 * route if a future need arises.
 *
 * Anonymous detection uses `ctx.userId === null` -- the explicit
 * signal set by `anonymousContext()` in `core/auth/context.ts`. It is
 * NOT the `tenantId === "anonymous"` sentinel: that sentinel is a
 * formatting artifact of how the wire-context is shaped today, and
 * comparing against it would couple identity logic to a string we may
 * change. `userId === null` is the durable contract.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { actorIdentity } from "../../core/auth/context.js";

export interface WhoAmIResponse {
  userId: string;
  email: string | null;
  tenantId: string;
  role: "admin" | "member" | "viewer";
}

export function registerAuthWhoamiHandlers(router: Router, app: AppContext): void {
  router.handle("auth/whoami", async (_p, _notify, ctx) => {
    // Anonymous caller -- no identity to surface. The web UI treats
    // this as "show the login page".
    if (ctx.userId === null) {
      return { identity: null };
    }
    // Local-mode synthetic admin (`localAdminContext`) sets
    // `userId: "local"` -- there's no DB row to look up. Return the
    // fixed identity directly so single-user dev still works.
    if (ctx.userId === "local") {
      return {
        identity: {
          userId: "local",
          email: null,
          tenantId: ctx.tenantId,
          role: ctx.role,
        } satisfies WhoAmIResponse,
      };
    }
    // Bearer + cookie paths: look up the user row for the email.
    // Use `actorIdentity` so api-key callers (userId === "ak-*" but
    // scopingUserId === "u-*") resolve to the real user row instead of
    // showing the key sentinel as the logged-in identity.
    const realId = actorIdentity(ctx)!;
    const user = await app.users.get(realId);
    return {
      identity: {
        userId: realId,
        email: user?.email ?? null,
        tenantId: ctx.tenantId,
        role: ctx.role,
      } satisfies WhoAmIResponse,
    };
  });
}
