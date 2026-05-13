# Auth & Scoping: Operator Reference

End-to-end reference for enabling, using, and operating the Ark auth
stack. Four parts:

1. **Google OIDC login** -- browser users sign in with Google; the
   server mints an HttpOnly cookie session.
2. **Self-service API keys** -- CLI / programmatic users mint and
   revoke their own bearer tokens through the dashboard.
3. **Scoping overrides** -- a single override surface (user / team /
   tenant scoped) for org-level configuration like default flows,
   runtimes, models, and compute targets.
4. **Operations runbook** -- concrete recipes for day-to-day admin
   tasks: bootstrapping a tenant, adding members, setting overrides,
   revoking keys, debugging.

```
            ┌─────────────────┐
            │ Google OIDC     │  Part 1
            │ + cookie session│
            └────────┬────────┘
                     │
                     ▼
            ┌─────────────────┐
            │ Identity gate   │
            │ (cookie or      │  Part 2 (api-key minting)
            │  Bearer)        │
            └────────┬────────┘
                     │
                     ▼
            ┌─────────────────┐
            │ Scoping         │  Part 3
            │ resolver        │
            └─────────────────┘
```

Auth is **opt-in**. Local development with no env vars set runs in
single-user-admin mode and bypasses Parts 1-3 entirely (every request
is treated as an admin in the `default` tenant). Hosted / multi-user
deployments enable auth by setting the env vars in Part 1.

---

## The auth model at a glance

Before the mechanics, the data model. New devs should read this once
and refer back as needed.

```
            ┌─────────┐
            │ tenants │ (identity boundary; everything carries tenant_id)
            └──┬───┬──┘
       1:N FK │   │ 1:N FK
              ▼   ▼
        ┌─────┐  ┌──────────────────┐  ┌───────────────────┐
        │teams│  │     api_keys     │  │ scoping_overrides │
        └──┬──┘  │ tenant_id (FK) + │  │  (per-tenant)     │
           │     │ opt user_id      │  └───────────────────┘
           │     │ (soft pointer)   │
           │     └──────────────────┘
           │ 1:N FK
           ▼
     ┌─────────────┐           ┌────────┐
     │ memberships │──────────►│ users  │  (global, no tenant_id)
     │ (FK team_id)│  N:1 FK   └────────┘
     └─────────────┘
```

The diagram shows the FK structure. Two soft pointers it skips
over (not enforced by the database, enforced by the manager layer):

- `api_keys.user_id` -- nullable. `NULL` = admin-minted "system"
  key not owned by a human user. When set, points at `users.id`.
- `scoping_overrides.scope_id` -- a string that points at one of
  three tables depending on `scope_kind`:
  - `scope_kind = "user"` → `users.id`
  - `scope_kind = "team"` → `teams.id`
  - `scope_kind = "tenant"` → equals `scoping_overrides.tenant_id`

| Table | Owns | Notes |
|---|---|---|
| `tenants` | Identity boundary for the whole product surface | Every row downstream carries `tenant_id`. Seeded `default` tenant is the JIT-signup landing target; protected at the manager layer from update / setStatus / delete. |
| `teams` | Belongs to one tenant (`teams.tenant_id`) | The unit of org-chart membership and the anchor for scoping overrides at team scope. Seeded `default-team` lives in `default` tenant; same protection. |
| `users` | Global identities keyed by email | NO direct tenant column -- a user's tenant is **derived** from their team memberships. A user with zero live memberships is a "global orphan" (can't log in until a membership is added). |
| `memberships` | `(user_id, team_id, role)` many-to-many | Live rows enforce a partial unique index on `(user_id, team_id) WHERE deleted_at IS NULL`. Role is one of `owner / admin / member / viewer`. A user can have memberships across multiple tenants -- the **consultant pattern**. |
| `api_keys` | Bearer tokens bound to a `(tenant_id, role)` | Optional `user_id` owner column (`NULL` = admin-tier "system" key). Hashed with SHA-256 on disk; `validate()` is constant-time. |
| `scoping_overrides` | Per-tenant override surface keyed on `(scope_kind, scope_id, key)` | `scope_kind` ∈ `user / team / tenant`. `key` ∈ `runtime / model / compute.default / flow.allowlist`. See Part 3 for resolver semantics. |

### How a request resolves to a `TenantContext`

```
inbound request → bearer token / cookie → ApiKeyManager.validate or
AuthSessionManager.validate → wire TenantContext { tenantId, userId,
role, ... } → router materialises a handler-facing TenantContext
{ ...wire, isAdmin: role === "admin" }
```

Every JSON-RPC handler receives the `TenantContext` as its third
argument. Admin gates use `requireAdmin(ctx)`; cross-tenant gates
use `requireSameTenant(ctx, resourceTenantId)` (defined in
`packages/core/auth/context.ts`). The cross-tenant gate's error
message is intentionally generic -- `"resource belongs to a
different tenant"` -- with no resource id or tenant id echoed, so
a caller probing for valid resource ids cannot learn which tenant
owns one from the rejection.

In local single-user mode the router falls back to
`localAdminContext(defaultTenant)` -- everything passes both gates,
and `ctx.tenantId === defaultTenant`.

