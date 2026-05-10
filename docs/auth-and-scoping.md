# Phase 1 Auth: Onboarding Guide

This guide walks you through enabling, using, and configuring the
Phase 1 auth stack. Three parts:

1. **Google OIDC login** -- browser users sign in with Google; the
   server mints an HttpOnly cookie session.
2. **Self-service API keys** -- CLI / programmatic users mint and
   revoke their own bearer tokens through the dashboard.
3. **Scoping overrides** -- a single override surface (user / team /
   tenant scoped) for org-level configuration like default flows,
   runtimes, models, and compute targets.

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

Phase 1 is **opt-in**. Local development with no env vars set runs in
single-user-admin mode and bypasses all three parts. Hosted /
multi-user deployments enable Phase 1 by setting the env vars in
Part 1.

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
| `ARK_AUTH_REQUIRE_TOKEN` | yes | `false` | Master switch. When `false`, the daemon runs in local-admin mode and ignores both cookies and Bearer tokens. Set to `true` to enable Phase 1. |
| `ARK_AUTH_GOOGLE_CLIENT_ID` | yes (for browser login) | unset | The OAuth 2.0 web-application client ID from Google Cloud Console (e.g. `1234567890-abcdef.apps.googleusercontent.com`). |
| `ARK_AUTH_GOOGLE_CLIENT_SECRET` | yes (for browser login) | unset | The matching client secret. Treat as a secret. |
| `ARK_AUTH_GOOGLE_REDIRECT_URI` | yes (for browser login) | unset | Must match exactly what's configured in the Google OAuth client. Typical values: `http://localhost:5173/auth/google/callback` (dev) or `https://yourhost.com/auth/google/callback` (prod). |
| `ARK_AUTH_GOOGLE_ALLOWED_DOMAINS` | recommended | unset (= all `@*` allowed) | Comma-separated list of email domains permitted to log in (e.g. `paytm.com,paytm.in`). Login fails closed for any other domain. |
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
   has a valid team chain to walk.
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
on a fresh install -- typically the first admin key is minted via
direct DB insert during initial deployment.)

```bash
ark --token "$ADMIN_BEARER" auth create-key \
  --name "ci-pipeline-key" --role admin --tenant default
```

The output prints the plaintext key once. Save it.

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

There's no admin RPC or dashboard UI yet -- everything goes through
direct SQL inserts on the `scoping_overrides` table (covered below).

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

## Setting overrides (SQL playbook)

The `scoping_overrides` table is modified by direct SQL until admin
RPCs land. Connect via `sqlite3` (local) or your Postgres client
(hosted).

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
  ('user-rachna-compute', 'user', 'u-4acda986d4d9', 'compute.default',
   '"rachna-laptop"', 'default',
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
  ('rachna-compute', 'user', 'u-4acda986d4d9', 'compute.default',
   '"rachna-laptop"', 'default',
   datetime('now'), datetime('now'));
SQL
```

Any session rachna starts (without `--compute`) defaults to her
laptop. She can still override per-session with `ark session start
--compute foo`.

### 5. Personal preference vs. tenant policy: who wins?

If both are set, **the most specific scope wins**. So:
- Tenant override `runtime = "claude-code"` (admin-set policy)
- User override `runtime = "codex"` (rachna's personal preference)

When rachna dispatches, she gets `codex` (user-level beats tenant).

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

# Phase 1 limitations (what's not yet supported today)

## Auth (Part 1)

- **OIDC device flow not implemented.** CLI users still need to paste
  a Bearer token; there's no `ark login` that bounces a browser.
- **Single Google account per user record.** If a user changes their
  Google login email, the JIT user-creation will create a new row.
  Manual SQL merge needed if you want to consolidate.
- **No multi-IdP support.** Phase 1 is Google-only. Other OIDC
  providers (Azure AD, Okta) are a follow-up.

## API keys (Part 2)

- **Per-key scope inheritance is fixed.** A self-service key inherits
  the owner's full chain (user / team / tenant); admin-mint keys see
  only tenant. There's no way to mint a key with a narrower scope (e.g.
  "only allowed to call `flow/list`").
- **No audit-trail UI.** Revoke history exists in the table
  (`deleted_at`, `deleted_by`) but there's no dashboard view.

## Scoping (Part 3)

- **No admin RPC for managing overrides.** All inserts / updates /
  deletes go through direct SQL on the `scoping_overrides` table.
- **No dashboard UI for overrides.** Use `sqlite3` or a SQL client
  like DBeaver to view / edit rows.
- **No write-time validation.** A typo'd value lands in the table
  successfully but fails the next session/start with a clear error
  (e.g. `Runtime override 'coddex' is not a registered runtime`). Fix
  by updating or soft-deleting the row.
- **Project-scoped models can't be used as override targets.**
  Validation runs against the global model catalog at session/start;
  models registered only under `<repo>/.ark/models/` aren't visible
  there. Use a globally-registered model.
- **Mid-session team-chain changes don't take effect immediately.**
  The chain is computed once at login and cached on
  `sessions_auth.team_chain`. If a user's team membership changes,
  they need to log out and back in for the new chain to apply.