> 🔒 **Admin role today is tenant-scoped.** An admin in tenant A
> cannot read or mutate tenant B's resources via the `admin/*`
> JSON-RPC surface. Creating new tenants and moving users between
> tenants are operator-tier operations with no role assigned to
> them yet -- the recipes are direct SQL (see Part 4 §"Create a
> new tenant" / §"Move a user between tenants"). The system-admin
> tier is deferred by design, not a near-term deliverable; every
> `admin/*` route is gated to `ctx.tenantId` until then.

---

# Part 1: Enabling Google OIDC login

## What this gives you

- Users sign in via Google at `http://your-host/` (the dashboard's
  LoginPage renders a "Sign in with Google" button).
- After login, the browser holds an HttpOnly cookie. All
  authenticated RPCs to `/api/rpc` and the WS terminal upgrade use
  the cookie -- no Bearer token to manage in the browser.
- Sessions slide on activity: each active request bumps `expires_at`
  forward by `ttlSec` (default 30 days), gated by
  `refreshThresholdSec` (default 300s) so we don't hammer the DB.
- All credentials check the `Origin` header against the configured
  allowlist for cookie-authed POST / WS upgrades (CSRF defense).

## Env vars

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `ARK_AUTH_REQUIRE_TOKEN` | yes | `false` | Master switch. When `false`, the daemon runs in local-admin mode and ignores both cookies and Bearer tokens. Set to `true` to require a valid cookie or Bearer token on every request. |
| `ARK_AUTH_GOOGLE_CLIENT_ID` | yes (for browser login) | unset | The OAuth 2.0 web-application client ID from Google Cloud Console (e.g. `1234567890-abcdef.apps.googleusercontent.com`). |
| `ARK_AUTH_GOOGLE_CLIENT_SECRET` | yes (for browser login) | unset | The matching client secret. Treat as a secret. |
| `ARK_AUTH_GOOGLE_REDIRECT_URI` | yes (for browser login) | unset | Must match exactly what's configured in the Google OAuth client. Typical values: `http://localhost:5173/auth/google/callback` (dev) or `https://yourhost.com/auth/google/callback` (prod). |
| `ARK_AUTH_GOOGLE_ALLOWED_DOMAINS` | recommended | `paytm.com` (profile default, hardcoded in `packages/core/config/profiles.ts`) | Comma-separated list of email domains permitted to log in (e.g. `paytm.com,paytm.in`). Login fails closed for any other domain. Non-Paytm deployments **must** override this. |
| `ARK_AUTH_SESSION_ALLOWED_ORIGINS` | yes (for browser login) | empty | Comma-separated list of `Origin` header values permitted on cookie-authed POST / WS upgrades. Typically your dashboard's URL(s): `http://localhost:5173,http://localhost:8420`. |
| `ARK_AUTH_SESSION_TTL_SEC` | optional | `2592000` (30d) | Initial cookie lifetime. Sliding refresh extends this on activity. |
| `ARK_AUTH_SESSION_REFRESH_THRESHOLD_SEC` | optional | `300` (5m) | Minimum age of a session before we slide its expiry. Lower = more DB writes; higher = looser sliding. |
| `ARK_AUTH_SESSION_COOKIE_NAME` | optional | `ark_session` | The cookie name. |
| `ARK_AUTH_SESSION_COOKIE_DOMAIN` | optional | unset (host-only) | If you serve the dashboard from a subdomain and want the cookie to span sibling subdomains. |
| `ARK_AUTH_SESSION_COOKIE_SECURE` | optional | `false` | Set to `true` in prod so the cookie only goes over HTTPS. |

For local development, export the env vars in your shell (or a
local-only sourced script that you keep out of git) before starting
the daemon:

```bash
export ARK_AUTH_REQUIRE_TOKEN=true
export ARK_AUTH_GOOGLE_CLIENT_ID="...apps.googleusercontent.com"
export ARK_AUTH_GOOGLE_CLIENT_SECRET="..."
export ARK_AUTH_GOOGLE_REDIRECT_URI="http://localhost:5173/auth/google/callback"
export ARK_AUTH_GOOGLE_ALLOWED_DOMAINS="paytm.com"
export ARK_AUTH_SESSION_ALLOWED_ORIGINS="http://localhost:5173,http://localhost:8420"

ark server daemon start --detach
```

The client_id and client_secret come from the Google Cloud Console
JSON download (next section). Don't commit them to the repo -- treat
the JSON as a secret.

## Setting up the Google OAuth client

You need to do this once per deployment.

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. Pick your project (or create one).
3. Click **Create Credentials → OAuth 2.0 Client IDs**.
4. **Application type**: Web application.
5. **Name**: anything (e.g. "Ark dashboard - dev").
6. **Authorized JavaScript origins**: each origin you list in
   `ARK_AUTH_SESSION_ALLOWED_ORIGINS` (e.g. `http://localhost:5173`,
   `http://localhost:8420`). No trailing slash.
7. **Authorized redirect URIs**: the same value you set for
   `ARK_AUTH_GOOGLE_REDIRECT_URI` (e.g.
   `http://localhost:5173/auth/google/callback`). Exact match.
8. Click **Create**. Download the JSON. The `client_id` and
   `client_secret` fields inside it become the env vars above.

Keep the JSON outside the repo (or in a gitignored location). Anyone
with both fields can impersonate your OAuth client.

## Production deployment checklist

A consolidated top-to-bottom walkthrough for enabling auth on a fresh
production install. Each item references the longer section above for
detail.

### 1. Google Cloud Console (one-time per deployment)

1. APIs & Services → Credentials → Create Credentials → OAuth 2.0
   Client ID, type **Web application**.
2. **Authorized JavaScript origins**: the user-facing dashboard origin
   (e.g. `https://ark.example.com`). No trailing slash.
3. **Authorized redirect URIs**: must equal
   `ARK_AUTH_GOOGLE_REDIRECT_URI` byte-for-byte (Google does exact
   string compare). Typical: `https://ark.example.com/auth/google/callback`.
4. Save. Copy `client_id` + `client_secret` into your secret store
   (Vault / Secrets Manager / k8s Secret).
5. **OAuth consent screen → Internal** (G Suite domain-only) is a
   useful belt over the `ARK_AUTH_GOOGLE_ALLOWED_DOMAINS` suspenders.
   Note: "Internal" is only available for Google Workspace-managed
   Cloud orgs. Externally-managed accounts must publish via
   **Testing → Production** and may need Google's app-verification
   review.

### 2. Required env vars on the daemon process

The master switch + Google trio + origin allowlist are mandatory.
Anything not listed below falls through to profile defaults.

| Var | Required | Example | Notes |
| --- | --- | --- | --- |
| `ARK_AUTH_REQUIRE_TOKEN` | **yes** | `true` | Master switch. If unset/false the daemon runs in local-admin mode -- no auth at all. |
| `ARK_AUTH_GOOGLE_CLIENT_ID` | **yes** | `...apps.googleusercontent.com` | From step 1.4. |
| `ARK_AUTH_GOOGLE_CLIENT_SECRET` | **yes** | `GOCSPX-...` | Secret. From step 1.4. |
| `ARK_AUTH_GOOGLE_REDIRECT_URI` | **yes** | `https://ark.example.com/auth/google/callback` | Exact match to step 1.3. |
| `ARK_AUTH_GOOGLE_ALLOWED_DOMAINS` | **yes** | `paytm.com,paytm.in` | Comma-separated. Without it, falls back to the profile default (`["paytm.com"]` -- a Paytm-specific holdover hardcoded in `packages/core/config/profiles.ts`). Non-Paytm deployments **must** set this explicitly or every Google login fails closed with an opaque `login_failed`. |
| `ARK_AUTH_SESSION_ALLOWED_ORIGINS` | **yes** | `https://ark.example.com` | Origin-header enforcement on cookie-authed POST / WS upgrades. Comma-separated. |
| `ARK_AUTH_SESSION_COOKIE_SECURE` | **yes** | `true` | Browsers drop a non-`Secure` cookie over HTTPS. |
| `ARK_AUTH_SESSION_COOKIE_DOMAIN` | recommended | `.example.com` | Only set if dashboard + API live on sibling subdomains of the same parent. |
| `ARK_AUTH_DASHBOARD_URL` | recommended | `https://ark.example.com/admin` | Post-login redirect target. Defaults to `/`. |
| `ARK_DEFAULT_TENANT` | optional | `acme` | **Runtime-only override**, narrow scope. Sets the tenant id used by `localAdminContext` (the no-auth fallback context), `make bootstrap-key`'s one-shot daemon, and Temporal queue naming. Does **not** rename the seeded `default` tenant, does **not** change schema column defaults (`tenant_id TEXT NOT NULL DEFAULT 'default'`), and does **not** reroute Google JIT-signup (`auth/login.ts` hardcodes `DEFAULT_TEAM_ID = "default-team"` in tenant `default`). See §"Database state" below for the full picture on custom tenants. |
| `DATABASE_URL` | **yes for multi-node prod** | `postgres://user:pw@host:5432/ark` | Flips `detectProfile` (in `packages/core/config/profiles.ts`) to control-plane mode. Without it the daemon runs on local SQLite at `~/.ark/ark.db` -- fine for a single-node box, **not** for any clustered deploy. |
| `ARK_CONDUCTOR_HOSTNAME` | yes for containers | `0.0.0.0` | The conductor's `startWebSocket` binding in `packages/conductor/index.ts` defaults to `127.0.0.1`; set to `0.0.0.0` for Docker / k8s so the listener is reachable from the ingress. |
| `ARK_CONDUCTOR_PORT` | optional | `19400` | Default listener port. Whatever you set here is what your reverse proxy forwards to. |
| `ARK_AUTH_SESSION_TTL_SEC` | optional | `28800` (8h) | Cookie lifetime. Default is 30d; tighten for higher-security environments. |
| `ARK_AUTH_SESSION_REFRESH_THRESHOLD_SEC` | optional | `300` (5m) | How old a session must be before sliding-refresh extends its expiry. |

### 3. Start the daemon

After env vars are exported, launch the daemon:

```bash
ark server daemon start --detach
```

For containerized deploys, the same binary runs in the foreground as
the container entrypoint (drop `--detach`). The process listens on
`ARK_CONDUCTOR_PORT` (default `19400`) at `ARK_CONDUCTOR_HOSTNAME`
(default `127.0.0.1` -- override to `0.0.0.0` for containers).

### 4. Filesystem state

The daemon persists to `$ARK_DIR` (default `~/.ark`):
- `~/.ark/ark.db` -- SQLite store (when `DATABASE_URL` is unset).
- `~/.ark/ark.jsonl` -- structured logs.
- `~/.ark/sessions/` -- per-session workspace + transcript.

For containerized deploys, mount a persistent volume at `~/.ark` (or
set `ARK_DIR` to a mounted path) or you lose all sessions / API keys
/ tenant data on pod restart. With `DATABASE_URL=postgres://...` set,
identity + scoping state lives in Postgres, but session workspaces
still write to `$ARK_DIR`.

### 5. Reverse proxy / ingress

- TLS terminated upstream of the daemon (cookie-secure requires
  HTTPS at the browser).
- Forward `Host` + `Origin` headers unchanged -- the origin allowlist
  reads `Origin`.
- The redirect-URI path (`/auth/google/callback` by default) must
  reach the daemon, not be intercepted by the SPA's catch-all route.
- **WebSocket upgrade pass-through** for `/terminal/:sessionId` (the
  in-browser session terminal rides the same listener as `/api/rpc`,
  so any path-prefix-based WS allowlist in your proxy must include
  `/terminal/`).

### 6. Database state

The daemon auto-applies migrations on startup. Confirm by querying
the DB directly (works for both SQLite and Postgres):

```sql
SELECT MAX(version) FROM ark_schema_migrations;
```

The value should be the latest migration shipped in the build you
deployed. If it's lower, the daemon hasn't finished startup or
migrations errored -- check `~/.ark/ark.jsonl` (or the container's
stdout) before continuing.

The `default` tenant row is seeded by migration `003_tenants_teams_*`;
the `default-team` row is seeded by migration `017_auth_phase1_*`.
Both are inserted with the literal string `'default'` (hardcoded
in the migration SQL, not parameterized by any env var).

**Can I have a custom primary tenant?** Short answer: **no, not by
renaming or replacing `default`**. The string `'default'` is baked
into three places that no env var overrides:

1. Migration seeds (`003`, `017` insert literal `'default'`).
2. Schema column defaults (`tenant_id TEXT NOT NULL DEFAULT 'default'`).
3. Google JIT-signup routing (`auth/login.ts` hardcodes
   `DEFAULT_TEAM_ID = "default-team"` in tenant `'default'`).

**What you can do:** create additional tenants alongside `default`
and use them as your real org tenants. Pattern:

| Question | Answer |
| --- | --- |
| Tenant named something other than `default`? | **Yes** -- create via SQL (Part 4 §"Create a new tenant"). Lives alongside `default`. |
| Custom tenant as the *only* tenant? | **No** -- the `default` row always exists post-migration. You can leave it empty / unused but it's there. |
| New Google sign-ups land in my custom tenant? | **No** -- JIT-signup is hardcoded to `default`/`default-team`. Pre-seed your real users into the custom tenant via SQL or admin RPCs. |
| `ARK_DEFAULT_TENANT=acme` changes the seeded tenant id? | **No** -- only affects `localAdminContext` fallback and Temporal queue naming. |

**Practical pattern for prod:** leave `default` in place (vestigial),
create `acme` via the Part 4 recipe, pre-seed your admins into
`acme` directly. Users who somehow trigger the JIT path will end up
in `default` as an admin-detectable anomaly (they show up in
`admin/user/list` as cross-tenant orphans). Renaming/replacing
`default` end-to-end is a code-change item, not a config knob --
deferred follow-up.

### 7. Bootstrap the first admin

The `default-team` always exists post-migration, so a human in the
`default` tenant can technically cookie-log-in straight away -- but
JIT-membership lands them as `member`, not `admin`, so they can't
manage anyone. You always need to mint or pre-seed an admin first.
Pick one of:

- `make bootstrap-key NAME=ops-key [TENANT=<id>] [ROLE=admin]` --
  ops/CI use, prints an admin Bearer. The shortcut path.
- Direct SQL -- see Part 2 §"First-time bootstrap (no admin key
  exists yet)". Use when `make` / `openssl` aren't on the host.
- For the first **human** admin in a **non-default** tenant: the
  seeded `default-team` lives in the `default` tenant only, so a
  non-default tenant has no team for JIT to land on. Pre-seed
  `tenants` + `teams` + `users` + `memberships` (role=`admin`) via
  SQL. See Part 4 §"Add an admin to your tenant".

### 8. Smoke test

1. `curl -fsS https://<dashboard>/health` → 200.
2. Browser → `https://<dashboard>/admin` → dashboard renders the
   `LoginPage` (no automatic redirect). Click **Sign in with Google**
   to kick off the OAuth dance.
3. Sign in with an allowed-domain account that has a pre-seeded
   membership → land on dashboard with cookie set.
4. JSON-RPC smoke test from the host (the daemon serves JSON-RPC at
   `/api/rpc`, not REST paths):
   ```bash
   curl -fsS -X POST https://<api>/api/rpc \
     -H "Authorization: Bearer $ADMIN_BEARER" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"admin/tenant/list","params":{},"id":1}'
   ```
   → 200 with your tenant in `result`.

### 9. Hardening after first deploy

- Rotate the bootstrap key once a real human admin exists (call
  `admin/apikey/rotate` or revoke + mint a fresh one).
- Keep the Google client secret in a rotation policy -- regenerating
  it in the console is a single restart for the daemon (just refresh
  `ARK_AUTH_GOOGLE_CLIENT_SECRET`).
- Review `ARK_AUTH_GOOGLE_ALLOWED_DOMAINS` periodically; a too-broad
  list is the most likely audit finding.

## What happens during login

1. User opens the dashboard. `AuthContext.refresh()` calls
   `auth/whoami`. Server returns null (no session). UI renders
   `<LoginPage>`.
2. User clicks **Sign in with Google**. Browser navigates to
   `GET /auth/google/start` on the daemon.
3. Server mints a state cookie (`ark_oauth_state`, HttpOnly,
   short-lived) and 302s to Google's authorization URL with
   `client_id`, `redirect_uri`, `state`, `prompt=select_account` (if
   `?force=1` was passed, for the account switcher).
4. User picks their account on Google. Google redirects back to your
   `ARK_AUTH_GOOGLE_REDIRECT_URI` with `?code=...&state=...`.
5. The browser hits Vite (`localhost:5173/auth/google/callback`),
   which proxies to the daemon's `GET /auth/google/callback`.
6. Server verifies:
   - The `state` query param matches the state cookie (CSRF defense).
   - The state cookie hasn't been duplicated (cookie-tossing defense
     -- fail closed if multiple state cookies present).
   - The `code` exchanges successfully with Google for an ID token.
   - The ID token's signature verifies against Google's JWKS (`jose`
     library does the heavy lifting).
   - The `email_verified` claim is true.
   - The `hd` (hosted domain) claim is in
     `ARK_AUTH_GOOGLE_ALLOWED_DOMAINS`.
7. **JIT user creation**: if no user exists for this email, server
   inserts one. If a user exists with a *different* `google_sub`,
   reject (account-takeover guard).
8. **JIT membership**: if the user has no live membership, insert
   `(user, default-team, member)` so `AuthSessionManager.validate`
   has a valid team chain to walk. The team is the literal
   `default-team` row in the `default` tenant -- the routing is
   hardcoded (`DEFAULT_TEAM_ID` in `auth/login.ts`), not derived
   from email domain or tenant matching. New sign-ups for
   non-`default` tenants are an admin-driven flow (see Part 4
   §"Add an admin to your tenant").
9. **Team chain computation**: walk
   `team -> parent_team -> parent's parent -> ...` up to HoD,
   JSON-encode the chain, store on `sessions_auth.team_chain` so the
   resolver doesn't re-walk on every request.
10. **Mint cookie**: insert a `sessions_auth` row keyed by SHA-256
    hash of a 256-bit random cookie value. Set the cookie on the
    response (HttpOnly, SameSite=Lax, optional Secure).
11. 302 to `/`. Browser lands back on the dashboard. `AuthContext.refresh()`
    runs again, gets a real identity, dashboard renders.

If anything fails, the response is an opaque `401` redirected to
`/#login?error=login_failed` -- no fingerprinting oracle (we don't
distinguish "bad token" from "wrong domain" from "account takeover"
on the wire).

## Logout

`POST /auth/logout`:
- Hashes the cookie value, deletes the matching `sessions_auth` row,
  clears the cookie. Idempotent.
- Origin allowlist enforced.

The dashboard's UserMenu Sign-out button calls this AND clears any
Bearer token from `localStorage` so a subsequent Google login isn't
shadowed by a stale Bearer.

---

# Part 2: Self-service API keys

## What this gives you

CLI / programmatic users (humans, scripts, agents) can mint and
revoke their own Bearer tokens through the dashboard or RPC, without
needing an admin to run anything. Each key has:
- One owner (a real `users.id`).
- A role (capped at the user's own role).
- A name.
- An optional expiry.
- Soft-delete semantics: revoked keys live in the table as audit
  tombstones.

There are two distinct surfaces:

| Surface | Path | Identity required | Owner of resulting key |
| --- | --- | --- | --- |
| Self-service | `apikey/*` RPC + dashboard UI | Real user (cookie session). Blocked for api-key-authed callers (anti-loop). | The cookie user (`api_keys.user_id` set) |
| Admin | `admin/apikey/*` RPC + CLI `ark auth create-key` | Admin role | NULL (admin-minted, tenant-level) |

The two surfaces produce DB rows with different shapes, which the
scoping resolver branches on (see Part 3 for what that means at
session/start time).

## Creating a self-service key (dashboard)

1. Sign in via Google (Part 1).
2. Open **Settings → API Keys**.
3. Click **Create API key**.
4. Pick a name and (optional) expiry.
5. Click create. The plaintext key is shown **once** in a takeover
   modal that requires explicit "I've saved this key" dismiss.
6. Use it as `Authorization: Bearer ark_<tenant>_<hex>` from CLI / curl.

## Creating an admin (NULL-owner) key via CLI

You need an admin-role key first to call this. (Yes, chicken-and-egg
on a fresh install -- the first admin key is minted via direct DB
insert during initial deployment; see the bootstrap recipe below.)

```bash
ark --token "$ADMIN_BEARER" auth create-key \
  --name "ci-pipeline-key" --role admin --tenant default
```

The output prints the plaintext key once. Save it.

### First-time bootstrap (no admin key exists yet)

> **Shortcut:** `make bootstrap-key NAME=ops-key [TENANT=<id>]
> [ROLE=admin]` boots a one-shot daemon in local mode, mints an
> admin key via the normal RPC, then prints it. Equivalent to the
> manual recipe below but ~6 lines shorter. The target threads
> `ARK_DEFAULT_TENANT="$TENANT"` to the one-shot daemon so its
> local-admin context resolves to the same tenant the CLI flag
> targets, so `requireSameTenant` passes for any tenant (not just
> `default`). Use the direct-SQL recipe below only when `make` or
> `openssl` is unavailable.

`apikey/create` is gated by the `requireRealUser` identity check, which
rejects anonymous callers, local-mode synthetic admins, and api-key
callers themselves. On a fresh install with `ARK_AUTH_REQUIRE_TOKEN=true`
there is no human-cookie session yet, so the first admin bearer cannot
go through the normal authenticated RPC path. Two ways out: temporarily
disable auth and use the RPC (the `make bootstrap-key` shortcut above
does this internally), or insert the row directly via SQL (the manual
recipe below). Both produce the same DB result.

Two paths after bootstrap depending on the tenant:

- **Bootstrapping the `default` tenant.** Subsequent admin keys can be
  minted via the cookie → `apikey/create` RPC path once a human signs
  in via Google OIDC (the JIT-signup flow lands them in `default`).
- **Bootstrapping any other tenant.** OIDC sign-in is hardcoded to
  the `default` tenant -- no cookie session is ever issued for a
  non-default tenant. Subsequent admin keys for that tenant come
  from `ark auth create-key` invoked with an existing admin bearer
  in **the same tenant**. The first admin key (the one from this
  recipe) is therefore the only path in; lose it and you re-run
  this bootstrap.

```bash
TENANT=default

# Safety: bootstrap is for fresh installs. If a live admin key already
# exists for the tenant, mint additional keys via `ark auth create-key`
# instead so the audit trail stays clean.
EXISTING=$(sqlite3 ~/.ark/ark.db \
  "SELECT COUNT(*) FROM api_keys WHERE tenant_id='$TENANT' AND role='admin' AND deleted_at IS NULL;")
if [ "$EXISTING" -gt 0 ]; then
  echo "tenant '$TENANT' already has $EXISTING live admin key(s)."
  echo "Use 'ark auth create-key --tenant $TENANT --role admin --name <label>' instead."
  echo "If you really need to bootstrap a new key (original lost), delete the guard and re-run."
  exit 1
fi

SECRET=$(openssl rand -hex 16)
KEY="ark_${TENANT}_$SECRET"                     # format: ark_<tenantId>_<secret>
HASH=$(printf '%s' "$KEY" | openssl dgst -sha256 -hex | awk '{print $NF}')
BOOT_ID="ak-bootstrap-$(openssl rand -hex 3)"   # unique suffix so the recipe is re-runnable
NOW=$(date -u +%FT%TZ)
sqlite3 ~/.ark/ark.db \
  "INSERT INTO api_keys (id, tenant_id, key_hash, name, role, created_at)
   VALUES ('$BOOT_ID', '$TENANT', '$HASH', 'bootstrap', 'admin', '$NOW');"
export ARK_TOKEN="$KEY"

# Verify
ark scoping list   # should return [] (or whatever the tenant has), not "admin role required"
```

Two formatting details that will silently reject the key if you get
them wrong:

- **Token format must be `ark_<tenantId>_<secret>`.** The validator
  (`ApiKeyManager.validate` in `auth/api-keys.ts`) splits on `_` and
  reads the second segment as the tenant id; a 2-segment key like
  `ark_<secret>` is rejected before the hash is even computed.
- **The stored `key_hash` is SHA-256 over the *full* key string**
  (including the `ark_<tenantId>_` prefix), not just the random
  secret. The `openssl dgst -sha256 -hex` call above is portable
  across macOS and Linux; on macOS you can substitute `shasum -a 256`,
  on Linux `sha256sum`, but the openssl form avoids the platform
  fork.

**Postgres variant** (control-plane). Same flow; `sqlite3` swaps to
`psql`, `datetime('now')` swaps to `NOW()::text` (column is `text`,
not `timestamp` -- see Part 4 §"Move a user between tenants" for the
same gotcha), and the COUNT preflight uses `psql -tA`:

```bash
TENANT=default

EXISTING=$(psql "$DATABASE_URL" -tA -c \
  "SELECT COUNT(*) FROM api_keys WHERE tenant_id='$TENANT' AND role='admin' AND deleted_at IS NULL;")
if [ "$EXISTING" -gt 0 ]; then
  echo "tenant '$TENANT' already has $EXISTING live admin key(s)."
  exit 1
fi

SECRET=$(openssl rand -hex 16)
KEY="ark_${TENANT}_$SECRET"
HASH=$(printf '%s' "$KEY" | openssl dgst -sha256 -hex | awk '{print $NF}')
BOOT_ID="ak-bootstrap-$(openssl rand -hex 3)"
NOW=$(date -u +%FT%TZ)

psql "$DATABASE_URL" -c \
  "INSERT INTO api_keys (id, tenant_id, key_hash, name, role, created_at)
   VALUES ('$BOOT_ID', '$TENANT', '$HASH', 'bootstrap', 'admin', '$NOW');"
export ARK_TOKEN="$KEY"
```

Token format, hash algorithm, and `ark auth revoke-key` cleanup are
identical across both backends.

**Rotate this key once a real admin exists.** The bootstrap row is a
long-lived shared secret minted outside the normal audit path. As soon
as you have a real human admin (Google OIDC sign-in -> dashboard ->
mint admin key), revoke the bootstrap row:

```bash
ark auth revoke-key "$BOOT_ID"   # or look up the id with `ark auth list-keys --tenant default`
```

**Shell hygiene.** The recipe ends with `export ARK_TOKEN="$KEY"`,
which writes the secret into your shell's process env (and, for many
configurations, the shell history). For production deployments,
prefer storing the key in your secret manager (Vault, AWS Secrets
Manager, etc.) and sourcing it on demand:

```bash
# production-friendly pattern
export ARK_TOKEN=$(vault read -field=ark_bootstrap secret/ark/default)
ark scoping list
unset ARK_TOKEN   # don't leave it in the parent shell after you're done
```

On a single-developer laptop the `export` form is fine; on a shared
build host or CI runner it isn't.

## Identity gates

The `requireRealUser` gate on every `apikey/*` method enforces:

- **Anonymous callers blocked.** No cookie, no Bearer → FORBIDDEN.
- **Local-mode synthetic admin blocked.** `ctx.userId === "local"` →
  FORBIDDEN (local mode shouldn't be persisting keys anyway).
- **API-key authenticated callers blocked.** When the caller's
  `ctx.userId` starts with `ak-...` (the api_keys row id sentinel),
  the gate fails. This blocks an api-key from cloning itself
  indefinitely.
- **Soft-deleted users blocked.** A user whose row was tombstoned
  shouldn't be able to mint anything.

Result: only real cookie-authed humans can use `apikey/*`. The
identity loop is closed.

## Role ceiling

A user can only mint keys at-or-below their own role. Roles ranked
from low to high:

```
viewer < member < admin
```

So:
- A `member` user can mint `member` or `viewer` keys.
- A `member` user trying to mint an `admin` key gets
  `INVALID_PARAMS: cannot mint role 'admin' from role 'member'`.
- An `admin` user can mint anything.

## Per-user cap

Each user can have at most **10 live keys** at a time. The 11th
`apikey/create` call fails with `INVALID_PARAMS: maximum of 10 live
API keys per user reached`. Revoked (soft-deleted) keys do NOT count
against the cap -- a user can revoke and re-mint.

The cap is on the live count for that user in their tenant; if the
user is somehow associated with multiple tenants, each gets its own
cap of 10.

## Cross-tenant defense

API-key methods (`listForUser`, `countLiveForUser`, `revokeAsUser`)
all filter by `tenant_id` AND `user_id`. A user who happens to share
an id with someone in another tenant cannot see / count / revoke the
other tenant's keys. This is defense-in-depth for the
(theoretical-today) case where id-generator changes might collapse
uniqueness across tenants.

## Revoking a key

Self-service revoke (the user revoking their own key) goes through
the dashboard: **Settings → API Keys → Revoke** (with inline confirm).
There's no CLI shortcut for self-service revoke today; the only CLI
revoke path is the admin one below.

Admin revoke (revoking any key in the tenant):

```bash
ark --token "$ADMIN_BEARER" auth revoke-key <key-id>
```

Both paths produce the same DB result (soft-delete on the row).

Revoked keys are soft-deleted. The `api_keys.deleted_at` column gets
the current timestamp; `deleted_by` records who did the revoke. The
row stays in the table for audit purposes. Soft-deleted keys can
NEVER authenticate again -- the SELECT in `validate()` filters on
`deleted_at IS NULL`.

## What an admin can / cannot do

The `admin` role is **tenant-scoped**. The matrix below is the
ground truth: every operation either succeeds within the caller's
own tenant or fails closed (FORBIDDEN / 404 / generic rejection).

| Operation | Inside own tenant | Cross-tenant (other tenant's resource) |
|---|---|---|
| List tenants | Returns own tenant only | n/a (list is implicitly filtered) |
| Get / update / set-status / delete a tenant | ✅ | ❌ FORBIDDEN |
| **Create a tenant** | ❌ FORBIDDEN (system-admin op) | ❌ FORBIDDEN |
| List / get / create / update / delete teams | ✅ | ❌ FORBIDDEN |
| List / add / remove / set-role on team members | ✅ | ❌ FORBIDDEN |
| Search team-member candidates (autocomplete) | ✅ | ❌ FORBIDDEN |
| List users (`admin/user/list`) | Returns in-tenant users + global orphans | Cross-tenant-only users hidden from response |
| Roll-up users in a specific tenant (`admin/tenant/users`) | ✅ | ❌ FORBIDDEN |
| Get / view memberships of a user | ✅ for in-tenant + orphan users | ❌ 404 (same message as missing user) |
| Upsert a user (`admin/user/upsert`) -- creates a new identity OR updates an existing user's `name` | ✅ creates always allowed; updates allowed for in-tenant + orphan users | ❌ 404 when updating a cross-tenant-only user (prevents name graffiti on a foreign identity) |
| **Delete a user** (`admin/user/delete`) | ✅ when user has no memberships outside this tenant | ❌ FORBIDDEN ("user has memberships in other tenants") |
| Create a user (`admin/user/create`) | ✅ -- creates a global identity row, no cross-tenant access on its own | (same) |
| List / create / delete / revoke / restore / rotate API keys | ✅ | ❌ FORBIDDEN |
| List / get / set / delete scoping overrides | ✅ within tenant scope | ❌ FORBIDDEN (validator enforces R1/R2 -- a user-scope id must have a live membership in your tenant; a team-scope id must belong to your tenant) |

**Why creates are permissive on users.** `admin/user/create` and
`admin/user/upsert` mint a global identity row with no cross-tenant
access grant on their own. The actual damage vector is always
`create + add-to-team-in-other-tenant`, and `members/add` is gated.
The upsert path additionally refuses to update a cross-tenant-only
user's `name` column (graffiti prevention).

**No existence oracle.** For each of
`admin/user/{get,memberships,upsert,delete}`, the 404 message is
identical between "user truly doesn't exist" and "user exists only
in another tenant" -- a probing admin cannot distinguish the two
within a single route. The message **format** differs by which
input the route accepts: id-keyed routes return `User '<id>' not
found`; `admin/user/upsert` is email-keyed and returns `User with
email '<email>' not found`. Within-route symmetry is what closes
the oracle.

---

# Part 3: Scoping overrides

A single override surface for org-level configuration. Admins, team
leads, and individual users can set saved preferences that flow into
session dispatch -- "everyone in my tenant defaults to the GPU pool",
"my team prefers the codex runtime", "I personally want my laptop as
my default compute target".

The resolver walks the chain `user > team > parent_team > ... > hod_team
> tenant`. The most-specific match wins; less-specific entries are
ignored. Empty / no-match falls through to the existing built-in
defaults (agent YAML, runtime YAML, the hardcoded `"local"` fallback).

## When to use it

| Scope | Who sets it | Why |
| --- | --- | --- |
| **Tenant-level** | Admin (via SQL playbook below) | Org-wide defaults: "everyone in my tenant uses the GPU pool" |
| **Team-level** | Admin acting for a team | Team preferences: "the AI team prefers codex over claude" |
| **User-level** | Admin acting for a user, or the user themselves through the cookie session | Personal preferences: "I work on a slow laptop, default my compute to the cloud pool" |

**Three ways to manage overrides**:
- **Dashboard** (`/admin → Scoping`) -- list / filter / new / edit /
  delete, with catalog-driven value pickers and an audit drawer.
  Preferred for ad-hoc operator use.
- **Admin RPCs + CLI** -- `admin/scoping/set` /
  `list` / `get` / `delete`, wrapped by `ark scoping set/list/get/delete`.
  Validates at write time so a typo'd runtime / model / compute / flow
  name is rejected immediately. See the "Admin RPCs + CLI" subsection
  below. Preferred for scripted / automated use.
- **Direct SQL** (fallback) -- inserts on `scoping_overrides` for
  deployments that prefer raw DB access. No write-time validation;
  bad values surface at the next `session/start`.

## The four scoped keys

| Key | Value type | What it controls | Validation |
| --- | --- | --- | --- |
| `flow.allowlist` | `string[]` (JSON array of flow names) | `flow/list` filters to these flows; `session/start` rejects flows not in the list | Empty / null = no filtering (all flows visible) |
| `runtime` | `string` (a runtime name from `ark runtime list`) | The runtime the agent will dispatch on, replacing the agent's declared `runtime` | Must match a registered runtime; fail-loud at `session/start` if not |
| `model` | `string` (a model id or alias from the catalog) | The model the agent uses, replacing `agent.model` | Must match a registered model id or alias; fail-loud if not. Aliases like `sonnet` are accepted |
| `compute.default` | `string` (a compute name from `ark compute list`) | The default compute target for the session when the caller didn't pass `--compute` | Must match a tenant-scoped compute row; fail-loud if not |

### Per-key precedence rules

For runtime, model, compute.default -- when multiple sources have a value, the
top-most wins:

```
runtime:
  agent.runtime_locked: true        -> agent's declared runtime always wins
  caller passed opts.runtime        -> resolver short-circuited; caller wins
  resolver hint                      -> override wins
  agent.runtime (declared)           -> default

model:
  agent.model_locked: true          -> agent's declared model always wins
  stage.model (in flow YAML)         -> wins
  resolver hint                      -> override wins
  agent.model (declared)             -> default
  catalog slug resolution            -> always runs last to map id -> provider slug

compute:
  stage.compute (in flow YAML)       -> wins
  caller passed --compute            -> resolver short-circuited; caller wins
  resolver hint                      -> override wins
  repoConfig.compute (per-repo)      -> default
  "local" (hardcoded final fallback) -> default
```

For `flow.allowlist`: the override is applied as a filter, not a
replacement. Empty/null = no filter; non-empty = only flows whose name
appears in the array are visible / startable.

### Which callers do overrides apply to?

| Auth path | User-level applies? | Team-level applies? | Tenant-level applies? |
| --- | --- | --- | --- |
| Cookie (real human via Google login) | yes (their `users.id`) | yes | yes |
| Bearer + self-service api-key (`api_keys.user_id` set) | yes (key owner's `users.id`) | yes (owner's chain) | yes |
| Bearer + admin-minted api-key (`api_keys.user_id` NULL) | no | no | yes (tenant-only) |
| Local mode (no auth) | no | no | yes (tenant-only) |

## Setting overrides (admin RPCs + CLI)

`admin/scoping/*` RPCs are the supported write path. They gate on
admin role, validate the scope-id (cross-tenant defense), and validate
each value against the appropriate catalog (`runtime`, `model`,
`compute.default` -> registry; `flow.allowlist` -> per-name catalog
check). Bad values are rejected at write time, not at the next user's
`session/start`. Audit fields `set_by` / `deleted_by` capture the
caller's `ctx.userId` (an actor identifier -- may be a real `users.id`
or an api-key sentinel `ak-...`, depending on auth path).

The CLI wraps the RPCs. Mint an admin Bearer key first
(`make bootstrap-key` on fresh installs, or any existing admin api
key) and pass it via `--token`.

### Set or update an override

```bash
# Tenant-level runtime override
ark --token "$ADMIN_TOKEN" scoping set \
  --scope tenant --scope-id default --key runtime --value '"codex"'

# Tenant-level model override using an alias
ark --token "$ADMIN_TOKEN" scoping set \
  --scope tenant --scope-id default --key model --value '"sonnet"'

# Tenant-level compute.default
ark --token "$ADMIN_TOKEN" scoping set \
  --scope tenant --scope-id default --key compute.default --value '"local"'

# Tenant-level flow.allowlist (strict: every name must exist in the catalog)
ark --token "$ADMIN_TOKEN" scoping set \
  --scope tenant --scope-id default --key flow.allowlist \
  --value '["docs","brainstorm","pr-review"]'

# Team-level
ark --token "$ADMIN_TOKEN" scoping set \
  --scope team --scope-id team-eng --key runtime --value '"codex"'

# User-level
ark --token "$ADMIN_TOKEN" scoping set \
  --scope user --scope-id u-alice --key compute.default --value '"alice-laptop"'
```

The `--value` flag accepts any JSON literal. Use single-quotes around
the entire JSON so your shell doesn't interpret the inner double-quotes.

If the value is bad, the call fails loud:

```
$ ark --token "$ADMIN_TOKEN" scoping set \
    --scope tenant --scope-id default --key runtime --value '"coddex"'
Error: runtime 'coddex' is not a registered runtime
```

### List overrides

```bash
# All live overrides in your tenant
ark --token "$ADMIN_TOKEN" scoping list

# Filter by scope kind
ark --token "$ADMIN_TOKEN" scoping list --scope user

# Filter by key
ark --token "$ADMIN_TOKEN" scoping list --key runtime

# Include soft-deleted (tombstones) for audit
ark --token "$ADMIN_TOKEN" scoping list --include-deleted
```

### Get a single override by id

```bash
ark --token "$ADMIN_TOKEN" scoping get <override-id>
```

### Soft-delete

Two forms. Both end up with the same DB write:

```bash
# By id (e.g. from `scoping list` output)
ark --token "$ADMIN_TOKEN" scoping delete <override-id>

# By composite key (scope_kind + scope_id + key)
ark --token "$ADMIN_TOKEN" scoping delete \
  --scope tenant --scope-id default --key runtime
```

Both are mutually exclusive -- passing both `<id>` and `--scope/--scope-id/--key`
together is rejected (ambiguous).

## Setting overrides (SQL playbook)

> **For new operators, prefer the admin RPC + CLI surface in the
> previous section, or the dashboard `/admin → Scoping` tab.**
> Direct SQL bypasses write-time catalog validation, the `set_by`
> audit column, and the admin gate. This playbook is kept here for
> headless / DB-only contexts and as a reference for the row
> shape.

The `scoping_overrides` table is also modifiable by direct SQL.
Connect via `sqlite3` (local) or your Postgres client (hosted).

**Postgres operators:** the examples below use SQLite syntax
(`datetime('now')`). For Postgres substitute `NOW()::text` -- the
schema column is `text`, not `timestamp` (same gotcha as Part 4
§"Move a user between tenants"). All column names, JSON shapes,
heredoc patterns, and resolver semantics are backend-identical.

> **Heredoc, not shell-escaped.** zsh/bash mangle the JSON quotes in a
> one-liner SQL string. `'[\"docs\"]'` ends up stored as
> `[\"docs\"]` (literal backslashes), the resolver throws on
> `JSON.parse`, and the filter zeros the list. Use `<<'SQL' ... SQL`
> heredoc with a single-quoted delimiter to pass SQL through verbatim.
> If your shell shows a `heredoc>` prompt after pasting, the closing
> `SQL` line had leading whitespace -- type bare `SQL` (column 0)
> + Enter to close it.

### Insert a tenant-level override

```bash
sqlite3 ~/.ark/ark.db <<'SQL'
INSERT INTO scoping_overrides
  (id, scope_kind, scope_id, key, value_json, tenant_id, created_at, updated_at)
VALUES
  ('tenant-flow-allowlist', 'tenant', 'default', 'flow.allowlist',
   '["docs","brainstorm","pr-review"]', 'default',
   datetime('now'), datetime('now'));
SQL
```

Note `scope_id = 'default'` (the tenant id) and `tenant_id = 'default'`.
At tenant level these are the same value; for user / team overrides
they differ.

### Insert a team-level override

```bash
sqlite3 ~/.ark/ark.db <<'SQL'
INSERT INTO scoping_overrides
  (id, scope_kind, scope_id, key, value_json, tenant_id, created_at, updated_at)
VALUES
  ('team-eng-runtime', 'team', 'team-eng', 'runtime',
   '"codex"', 'default',
   datetime('now'), datetime('now'));
SQL
```

`scope_id` is the team's id from the `teams` table. `tenant_id` is the
tenant the team belongs to.

### Insert a user-level override

```bash
sqlite3 ~/.ark/ark.db <<'SQL'
INSERT INTO scoping_overrides
  (id, scope_kind, scope_id, key, value_json, tenant_id, created_at, updated_at)
VALUES
  ('user-alice-compute', 'user', 'u-4acda986d4d9', 'compute.default',
   '"alice-laptop"', 'default',
   datetime('now'), datetime('now'));
SQL
```

`scope_id` is the user's id from the `users` table.

### Update an existing override

```bash
sqlite3 ~/.ark/ark.db <<'SQL'
UPDATE scoping_overrides
SET value_json = '"opus"', updated_at = datetime('now')
WHERE id = 'team-eng-model' AND deleted_at IS NULL;
SQL
```

### Soft-delete (revoke) an override

Soft-delete via `deleted_at`; the row stays in the table as an audit
tombstone but the resolver ignores it.

```bash
sqlite3 ~/.ark/ark.db <<'SQL'
UPDATE scoping_overrides
SET deleted_at = datetime('now'), updated_at = datetime('now')
WHERE id = 'tenant-flow-allowlist';
SQL
```

### List all live overrides for a tenant

```bash
sqlite3 ~/.ark/ark.db <<'SQL'
SELECT id, scope_kind, scope_id, key, value_json, datetime(updated_at) AS updated
FROM scoping_overrides
WHERE tenant_id = 'default' AND deleted_at IS NULL
ORDER BY scope_kind, scope_id, key;
SQL
```

## Agent-side opt-outs

Two AgentDefinition fields let an agent author block specific
overrides:

### `runtime_locked: true`

Use when the agent uses runtime-specific tools, native tool-calling
formats, or skills only one runtime understands (e.g. Claude
citations / extended thinking). Forcing such an agent onto a different
runtime breaks at runtime with cryptic tool errors.

```yaml
# agents/claude-citation-agent.yaml
name: claude-citation-agent
runtime: claude-code
runtime_locked: true   # never override the runtime, no matter the scoping override
description: ...
```

### `model_locked: true`

Use when the agent's behavior or contract depends on a specific model.
Four common cases:

- **Cost lock-in**: agent intentionally pinned to a cheap model
  (e.g. haiku) -- override would silently 10x cost.
- **System-prompt tuning**: agent's system prompt is tuned for a
  specific model's response style; overrides degrade output quality.
- **Context-window dependency**: 200k-context agent forced onto an 8k
  model fails with token errors.
- **Model-specific features**: agents using citations, extended
  thinking, etc. lose those features silently on models that don't
  support them.

```yaml
# agents/cost-pinned-haiku-worker.yaml
name: cost-pinned-haiku-worker
runtime: claude-code
model: haiku
model_locked: true     # never let an org-wide override bump us off haiku
description: ...
```

There's no `compute_locked` because the agent doesn't bind to a
compute target -- each session picks its own.

## Common scenarios (cookbook)

> The SQL inserts below are the original recipes from before the
> admin RPC + dashboard surfaces existed. They still work, but
> direct SQL bypasses write-time catalog validation, the `set_by`
> audit column, and the admin gate. **For new operators, prefer
> the dashboard UI (`/admin → Scoping`) or `ark scoping set` --
> see Part 4 §"Set / update / delete a scoping override".** The
> SQL form is kept here as a fallback for headless environments
> and as a reference for what each row physically looks like.

### 1. Limit my team to specific flows

```bash
sqlite3 ~/.ark/ark.db <<'SQL'
INSERT INTO scoping_overrides
  (id, scope_kind, scope_id, key, value_json, tenant_id, created_at, updated_at)
VALUES
  ('eng-team-flows', 'team', 'team-eng', 'flow.allowlist',
   '["docs","pr-review","quick"]', 'default',
   datetime('now'), datetime('now'));
SQL
```

After this, members of `team-eng`:
- See only `docs`, `pr-review`, `quick` in the dashboard's New Session form
- Get `RpcError: Flow 'X' is not in your allowlist` if they try to start any other flow via CLI

### 2. Force my tenant onto a specific runtime

```bash
sqlite3 ~/.ark/ark.db <<'SQL'
INSERT INTO scoping_overrides
  (id, scope_kind, scope_id, key, value_json, tenant_id, created_at, updated_at)
VALUES
  ('paytm-runtime', 'tenant', 'paytm', 'runtime',
   '"claude-code"', 'paytm',
   datetime('now'), datetime('now'));
SQL
```

Every session in tenant `paytm` runs on `claude-code` unless:
- The caller passed an explicit `--runtime` flag
- The agent has `runtime_locked: true`

### 3. Pin a cost-sensitive agent to haiku regardless of org overrides

In the agent YAML:

```yaml
name: cost-pinned-summarizer
runtime: claude-code
model: haiku
model_locked: true
description: A summarizer agent pinned to haiku for cost reasons.
              Never bumped to opus by org-wide model overrides.
```

This agent stays on haiku even if a tenant admin sets
`model = "opus"`.

### 4. Make my laptop the default compute target

```bash
sqlite3 ~/.ark/ark.db <<'SQL'
INSERT INTO scoping_overrides
  (id, scope_kind, scope_id, key, value_json, tenant_id, created_at, updated_at)
VALUES
  ('alice-compute', 'user', 'u-4acda986d4d9', 'compute.default',
   '"alice-laptop"', 'default',
   datetime('now'), datetime('now'));
SQL
```

Any session alice starts (without `--compute`) defaults to her
laptop. She can still override per-session with `ark session start
--compute foo`.

### 5. Personal preference vs. tenant policy: who wins?

If both are set, **the most specific scope wins**. So:
- Tenant override `runtime = "claude-code"` (admin-set policy)
- User override `runtime = "codex"` (alice's personal preference)

When alice dispatches, she gets `codex` (user-level beats tenant).

If you want tenant policy to be a hard mandate, you currently can't
enforce that through scoping_overrides alone -- they are preferences,
not policy. The escape hatches `--runtime` / `--compute` and the
user-level preferences both win over tenant.

### 6. Removing an override safely

Always soft-delete (set `deleted_at`), don't `DELETE FROM`. Soft-deletes:
- Are immediate (the resolver filters them out)
- Preserve audit history (you can see *what* was set + *when*)
- Are reversible (`UPDATE ... SET deleted_at = NULL` restores)

```bash
sqlite3 ~/.ark/ark.db <<'SQL'
UPDATE scoping_overrides
SET deleted_at = datetime('now'), updated_at = datetime('now')
WHERE id = 'paytm-runtime';
SQL
```

If you accidentally soft-deleted the wrong row:

```bash
sqlite3 ~/.ark/ark.db <<'SQL'
UPDATE scoping_overrides
SET deleted_at = NULL, updated_at = datetime('now')
WHERE id = 'paytm-runtime';
SQL
```

---

# Part 4: Operations runbook

Day-to-day recipes for the admin role. Each recipe lists every path
that works today (dashboard / CLI / SQL) so you can pick the one
that fits your context. Recipes that need a step deprecated by the
tenant-admin tightening are noted inline.

## Recipe: Bootstrap a fresh installation

The first ever admin in a fresh DB. Two steps -- get an admin API
key, then sign in.

1. **Mint the initial admin key.** Simplest path:
   `make bootstrap-key NAME=ops-key [TENANT=<id>]` -- boots a
   one-shot daemon in local mode, mints an admin key via the normal
   RPC, prints the plaintext key, then exits. Works for any tenant
   (the target threads `ARK_DEFAULT_TENANT` through to the daemon).
   For hostile environments without `make`/`openssl`, fall back to
   the SQL bootstrap recipe in Part 2 §"Creating an admin
   (NULL-owner) key via CLI" → "First-time bootstrap (no admin key
   exists yet)". Either path mints an `ark_<tenantId>_…` key and
   prints it once.
2. **Sign in to the dashboard.** Open `/admin`, use "Use an API
   key instead", paste the key. You now hold a tenant-admin in the
   `default` tenant.

That's it. The `default` tenant + `default-team` row are seeded by
migration; the JIT-signup flow attaches new OIDC users to
`default-team` as `member`.

## Recipe: Create a new tenant

`ark tenant create` and `admin/tenant/create` both return FORBIDDEN
under the tenant-admin model -- tenant creation is a system-admin
operation that has no role assigned yet. Use direct SQL:

```bash
DB=~/.ark/ark.db   # local dev; hosted prod: connect to the prod DB

# IMPORTANT: SLUG must be kebab-case alphanumeric only. Underscores
# break the API key parser -- `ark_<tenantId>_<secret>` splits on
# `_`, so a tenant id containing `_` would be parsed as the first
# segment up to the underscore, and the rest leaks into the secret.
# Match the slug regex in tenants.ts:
#   /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/
# (kebab-case 2-64 chars, or a single alphanumeric)
SLUG=acme
NAME="Acme Corp"

sqlite3 "$DB" <<SQL
INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
VALUES ('t-${SLUG}', '${SLUG}', '${NAME}', 'active',
        datetime('now'), datetime('now'));

-- Seed a starter team in the new tenant. The new tenant's first
-- admin can also create teams via the dashboard / CLI after sign-in,
-- so this is optional.
INSERT INTO teams (id, tenant_id, slug, name, description,
                   created_at, updated_at)
VALUES ('tm-${SLUG}-default', 't-${SLUG}', 'default-team',
        'Default Team', 'Starter team for the tenant',
        datetime('now'), datetime('now'));
SQL
```

**Postgres variant** -- same flow, `datetime('now')` swaps to
`NOW()::text` (the schema columns are `text`, not `timestamp`; same
gotcha as Part 4 §"Move a user between tenants"):

```bash
SLUG=acme
NAME="Acme Corp"

psql "$DATABASE_URL" <<SQL
INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
VALUES ('t-${SLUG}', '${SLUG}', '${NAME}', 'active',
        NOW()::text, NOW()::text);

INSERT INTO teams (id, tenant_id, slug, name, description,
                   created_at, updated_at)
VALUES ('tm-${SLUG}-default', 't-${SLUG}', 'default-team',
        'Default Team', 'Starter team for the tenant',
        NOW()::text, NOW()::text);
SQL
```

Then mint a first admin key for the new tenant. The existing
`default`-tenant admin **cannot** use their own bearer to do this
(the `requireSameTenant` guard rejects cross-tenant mints). Two
ways forward:

- **`make bootstrap-key NAME=ops-key TENANT=t-${SLUG} ROLE=admin`** --
  boots a one-shot daemon whose local-admin context is scoped to
  the new tenant (via `ARK_DEFAULT_TENANT`), mints via the normal
  RPC, exits. Cleanest path.
- **Direct SQL** -- re-run the Part 2 §"First-time bootstrap"
  recipe with `TENANT=t-${SLUG}`. Use this when `make`/`openssl`
  isn't available.

Hand the new key to the new tenant's operator.

**Caveat: Google OIDC JIT-signup is not yet per-tenant routed.** The
JIT-membership step in `auth/login.ts` is hardcoded against
`DEFAULT_TEAM_ID = "default-team"` in the `default` tenant. A user
signing in via Google for the first time always lands in the
`default` tenant -- regardless of email domain or any per-tenant
allowedDomains setting. The new tenant's operator therefore uses
the **Bearer-token CLI path** (or has the existing `default` admin
add them to a team in the new tenant explicitly via the dashboard).
Per-tenant OIDC routing is a follow-up.

When the system-admin role lands, this recipe is replaced by
`admin/tenant/create` again (gated to system-admins).

## Recipe: Add an admin to your tenant

A new admin in YOUR tenant -- not a new tenant. Three sub-steps:
add the user identity, attach them to a team at role=admin, and
get them a credential.

**Dashboard:**
1. `/admin` → Users → `+ New User` → enter email, name, pick a
   team and role = `admin` → Create. The team picker is
   pre-filtered to your tenant; you cannot grant a role outside
   it. (Works for any tenant admin.)
2. Give them a credential. Two options, both initiated by the new
   admin themselves -- there is **no dashboard surface** for an
   existing admin to mint a key on another user's behalf:
   - **Self-service API key (default tenant only):** new admin
     signs in via Google → `Settings → API Keys → Create API key`.
     Key shown once. This path only works when the new admin's
     intended tenant is `default`, because Google OIDC JIT-signup
     is hardcoded to that tenant.
   - **Bearer-token CLI:** an existing admin in the same tenant
     mints an admin key for the new user via `ark auth create-key`
     (see CLI block below) and hands it over out-of-band.

**Non-`default`-tenant caller:** step 1 works the same in your
tenant. For step 2, only the Bearer-token CLI path is available --
the Google sign-in path won't work because OIDC JIT-signup lands
new users in `default` regardless of email domain. Per-tenant OIDC
routing is a follow-up.

**CLI:**
```bash
# Create the user identity (if not already present)
ark --token "$ADMIN_BEARER" user create \
    --email new@admin.com --name "New Admin"

# Add them to a team as admin -- members subcommand, positional args
ark --token "$ADMIN_BEARER" team members add \
    <team-id> new@admin.com --role admin
```

## Recipe: Create a team in your tenant

**Dashboard:** `/admin` → Teams → `+ New` → fill slug / name /
description → Create.

**CLI:**
```bash
# slug is positional; the team is created in the tenant identified
# by --tenant (id or slug). Defaults to "default" if omitted.
ark --token "$ADMIN_BEARER" team create eng \
    --tenant default --name "Engineering"
```

## Recipe: Add or remove a user from a team

**Dashboard, add:** `/admin` → Teams → click the team → in the
"Add member" combobox, type ≥3 chars of email or name (debounced
search) → pick from results OR use the `+ Add new user: <email>`
free-text fallback for a brand-new email → choose role → Add.

The picker tags users with `already member`, `no memberships`, or
`also in: <other-teams>` so you can see context before adding.

**Dashboard, remove:** Click the team → in the Members table, click
the `Remove` button on the row (confirm dialog).

**CLI:**
```bash
# `team members add` takes <team-id> <email> as positional args;
# --role defaults to "member". The server upserts the user identity
# from email if no row exists yet.
ark --token "$ADMIN_BEARER" team members add \
    tm-eng alice@example.com --role member

ark --token "$ADMIN_BEARER" team members remove \
    tm-eng alice@example.com
```

## Recipe: Move a user between tenants

This is the operational landmine on the current auth model and worth
calling out before you discover it the hard way. Until the system-admin
role lands (deliberately deferred for now), no single human credential
can move a user from tenant A to tenant B in one operation.

**Why it's awkward today.** Three constraints stack:

1. Google JIT-signup hardcodes every first-time user into
   `default/default-team` as role `member`. They can't sign up directly
   into your real tenant.
2. After PR #568, `requireSameTenant` prevents tenant A's admin from
   `admin/team/members/remove`-ing a user in tenant B (and vice versa).
3. `computeTeamChain` picks `memberships[0]` ordered by `createdAt ASC`,
   so adding a second membership in tenant B does NOT move the user --
   their session still resolves through their oldest (tenant A)
   membership. You must DELETE the old membership for the move to take
   effect.

Two sanctioned paths today, both deliberate trade-offs.

### Path A: Direct SQL (preferred for ops / one-off moves)

This is the sanctioned ops-escalation path today -- "the super-admin
role is the RDS password" is the design stance until the system-admin
role lands. Clean audit trail (`deleted_by` + `deleted_at` on the
membership row), no admin-key coordination required.

**Pick the variant that matches your backend** (the daemon runs on
SQLite at `~/.ark/ark.db` if `DATABASE_URL` is unset, otherwise on
Postgres -- see Part 1 §"Database state"). The two variants differ
only in three function names; everything else is identical.

> ⚠ Sanity-check `NEW_ROLE` before running. The variable lets you
> set `member`, `admin`, `owner`, or `viewer` -- a typo here can
> silently elevate the user (e.g. moving them as `admin` when you
> meant `member`).

**SQLite variant** (local / single-node):

```bash
DB="$HOME/.ark/ark.db"
ALICE="alice@example.com"
NEW_TEAM="tm-acme-engineering"    # team id in the destination tenant
NEW_ROLE="member"                  # or admin / owner / viewer

sqlite3 "$DB" <<SQL
-- Preflight: prints alice's row + the destination team for human
-- review. NOT a programmatic guard -- the BEGIN below runs whether
-- or not these return rows. Eyeball the output, then let it complete
-- (or Ctrl-C if either query returned 0 rows).
SELECT id, email FROM users
 WHERE email = '${ALICE}' AND deleted_at IS NULL;
SELECT id, slug, tenant_id FROM teams
 WHERE id = '${NEW_TEAM}' AND deleted_at IS NULL;

-- Atomic move: wrap the membership swap in a transaction so a failed
-- INSERT (e.g. team typo, FK violation) rolls back the UPDATE and
-- leaves alice's old memberships intact. Without this, a failure
-- between step 2 and step 3 strands her with zero memberships --
-- her session would get bounced to anonymous on every request.
BEGIN;

-- 1. Soft-delete every live membership for this user. If she
--    legitimately belongs to multiple tenants and you only want to
--    move one, narrow the WHERE clause with AND team_id = '...'.
--    The full-sweep below is the right default for first-time
--    "alice was JIT'd into default, move her to acme" cases.
UPDATE memberships
   SET deleted_at = datetime('now'), deleted_by = 'sql-admin'
 WHERE user_id = (SELECT id FROM users WHERE email = '${ALICE}')
   AND deleted_at IS NULL;

-- 2. Insert the new membership in the destination tenant.
--    ID format matches the code convention (m- + 12 hex chars,
--    see MembershipRepository.add in repositories/memberships.ts).
INSERT INTO memberships (id, user_id, team_id, role, created_at)
VALUES ('m-' || lower(hex(randomblob(6))),
        (SELECT id FROM users WHERE email = '${ALICE}'),
        '${NEW_TEAM}',
        '${NEW_ROLE}',
        datetime('now'));

COMMIT;
SQL
```

**Postgres variant** (control-plane): same flow, three function
swaps. `pgcrypto` must be enabled (`CREATE EXTENSION IF NOT EXISTS
pgcrypto;` -- safe to run; idempotent).

```bash
ALICE="alice@example.com"
NEW_TEAM="tm-acme-engineering"
NEW_ROLE="member"

psql "$DATABASE_URL" <<SQL
-- Preflight prints for human review; not a programmatic guard.
-- Eyeball the output before letting the BEGIN/COMMIT complete.
SELECT id, email FROM users
 WHERE email = '${ALICE}' AND deleted_at IS NULL;
SELECT id, slug, tenant_id FROM teams
 WHERE id = '${NEW_TEAM}' AND deleted_at IS NULL;

BEGIN;

UPDATE memberships
   SET deleted_at = NOW()::text, deleted_by = 'sql-admin'
 WHERE user_id = (SELECT id FROM users WHERE email = '${ALICE}')
   AND deleted_at IS NULL;

INSERT INTO memberships (id, user_id, team_id, role, created_at)
VALUES ('m-' || encode(gen_random_bytes(6), 'hex'),
        (SELECT id FROM users WHERE email = '${ALICE}'),
        '${NEW_TEAM}',
        '${NEW_ROLE}',
        NOW()::text);

COMMIT;
SQL
```

The `::text` casts on `NOW()` keep the timestamps in the
`YYYY-MM-DD HH:MM:SS` text format that the schema column expects
(`text("created_at")` / `text("deleted_at")` in
`packages/core/drizzle/schema/postgres.ts`).

Alice's existing cookie session will start serving the new tenant on
her next request -- the live JOIN in `AuthSessionManager.validate`
derives `tenantId` fresh each time. **But** her cached `team_chain`
stays empty until she signs out and signs back in, so team-scope
scoping overrides won't apply until then.

### Path B: Two Bearer tokens + CLI (no SQL, no UI)

When you'd rather avoid the DB. Trade-off: you need admin Bearer
tokens for both tenants, the audit trail records two separate admin
actors, and you have to do the remove + add in the right order.

```bash
# 1. Mint admin keys for both tenants (one-time; reuse if you have them).
make bootstrap-key NAME=ops-default TENANT=default ROLE=admin
make bootstrap-key NAME=ops-acme    TENANT=t-acme  ROLE=admin
# Each command prints the ark_<tenant>_<hex> bearer once. Save them.

# 2. Remove alice from the default-team using the DEFAULT admin bearer.
ark --token "$DEFAULT_ADMIN_BEARER" team members remove \
    default-team alice@example.com

# 3. Add alice to the destination team using the ACME admin bearer.
#    The server upserts the user identity from email; alice already
#    exists, so this just inserts the membership.
ark --token "$ACME_ADMIN_BEARER" team members add \
    tm-acme-engineering alice@example.com --role member
```

**Order matters.** If you add the new membership BEFORE removing the
old one, both rows are live simultaneously and her session still
resolves through the older default-team membership (createdAt
tie-break in `computeTeamChain`). The remove-then-add order avoids
this.

**Path B is not atomic** -- the two RPC calls succeed independently.
If step 3 fails (e.g. wrong team id, FK violation), alice is left
with zero live memberships and gets bounced to anonymous on every
request until you fix the input and re-run step 3. To minimize the
window, sanity-check the destination team first:

```bash
ark --token "$ACME_ADMIN_BEARER" team list | grep tm-acme-engineering
```

If atomicity matters, use Path A (the BEGIN/COMMIT wraps both rows).

### Path C: Dashboard UI

Only viable once you have **human admins pre-seeded into both
tenants** (via Path A or B first). The flow is then:

1. Default-tenant admin signs in via Google → `/admin → Teams → click
   default-team → Members table → Remove on alice's row`.
2. Sign out. Acme-tenant admin signs in via Google → `/admin → Teams
   → click tm-acme-engineering → Add member → type alice@example.com →
   choose role → Add`. The `MemberPicker` accepts free-form email
   even when alice has no prior acme membership; the server upserts.

Same `team_chain` caveat: alice must sign out and back in for team-
scope overrides to apply.

### Common mistake

**Adding to the new team WITHOUT removing from the old team does
not work.** The user ends up with two live memberships; their next
login resolves through the OLDER one (tenant A) because
`computeTeamChain` picks `memberships[0]` ordered by `createdAt ASC`.
Always do remove-then-add (or both within the same SQL transaction).

### When this gets cleaner

The system-admin role (deferred today, no firm date) collapses both
paths into a single dashboard action by a privileged operator. Per-
tenant JIT routing (also a follow-up) would eliminate the move
entirely for users whose email domain already maps to a known tenant.
For now, the SQL recipe IS the supported ops path -- it's not a
backdoor, it's the design.

## Recipe: Change a user's role in a team

**Dashboard:** Two paths --
- Team-centric: `/admin` → Teams → click the team → click the role
  dropdown on the user's row → pick the new role (inline update).
- User-centric: `/admin` → Users → click the user's row → in the
  drawer, change the role dropdown for the membership.

**CLI:**
```bash
# `team members set-role` takes <team-id> <email> <role> as
# positional args.
ark --token "$ADMIN_BEARER" team members set-role \
    tm-eng alice@example.com admin
```

The server's `admin/team/members/add` is also idempotent + updates
the role -- the dashboard picker uses this fact to flip its button
to "Update role" with a confirm dialog when the picked user is
already in the team with a different role.

## Recipe: Delete a user

A user can only be deleted from their **own tenant** if they have
zero memberships in any other tenant. Otherwise the cascade-soft-
delete would damage another tenant's audit trail -- the server
refuses with FORBIDDEN and a message that mentions "live
memberships in other tenants" and tells you to remove them via
`admin/team/members/remove` instead. (Exact wording lives in
`packages/conductor/handlers/admin.ts`.)

**To "remove a user from this tenant" without touching their global
identity**, use Recipe "Add or remove a user from a team" on each
of their team memberships in your tenant. That leaves the global
`users` row intact (and other tenants' memberships unaffected).

**To actually delete the global identity** (only possible if the
user lives only in your tenant):

**Dashboard:** `/admin` → Users → click `Delete` on the row
(confirm dialog).

**CLI:**
```bash
# Accepts either the user id (u-...) or the email as a positional
# argument.
ark --token "$ADMIN_BEARER" user delete alice@example.com
```

## Recipe: Set / update / delete a scoping override

See Part 3 §"Setting overrides (admin RPCs + CLI)" for
the full schema. Short form:

**Dashboard:** `/admin` → Scoping → `+ New override` → pick scope
kind / scope id / key → fill in the value (catalog dropdown for
runtime / model / compute.default; multi-select for flow.allowlist)
→ Create. Edit / Delete via the row's `Inspect` drawer.

**CLI:**
```bash
ark --token "$ADMIN_BEARER" scoping set \
    --scope tenant --scope-id $TENANT_ID --key runtime --value '"codex"'

ark --token "$ADMIN_BEARER" scoping delete \
    --scope tenant --scope-id $TENANT_ID --key runtime
```

Tenant-scope overrides require `scope_id === ctx.tenantId`;
team-scope overrides require the team to belong to the caller's
tenant; user-scope overrides require the user to have a live
membership in the caller's tenant. Validator rejections from
`admin-scoping-validators.ts` mirror these gates.

## Recipe: Mint / revoke / rotate an API key

**Mint (self-service):** Dashboard → Settings → API Keys → **Create
API key**. Key shown once in a takeover modal; copy it before
dismissing.

**Mint (admin minting one in the tenant):**
```bash
# Mints an "owner=NULL" key bound to <tenant>. There is no
# per-user-owner CLI flag today; admin-mint keys see the tenant
# scope chain only (no user / team chain). Self-service keys
# carry the owner chain.
ark --token "$ADMIN_BEARER" auth create-key \
    --tenant default --name "ci-key" --role member
```

**Revoke:** Dashboard → Settings → API Keys → Revoke on the row.
Or `ark --token "$ADMIN_BEARER" auth revoke-key <key-id>`.

**Rotate** (replace with a new key carrying the same metadata):
```bash
ark --token "$ADMIN_BEARER" auth rotate-key <key-id>
```

All these operations -- plus `restore` (un-soft-delete a revoked
key) -- are tenant-scoped: the caller can only touch keys in their
own tenant. The `tenant_id` parameter is optional on the delete /
restore / rotate routes; if omitted, the handler defaults to
`ctx.tenantId`, so a cross-tenant operation cannot happen even by
accident.

## Recipe: Inspect "what does this user see?"

Useful when a user reports "I can't see X" or "I have access to Y
that I shouldn't."

```bash
# What tenants is this user in?
sqlite3 ~/.ark/ark.db <<SQL
SELECT t.id AS tenant_id, t.slug, tm.name AS team_name, m.role
FROM users u
JOIN memberships m ON m.user_id = u.id AND m.deleted_at IS NULL
JOIN teams tm ON tm.id = m.team_id AND tm.deleted_at IS NULL
JOIN tenants t ON t.id = tm.tenant_id AND t.deleted_at IS NULL
WHERE u.email = 'alice@example.com';
SQL
```

```bash
# What scoping overrides exist in this tenant? Filter the live list
# to surface what would resolve for a given scope.
ark --token "$ADMIN_BEARER" scoping list
```

There is no per-user "what would resolve right now?" CLI today --
the precedence chain (user > team > tenant) is evaluated server-
side at `session/start`. To preview, set a session in the dashboard
and watch the `~/.ark/ark.jsonl` `"component":"scoping"` line that
fires on dispatch.

---

# Debugging (all three parts)

## Where to look

The daemon writes structured logs to `~/.ark/ark.jsonl` (or the
configured log dir in hosted mode). Each line is a JSON object with
`timestamp`, `level`, `component`, `message`, optional `data`.

Useful component filters:

| Component | What's in there |
| --- | --- |
| `auth` | Login attempts, account-takeover guard, session validation, sliding-expiry touches, OIDC verification failures. **Most entries are `debug` level** -- you'll need `ARK_LOG_LEVEL=debug` on the daemon to see them in `ark.jsonl`. The fail-loud paths (chain-broken team chain) log at `error` and are visible at default level. |
| `scoping` | Override hint applications / skips / catalog-race fallthroughs at dispatch |
| `session` | Session lifecycle (start, dispatch, advance, complete) -- includes generic dispatch errors |
| `general` | Catch-all (secrets placement, env merge, etc.) |

## Common queries

```bash
# Recent auth events (login attempts, sliding expiry, account takeover)
grep '"component":"auth"' ~/.ark/ark.jsonl | tail -20

# Recent scoping events (any consumer)
grep '"component":"scoping"' ~/.ark/ark.jsonl | tail -20

# All events for a specific session
grep "s-XXXXXX" ~/.ark/ark.jsonl | tail -50

# Just hint applications (the load-bearing scoping line)
grep '"component":"scoping"' ~/.ark/ark.jsonl | grep "applied"
```

## SQL health checks

Run against `~/.ark/ark.db` (local) or your prod DB. All read-only;
safe to run anytime.

```sql
-- Orphan users (zero live memberships anywhere). Orphans are a
-- legitimate intermediate state (cascade after a team / tenant
-- delete, or a user manually detached from every team), kept so
-- audit columns elsewhere (`created_by`, `deleted_by`, `actor_id`)
-- still resolve to a user row. Orphan users CANNOT log in -- the
-- session validator requires at least one live membership.
-- Investigate if the count is unexpectedly large; otherwise this is
-- informational.
SELECT u.id, u.email, u.created_at
FROM users u
LEFT JOIN memberships m
  ON m.user_id = u.id AND m.deleted_at IS NULL
WHERE u.deleted_at IS NULL AND m.id IS NULL;

-- Users with memberships spanning multiple tenants (consultant
-- pattern). Not an error -- but worth knowing about for cross-
-- tenant impact analysis before deletes.
SELECT u.email, COUNT(DISTINCT t.tenant_id) AS tenant_count
FROM users u
JOIN memberships m ON m.user_id = u.id AND m.deleted_at IS NULL
JOIN teams t ON t.id = m.team_id AND t.deleted_at IS NULL
WHERE u.deleted_at IS NULL
GROUP BY u.id
HAVING tenant_count > 1;

-- API keys per tenant (live only). Useful for "we have how many
-- admin keys floating around for prod?"
SELECT tenant_id, role, COUNT(*) AS n
FROM api_keys
WHERE deleted_at IS NULL
GROUP BY tenant_id, role
ORDER BY tenant_id, role;

-- Memberships whose team or tenant is soft-deleted (data
-- integrity violation -- normal cascade prevents this). Expected:
-- 0 rows. Investigate any rows that appear here.
SELECT m.id, m.user_id, m.team_id, t.tenant_id,
       t.deleted_at AS team_deleted, tn.deleted_at AS tenant_deleted
FROM memberships m
JOIN teams t ON t.id = m.team_id
JOIN tenants tn ON tn.id = t.tenant_id
WHERE m.deleted_at IS NULL
  AND (t.deleted_at IS NOT NULL OR tn.deleted_at IS NOT NULL);

-- Live overrides by scope + key for a given tenant. Quick survey
-- before changing org-level policy.
SELECT scope_kind, scope_id, key, value_json, set_by, updated_at
FROM scoping_overrides
WHERE tenant_id = 'default' AND deleted_at IS NULL
ORDER BY scope_kind, key;
```

## Auth-related messages

All `debug`-level unless noted; need `ARK_LOG_LEVEL=debug` on the
daemon to capture them in `ark.jsonl`.

| Message | Meaning |
| --- | --- |
| `auth session not found or expired` | A request came with a cookie that doesn't match a live `sessions_auth` row, or the row has past expiry. User needs to re-login. |
| `account-takeover guard: user X has google_sub mismatch` | An existing user row has `google_sub` set, but the incoming token has a different `sub`. Login refused with an opaque 401. |
| `team chain broken at <team_id> (cycle): contact admin to fix parent_team_id` | (`error` level -- visible at default log level) A user's team chain has a cycle (A → B → A). Login fails with a generic 401; ops needs to fix `parent_team_id` in SQL. |
| `sliding expiry: touchExpiry returned null` | A session row vanished between read and write. Best-effort, not fatal. |

## Scoping-related messages

| Message | Meaning |
| --- | --- |
| `runtime hint 'codex' applied (was 'claude-code', agent 'worker')` | Resolver returned `codex`, dispatch swapped it in. Normal happy path. |
| `runtime hint 'codex' ignored (agent 'X' has runtime_locked)` | Override resolved but the agent opted out. |
| `runtime hint 'codex' no longer registered; falling back to 'claude-code'` | Override was valid at session/start but the runtime YAML was deleted before dispatch. Rare race; in-flight session continues on agent's declared runtime. |
| Same shape for `model hint ...` lines. | Same semantics. |

## Confirming a hint landed on a session

```bash
sqlite3 ~/.ark/ark.db <<'SQL'
SELECT id, summary,
       json_extract(config, '$.scoping_runtime_hint') AS rt_hint,
       json_extract(config, '$.scoping_model_hint') AS model_hint,
       compute_name
FROM sessions
WHERE id = 's-XXXXXX';
SQL
```

The `scoping_*_hint` columns are present on `session.config` if the
resolver fired at start. `compute_name` is set directly (one-phase
consumer).

## When `session/start` fails with a runtime / model / compute error

Example error:

```
RpcError: Runtime override 'coddex' is not a registered runtime
(tenant=default). Update or remove the matching scoping_overrides row.
```

This means the resolver returned a value that doesn't match a
registered runtime / model / compute. Fix:

1. Find the offending row:

   ```sql
   SELECT id, scope_kind, scope_id, value_json
   FROM scoping_overrides
   WHERE key = 'runtime'  -- or 'model' / 'compute.default'
     AND value_json = '"coddex"'
     AND tenant_id = 'default'
     AND deleted_at IS NULL;
   ```

2. Either update `value_json` to a valid value or soft-delete the row.

## When login redirects to `/#login?error=...`

The error code points at the failing stage. Common values (the
emitted set may grow over time -- exhaustive list lives in
`packages/conductor/mounts/auth-routes.ts`):

| Error code | Likely cause |
| --- | --- |
| `google_not_configured` | One of `ARK_AUTH_GOOGLE_*` env vars unset on the daemon. The Google sign-in button still renders but redirects back with this banner. |
| `oauth_error` | Google itself returned an error (typically the user cancelled the consent screen or the OAuth client is misconfigured on Google's side). |
| `missing_params` | Callback hit without a `code` or `state` query param. Usually a malformed redirect. |
| `state_mismatch` | OAuth state cookie didn't match the callback's `state` query param. CSRF defense fired. Possible causes: cookie stripped by extension, multiple windows racing the flow, cookie-tossing attempt. |
| `token_exchange_failed` / `token_exchange_threw` | Server-to-Google code-for-token exchange failed. Check the daemon log for the underlying HTTP error. |
| `no_id_token` | Token-exchange response did not include an `id_token`. Almost always a misconfigured OAuth client (wrong scope, wrong response type). |
| `login_failed` | Catch-all for anything past token exchange: JWKS verify failure, `email_verified=false`, domain mismatch (`ARK_AUTH_GOOGLE_ALLOWED_DOMAINS`), account-takeover guard, team-chain broken, transaction failure. The opacity is intentional (no fingerprinting oracle). The daemon log distinguishes the cases server-side. |

For real diagnosis, check `~/.ark/ark.jsonl` for `"component":"auth"`
lines around the time of the failed attempt. The daemon log
distinguishes the cases server-side even though the browser response
doesn't.

## Common gotchas

| Gotcha | Symptom | Fix |
| --- | --- | --- |
| Shell escaping the JSON in scoping inserts | `value_json` stored as `[\"docs\"]` with literal backslashes; resolver throws on JSON.parse | Use the heredoc pattern |
| Wrong `tenant_id` in the override row | Override never applies; resolver ignores rows from other tenants | Verify `tenant_id` matches the calling user's tenant |
| Project-only models in override | `session/start` fails with "not a registered model" | At session/start there's no `projectRoot`; project-scoped models in `<repo>/.ark/models/` aren't visible. Use a globally-registered model |
| Caller passing `--runtime` / `--compute` | Override seems to not fire | Caller-explicit flags short-circuit the resolver. Check `session.config.scoping_*_hint` -- it'll be NULL when caller was explicit |
| Compute name from another tenant | "not a registered compute target" error | Compute names are tenant-scoped (`(name, tenant_id)` is the PK). Override has to name a compute in the calling user's tenant |
| Bearer token shadows cookie after sign-out | Logging out doesn't actually log out (next request still authed) | The dashboard's UserMenu Sign-out clears any localStorage Bearer token. If you're hitting the daemon directly with a saved Bearer + a stale cookie, the Bearer wins (Bearer-first precedence). Drop the Bearer to use the cookie |
| `Origin` header doesn't match allowlist | 401 on a POST that worked yesterday | Add the new origin to `ARK_AUTH_SESSION_ALLOWED_ORIGINS` and restart. Cookie-authed POSTs and WS upgrades enforce Origin |

---

# Current limitations (what's not yet supported)

## Auth (Part 1)

- **OIDC device flow not implemented.** CLI users still need to paste
  a Bearer token; there's no `ark login` that bounces a browser.
- **Single Google account per user record.** If a user changes their
  Google login email, the JIT user-creation will create a new row.
  Manual SQL merge needed if you want to consolidate.
- **No multi-IdP support.** Today is Google-only. Other OIDC
  providers (Azure AD, Okta) are a follow-up.
- **`default` tenant cannot be renamed or replaced.** The string
  `'default'` is baked into migration seeds (`003`, `017`), schema
  column defaults (`tenant_id TEXT NOT NULL DEFAULT 'default'`), and
  Google JIT-signup routing (`auth/login.ts` hardcodes
  `DEFAULT_TEAM_ID = "default-team"` in tenant `'default'`).
  `ARK_DEFAULT_TENANT` only affects `localAdminContext` and Temporal
  queue naming, **not** seeding or JIT routing. Custom tenants live
  alongside `default`, not in place of it. See Part 1 §"Database
  state" for the practical pattern. Parameterizing this end-to-end
  is a deferred follow-up.

## API keys (Part 2)

- **Per-key scope inheritance is fixed.** A self-service key inherits
  the owner's full chain (user / team / tenant); admin-mint keys see
  only tenant. There's no way to mint a key with a narrower scope (e.g.
  "only allowed to call `flow/list`").
- **No audit-trail UI.** Revoke history exists in the table
  (`deleted_at`, `deleted_by`) but there's no dashboard view.
- **`admin` role is tenant-scoped today** -- the consequences for
  the `admin/*` surface are listed under "Tenant-admin model" at
  the end of this section.

## Scoping (Part 3)

- ~~**No admin RPC for managing overrides.**~~ Added admin write
  RPCs + `ark scoping ...` CLI. Direct SQL is now a fallback, not
  the only path.
- ~~**No write-time validation.**~~ Admin RPCs validate every
  override at write time (runtime / model / compute / flow names
  must exist; tenant-scope rules enforced). Direct-SQL writers still
  bypass this -- bad rows surface at the next `session/start`.
- ~~**No dashboard UI for overrides.**~~ Added in the dashboard-UI
  PR: `/admin → Scoping` tab with list, filters, edit modal, audit
  drawer.
- **No pagination on `admin/scoping/list` or `admin/user/list`.** A
  safety cap of 1000 rows applies per call; the response carries a
  `truncated` boolean set via a `limit + 1` probe so operators know
  to filter further. Real cursor pagination is a follow-up --
  revisit before any tenant approaches the 1000-row cap.
- **Project-scoped models can't be used as override targets.**
  Validation runs against the global model catalog at session/start;
  models registered only under `<repo>/.ark/models/` aren't visible
  there. Use a globally-registered model.
- **Mid-session team-chain changes don't take effect immediately.**
  The chain is computed once at login and cached on
  `sessions_auth.team_chain`. If a user's team membership changes,
  they need to log out and back in for the new chain to apply.

## Tenant-admin model (gates applied PR #568)

- **No system-admin role yet (deferred by design, not a bug).**
  The `admin` role is tenant-scoped: cannot create new tenants,
  cannot enumerate or act across tenants, cannot soft-delete users
  that have memberships outside the caller's tenant. The system-
  admin tier is deliberately deferred -- the sanctioned ops paths
  today are direct DB access (RDS password / `sqlite3`) and the
  two-admin-keys-via-dashboard workaround. Both are documented in
  Part 4 §"Move a user between tenants". Until system-admin lands,
  these operations return FORBIDDEN to all callers:
  - `admin/tenant/create` -- a new tenant is operator-tier work
  - Cross-tenant user / team / scoping inspection -- no "see
    everything" mode for support engineers yet
  - Cross-tenant `admin/team/members/remove` -- moving a user
    requires SQL or paired admin sessions; see the Part 4 recipe
- **Tenant creation is via direct SQL until then.** See Part 4
  §"Create a new tenant".
- **OIDC JIT-signup is not per-tenant routed.** Google sign-ins
  always land in the seeded `default` tenant's `default-team`,
  regardless of email domain. Users in non-`default` tenants must
  authenticate via Bearer keys today.
- **Tombstone GC for `scoping_overrides` not implemented.**
  Soft-deleted overrides accumulate indefinitely. A periodic
  sweep (`ark scoping gc --older-than 90d`) is a deferred
  follow-up.
