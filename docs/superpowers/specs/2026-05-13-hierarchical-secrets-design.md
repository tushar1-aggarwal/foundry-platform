# Hierarchical Secrets -- Design Spec

## Goal

Add a **tenant -> team -> user** hierarchy on top of Ark's secrets model so that secret values can be set at multiple levels and resolve top-down per key, with per-key policy controlling whether lower levels may override. Encrypt every stored secret at rest using a single Key Encryption Key (KEK) resolved from a layered chain that adapts to desktop, hosted, and dev deployments. Authorize callers by **capability**, not role, so the design is forward-compatible with future RBAC without churning secrets code. Emit an audit log for every write and every dispatch-time resolution.

## Relationship to the existing typed-secrets design

This spec **builds on** `2026-04-30-typed-secrets-design.md` -- it does **not** replace it.

| Concern | Owner |
|---|---|
| Secret shape (type, metadata, bytes), per-type placers, per-provider `PlacementCtx`, dispatch placement loop | Typed-secrets design (unchanged) |
| Scope (tenant / team / user), per-key policy, encryption at rest, KEK resolution, capability-based authorization, audit log | **This spec** |

The composition: this layer produces the **effective tenant-scoped secret set** for a given session by walking `user -> teamChain -> tenant` per key and honoring per-key policy. That set is then handed to the existing `placeAllSecrets(...)` pipeline as if it were a flat tenant secret list -- the placer layer is unaware of scope. Migration is therefore additive: existing tenant-only secrets become rows with `scope_kind="tenant", scope_id=<tenant_id>` and continue to flow through the typed-secrets pipeline unchanged.

## Context

### What exists today

- **Auth.** Google OIDC cookies plus API keys (`api_keys` table, roles `admin|member|viewer|worker`); `sessions_auth` caches user identity and `teamChain` at login. Conductor middleware resolves a `TenantContext` per request.
- **Tenancy.** `tenants`, hierarchical `teams` (self-referencing `parent_team_id`, 5-level deep), `users`, and `memberships(user_id, team_id, role)`. All session/compute/message rows carry `tenant_id`.
- **Scoping precedent.** `scoping_overrides` table already resolves config values across `user -> team -> tenant` via `ScopingResolver`; most-specific match wins.
- **Secrets backend.** `SecretsCapability` with two providers: `FileSecretsProvider` (local plaintext `secrets.json`) and `AwsSecretsProvider` (AWS SSM Parameter Store). String namespace plus blob namespace. The typed-secrets design (above) adds typed shape on top.
- **Tenant-only secret binding.** `tenant_claude_auth` (migration 007) is the one existing per-tenant binding; the typed-secrets design generalizes that to all tenant secrets.

### What's missing

- No team-level or user-level secret bindings.
- No encryption at rest in local/desktop deployments (`secrets.json` is plaintext today).
- No per-key policy ("compliance-locked" vs "user can override").
- No audit log for secret reads or writes.
- Authorization is keyed on role enum values, not capabilities, so adding a new role today requires editing every `role === "admin"` check.

### Non-goals for v1

- A policy engine / ABAC / OPA / Cedar -- capability strings are the only authorization vocabulary; the role-to-capability map is a static module.
- Per-tenant configurable role definitions -- roles remain the existing four enum values; only their *meaning* (capability set) is in one file.
- BYOK (bring-your-own-KEK per tenant). Single global KEK in v1. Schema permits future extension; not implemented.
- Secret rotation tooling (two-phase / next-then-current). v1 is write-once-replace; rotation tooling is v2.
- A new web UI. CLI and HTTP endpoints in v1; UI tracks separately.
- Workspace-scoped secrets. Hierarchy is tenant / team / user only.

---

## Architecture

### Package layout

```
packages/secrets/
  index.ts                       # public service interface
  schema/{sqlite,postgres}.ts    # new tables (see Schema below)
  kek/
    resolver.ts                  # layered resolver: env -> keychain -> file -> passphrase
    keychain/{darwin,linux,win32}.ts
    memory.ts                    # zero-on-free buffers
  cipher.ts                      # AES-256-GCM wrapper with AAD discipline
  service.ts                     # SecretsService: read/write/resolve API
  resolver.ts                    # scope walker (user -> teamChain -> tenant)
  audit.ts                       # audit log writer
  routes/
    registry.ts                  # /secrets/registry
    bindings.ts                  # /secrets/bindings
    audit.ts                     # /secrets/audit
  __tests__/
```

v1 runs in-process inside `arkd`. The package boundary is sharp so it can be extracted to a separate process later by replacing in-process calls with HTTP without changing consumers.

### Caller context and capabilities

Every entry point requires a resolved caller context produced by the existing conductor / arkd middleware. The secrets service does not parse cookies or headers.

```ts
type Capability =
  | "secrets.registry.write"
  | "secrets.bindings.tenant.write"
  | "secrets.bindings.team.write"        // requires team membership param
  | "secrets.bindings.user.write.self"
  | "secrets.bindings.user.write.other"  // admin force-write
  | "secrets.metadata.read"
  | "secrets.audit.read";

type SecretsCallerContext =
  | { kind: "user_session"; tenantId; userId; teamChain: string[]; capabilities: Set<Capability>; sessionAuthId }
  | { kind: "api_key";      tenantId; userId: string | null;       capabilities: Set<Capability>; apiKeyId }
  | { kind: "system";       tenantId; onBehalfOfUserId?: string;   reason: string };
```

Role -> capability mapping lives in `packages/core/auth/capabilities.ts` (new). v1 mapping:

```ts
const ROLE_CAPS = {
  admin:  new Set([
    "secrets.registry.write",
    "secrets.bindings.tenant.write",
    "secrets.bindings.team.write",
    "secrets.bindings.user.write.self",
    "secrets.bindings.user.write.other",
    "secrets.metadata.read",
    "secrets.audit.read",
  ]),
  member: new Set([
    "secrets.bindings.user.write.self",
    "secrets.metadata.read",
  ]),
  viewer: new Set(["secrets.metadata.read"]),
  worker: new Set([]),  // sessions don't write; resolution goes through kind=system
};
```

`kind=system` bypasses capability checks but only at **allow-listed call sites** enumerated in `packages/secrets/service.ts` as a frozen `Set<string>` (v1: `"dispatch.session"`, `"migration.tenant_claude_auth_shim"`, `"migration.secrets_json_import"`). Adding a new system call site requires an explicit code edit to that set, reviewed as a security change. Every `kind=system` call is audited with `actor_kind="system"`, `caller_reason=<allow-listed name>`, `on_behalf_of_user_id=<userId>`.

---

## Schema

Four new tables in `packages/secrets/schema/{sqlite,postgres}.ts`. SQLite and Postgres definitions are identical except for column types where required.

### `secret_blobs`

| Column | Type | Notes |
|---|---|---|
| `ref` | TEXT PRIMARY KEY | UUID; opaque identifier referenced by bindings |
| `tenant_id` | TEXT NOT NULL | FK `tenants.id` ON DELETE CASCADE; defense-in-depth filter |
| `ciphertext` | BLOB NOT NULL | AES-256-GCM ciphertext |
| `nonce` | BLOB NOT NULL | 12 bytes, per-secret random |
| `tag` | BLOB NOT NULL | 16-byte GCM tag (may be appended to ciphertext; column kept separate for clarity) |
| `aad_fingerprint` | TEXT NOT NULL | SHA-256 hex of the AAD that was bound to this ciphertext; used for tamper detection |
| `value_kind` | TEXT NOT NULL | `"string"` or `"blob"` -- matches existing `SecretsCapability` split |
| `created_at` | INTEGER NOT NULL | epoch ms |
| Indexes | `(tenant_id)` |

### `secret_bindings`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `tenant_id` | TEXT NOT NULL | FK `tenants.id` ON DELETE CASCADE |
| `scope_kind` | TEXT NOT NULL | `"tenant" \| "team" \| "user"` |
| `scope_id` | TEXT NOT NULL | tenant_id / team_id / user_id depending on `scope_kind` |
| `key` | TEXT NOT NULL | e.g. `GITHUB_TOKEN`. Matches typed-secrets name regex. |
| `secret_ref` | TEXT NOT NULL | FK `secret_blobs.ref` |
| `secret_type` | TEXT NOT NULL | `"env-var" \| "ssh-private-key" \| "generic-blob" \| "kubeconfig"` (from typed-secrets design) |
| `metadata_json` | TEXT NOT NULL | typed-secrets metadata; empty `{}` if unused |
| `created_by_user_id` | TEXT NULL | NULL for `kind=system` writes |
| `created_at` | INTEGER NOT NULL | epoch ms |
| `updated_at` | INTEGER NOT NULL | epoch ms |
| `admin_override` | INTEGER NOT NULL DEFAULT 0 | 1 if this binding was force-written cross-user by an admin |
| Unique index | `(tenant_id, scope_kind, scope_id, key)` -- one live binding per (scope, key) |
| Lookup index | `(tenant_id, key, scope_kind)` -- supports resolution walk |

### `secret_keys_registry`

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | TEXT NOT NULL | FK `tenants.id` ON DELETE CASCADE |
| `key` | TEXT NOT NULL | |
| `policy` | TEXT NOT NULL | `"locked" \| "overridable"` |
| `description` | TEXT NULL | |
| `created_by_user_id` | TEXT NULL | |
| `created_at` | INTEGER NOT NULL | |
| `updated_at` | INTEGER NOT NULL | |
| Primary key | `(tenant_id, key)` |

Registration is required iff Open Question Q1 chooses strict mode (see below). Default v1: registry is **advisory** -- bindings can exist for any key, but if the key is registered as `locked` the policy is enforced.

### `secret_audit_log`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `tenant_id` | TEXT NOT NULL | |
| `ts` | INTEGER NOT NULL | epoch ms |
| `actor_kind` | TEXT NOT NULL | `"user_session" \| "api_key" \| "system"` (matches `SecretsCallerContext.kind`) |
| `actor_id` | TEXT NULL | user_id or api_key_id; NULL for system |
| `on_behalf_of_user_id` | TEXT NULL | populated for `kind=system` resolutions |
| `action` | TEXT NOT NULL | `"register_key" \| "set_policy" \| "put_binding" \| "delete_binding" \| "resolve" \| "list_metadata" \| "audit_read"` |
| `scope_kind` | TEXT NULL | |
| `scope_id` | TEXT NULL | |
| `key` | TEXT NULL | |
| `outcome` | TEXT NOT NULL | `"ok" \| "denied" \| "not_found" \| "error"` |
| `admin_override` | INTEGER NOT NULL DEFAULT 0 | derived flag |
| `caller_reason` | TEXT NULL | for `kind=system`, the allow-listed call-site name |
| `session_id` | TEXT NULL | populated for resolve events |
| `ip` | TEXT NULL | for HTTP-originated actions |
| Indexes | `(tenant_id, ts DESC)`, `(tenant_id, key, ts DESC)`, `(tenant_id, scope_kind, scope_id, ts DESC)` |

Plaintext is never logged. Bytes are never logged. `aad_fingerprint` is logged only to the `secret_blobs` row, never to audit.

---

## Resolution algorithm

```ts
function resolve(ctx, sessionScope, key): Plaintext | null {
  // sessionScope = { tenantId, userId, teamChain: string[] }
  // teamChain is ordered most-specific -> least-specific (immediate team first, root team last)

  const registry = registryFor(ctx.tenantId, key);          // may be null
  const isLocked = registry?.policy === "locked";

  // Walk in precedence order: user -> teams (most-specific first) -> tenant
  const order = [
    { kind: "user", id: sessionScope.userId },
    ...sessionScope.teamChain.map(t => ({ kind: "team", id: t })),
    { kind: "tenant", id: sessionScope.tenantId },
  ];

  if (isLocked) {
    // Locked: only the tenant-level binding may resolve. Lower bindings are ignored
    // (and their existence should already have been rejected at write time).
    const tenantBinding = lookupBinding(ctx.tenantId, "tenant", sessionScope.tenantId, key);
    return tenantBinding ? decrypt(tenantBinding) : null;
  }

  for (const scope of order) {
    const b = lookupBinding(ctx.tenantId, scope.kind, scope.id, key);
    if (b) return decrypt(b);
  }
  return null;
}
```

**Write-side policy enforcement.** When `policy === "locked"`, `putBinding` rejects with 403 unless `scope_kind === "tenant"`. The check happens *before* encryption so no orphan blobs are created.

**TeamChain refresh.** Reads/resolutions use the cached `teamChain` from `sessions_auth.team_chain` (acceptable: a removed user's running session continues until logout, matching how any other resource works). Writes never trust the cache -- `canWrite()` for `scope_kind="team"` performs a **live membership check**, defined as a direct `SELECT role FROM memberships WHERE user_id=? AND team_id=? AND tenant_id=? AND deleted_at IS NULL` against the primary DB at request time (no cache, no `teamChain` read).

---

## Encryption

### Cipher

- **Algorithm:** AES-256-GCM. Per-secret random 12-byte nonce. 16-byte auth tag.
- **AAD:** `tenant_id || 0x00 || scope_kind || 0x00 || scope_id || 0x00 || key || 0x00 || value_kind`. Computed deterministically at encrypt and verified at decrypt. Tampering with any AAD field (e.g. copying a ciphertext to a different tenant row) causes decryption to fail.
- **AAD fingerprint** (SHA-256 hex of the AAD bytes) is stored on `secret_blobs.aad_fingerprint` to detect row-level tampering at audit time even before a decrypt is attempted.

### KEK lifecycle

- **Type:** 32-byte symmetric key, never written in plaintext to anything `arkd` controls beyond the file-fallback case.
- **Held in:** a `SecureBuffer` (`packages/secrets/kek/memory.ts`) that disables V8 string interning, allocates an off-heap `Buffer`, and zeros it on `dispose()`. Best-effort -- JS cannot guarantee no GC copies -- but materially harder to retrieve from a heap dump than a string.
- **Lifetime:** loaded once at daemon startup, kept resident for the daemon's lifetime, disposed at shutdown.

### Layered KEK resolver

Tried in order; first hit wins, with a structured log line at startup naming the source.

| Order | Source | When it fires |
|---|---|---|
| 1 | `ARK_MASTER_KEY` env var (base64, 32 bytes) | Set by operator -- hosted, k8s `Secret` mounted via `LoadCredential=`, Vault agent, systemd creds |
| 2 | OS keychain entry `ark.master-key` | Desktop: macOS Keychain, Linux libsecret, Windows DPAPI |
| 3 | `$ARK_DIR/.master.key` (mode 0600, 32 random bytes) | Auto-generated on first start if no other source. Startup logs a warning that key is on disk; dev-safe, prod-bad. |
| 4 | `--unlock <passphrase>` CLI flag | Argon2id-derived; for single-tenant high-security operators who explicitly opt in. Blocks until provided. |

A `KekSource` enum is recorded on every daemon-start audit event so operators can confirm the active source.

### Key rotation (v1 capability, not workflow)

`packages/secrets/cipher.ts` supports a `kekVersion` byte prefix on `ciphertext` so a future rotation can rewrap secrets without schema changes. v1 always emits version `0x01`. The rotation *workflow* (background job, progress tracking) is v2.

---

## Authorization (unified `canWrite`)

```ts
function canWrite(caller, scope_kind, scope_id, key): WriteDecision {
  // Self-write: any user-session or user-owned API key can write its own user-level scope
  if (scope_kind === "user" && scope_id === caller.userId
      && caller.capabilities.has("secrets.bindings.user.write.self")) {
    return { allow: true, adminOverride: false };
  }

  // Team admin: live membership check
  if (scope_kind === "team"
      && caller.capabilities.has("secrets.bindings.team.write")
      && hasLiveAdminMembership(caller.userId, scope_id, caller.tenantId)) {
    return { allow: true, adminOverride: false };
  }

  // Tenant admin
  if (scope_kind === "tenant"
      && caller.capabilities.has("secrets.bindings.tenant.write")
      && scope_id === caller.tenantId) {
    return { allow: true, adminOverride: false };
  }

  // Tenant admin force-writing a user-level or team-level binding (cross-user / cross-team)
  if (caller.capabilities.has("secrets.bindings.user.write.other")
      && tenantMatches(caller.tenantId, scope_kind, scope_id)) {
    return { allow: true, adminOverride: true };
  }

  return { allow: false };
}
```

A single endpoint `PUT /secrets/bindings` covers every case; the URL has no role gate. The branch chosen is what determines whether the audit row carries `admin_override=true`.

**Plaintext-after-write rule:** the response to `putBinding` is `{ok, ref, scope, key, updated_at}` -- never the plaintext. An admin who force-writes a user-level secret never retains read access to that plaintext; rotation requires another force-write. The one natural exception is self-writes: those plaintext values flow back to the owner at dispatch time, which is expected.

---

## HTTP API surface

All routes mount under `/secrets/`. `TenantContext` and `SecretsCallerContext` are pre-resolved by middleware.

| Method | Path | Capability | Description |
|---|---|---|---|
| `POST` | `/secrets/registry` | `secrets.registry.write` | Register a key with policy (`locked` / `overridable`) |
| `GET`  | `/secrets/registry` | `secrets.metadata.read` | List registered keys for caller's tenant |
| `PUT`  | `/secrets/bindings` | computed by `canWrite()` per body | Create or update one binding |
| `DELETE` | `/secrets/bindings` | computed by `canWrite()` per body | Delete one binding |
| `GET`  | `/secrets/bindings` | `secrets.metadata.read` (results filtered by what caller can see) | List binding *metadata* (key, scope, set-by, updated-at). Never plaintext. |
| `GET`  | `/secrets/audit` | `secrets.audit.read` | Tenant-scoped audit log; query params for filters |

Read-of-plaintext is reserved to dispatch (`kind=system`); there is no plaintext-fetch endpoint over HTTP.

The CLI (`ark secrets ...`) wraps these endpoints. The CLI's local mode (no daemon, direct DB) goes through the same `SecretsService` API and the same authorization checks against a locally-constructed `SecretsCallerContext`.

---

## Backwards compatibility

### Existing `tenant_claude_auth`

Becomes a thin shim. The table stays. Reads delegate to `SecretsService.resolve(systemCtx, {tenantId, userId: null, teamChain: []}, "ANTHROPIC_API_KEY" | <blob name>)`. Writes get a deprecation warning and a follow-up issue is tracked for removing the shim. Existing tenants experience no change in behaviour.

### Typed-secrets `secrets.json` (v2 file)

The migration step:

1. Boot detects `secrets.json` (any version) and `arkDir/secrets.db` absent or empty.
2. For each entry in `secrets.json`, write a row into `secret_blobs` (encrypted with the current KEK, AAD bound to `(tenant_id, "tenant", tenant_id, key, value_kind)`), and a corresponding row into `secret_bindings` with `scope_kind="tenant", scope_id=tenant_id`. Type and metadata copied from the v2 envelope.
3. Rename `secrets.json` to `secrets.json.migrated`. Daemon logs a one-time migration event.

`AwsSecretsProvider` (SSM) migration is operator-driven via `ark secrets migrate --from=ssm` -- not automatic, because SSM may be shared with other systems. The command is idempotent.

### Typed-secrets placement pipeline

Untouched. `placeAllSecrets` keeps consuming a flat tenant secret set; this layer just produces a different set by walking scope.

The session's effective secret list at dispatch time:

```ts
async function effectiveSecretsForSession(app, session): Promise<TypedSecret[]> {
  const ctx = { kind: "system", tenantId: session.tenant_id, onBehalfOfUserId: session.user_id, reason: "dispatch.session" };
  // teamChain is sourced from sessions_auth.team_chain (the cache populated at login).
  // No new column on `sessions` is required.
  const sessionScope = {
    tenantId: session.tenant_id,
    userId: session.user_id,
    teamChain: await app.auth.getTeamChainForUser(session.user_id, session.tenant_id),
  };
  const keys = await app.secrets.listKeysForScope(ctx, sessionScope); // union of keys reachable from this scope
  const out: TypedSecret[] = [];
  for (const key of keys) {
    const v = await app.secrets.resolve(ctx, sessionScope, key);
    if (v) out.push(v);  // resolve returns the typed shape (type, metadata, bytes)
  }
  return out;
}
```

The narrowing filter from the typed-secrets design (stage / runtime YAML `secrets: [NAME]` lists) continues to apply on top of this set, unchanged.

---

## Testing strategy

**Unit (`packages/secrets/__tests__/`):**
- `cipher.test.ts` -- AAD round-trip, tamper detection (mutate `tenant_id`, `scope_id`, `key`, expect decrypt failure), KEK version byte.
- `kek-resolver.test.ts` -- precedence order, fallback paths, file-on-disk warning emission, OS-keychain mocks per platform.
- `resolver.test.ts` -- precedence walk, `policy=locked` enforcement on read, missing key returns null, deep teamChain.
- `service.test.ts` -- `canWrite()` matrix per caller context type; self-write vs admin override branch selection; live membership check for team writes.
- `audit.test.ts` -- every action emits exactly one row with correct fields; plaintext-not-logged invariant tested by mutating decoded payload.

**Integration (`packages/secrets/__tests__/`):**
- `resolution.integration.test.ts` -- boot `AppContext.forTestAsync()`, seed tenant + teams + users + bindings, run `effectiveSecretsForSession`, assert correct top-down resolution and that the output feeds `placeAllSecrets` correctly (via a mock provider).
- `migration.test.ts` -- legacy `secrets.json` v1 + v2 both migrate; idempotent on second run; encrypted output verifiable.
- `tenant_claude_auth.compat.test.ts` -- existing tenant-claude-auth flow continues to work via the shim.

**Cross-tenant isolation:**
- `isolation.test.ts` -- attempt every write/read/list operation with tenant A's context against tenant B's data; assert every attempt is denied or returns empty.

**Authorization matrix:**
- `auth-matrix.test.ts` -- table-driven test with rows for (caller kind, capability set, scope_kind, scope_id, expected outcome). Catches regressions in `canWrite()`.

---

## Phasing

| Phase | Scope |
|---|---|
| Phase 1 -- Foundation | Schema migrations, `SecretsService`, KEK resolver, AES-GCM cipher, `secrets.json` migration. No HTTP routes yet. Read path operates via in-process `kind=system`. `tenant_claude_auth` shim wired. |
| Phase 2 -- HTTP & CLI | `/secrets/registry`, `/secrets/bindings`, `/secrets/audit` routes. `ark secrets ...` CLI generalised to set scope. Capability middleware enforces. |
| Phase 3 -- Hierarchy in dispatch | `effectiveSecretsForSession` replaces flat tenant list in dispatch. Team-chain snapshot persisted on session at start. End-to-end resolution observable in audit log. |

Each phase has its own implementation plan; this design covers all three.

---

## Open questions

These remain undecided. Each is presented with options the operator can pick before implementation planning.

### Q1. Should the key registry be **strict** (every key must be pre-registered) or **advisory** (free-form, registry only matters for `locked` policy)?

| Option | Implication |
|---|---|
| **A. Advisory (default of this spec)** | Any key name can be bound. Registry exists only to attach a policy. Easier UX; users / agents can introduce new keys without admin friction. |
| **B. Strict** | `putBinding` rejects keys not pre-registered. Catches typos like `GIHTUB_TOKEN` early; forces deliberate vocabulary; admin gatekeeping. |
| **C. Per-tenant toggle** | Tenant-level setting; defaults advisory, can be flipped to strict for compliance-sensitive tenants. |

### Q2. How long is plaintext cached in memory after `resolve()`?

| Option | Implication |
|---|---|
| **A. Never cached** | Every dispatch re-decrypts. Simple, safest. Cost: one AES-GCM op per secret per session start (negligible). |
| **B. Cached for the lifetime of the placement loop** | Single fetch per session start, dropped after `placeAllSecrets` returns. Hard to misuse. |
| **C. Cached per-session for the session's lifetime** | Faster re-dispatch, more surface area for memory disclosure. |

### Q3. Should there be a `workspace`-level scope between team and user?

| Option | Implication |
|---|---|
| **A. No workspace scope (v1 of this spec)** | Three levels only. Simpler model; matches `scoping_overrides` today. |
| **B. Add `scope_kind="workspace"` between team and user** | Five levels total. Useful for "this Bitbucket key is just for this workspace's repo". Increases resolver complexity and audit volume. |

### Q4. Should admin reads of user-level secret *metadata* be allowed?

| Option | Implication |
|---|---|
| **A. Yes -- admins can list metadata at any scope (default)** | Necessary for "what secrets does this user have set?" debugging. Metadata only -- no plaintext. |
| **B. No -- admins see tenant/team metadata only; user-level metadata is owner-only** | Stronger user privacy. Operationally harder when supporting a user. |

### Q5. Audit log retention?

| Option | Implication |
|---|---|
| **A. Indefinite (v1 default)** | Simplest; grows linearly. |
| **B. TTL-driven (e.g. 90 days), rolling delete background job** | Bounded growth; needs a scheduler. Configurable per tenant. |
| **C. Tenant-controlled retention with admin-set TTL** | Compliance-friendly; more configuration surface. |

### Q6. What happens when a user is removed from a team while they have a running session that's still resolving secrets via the cached `teamChain`?

| Option | Implication |
|---|---|
| **A. Cached chain stays valid for the session's lifetime (default)** | Matches every other resource the session can access. Worst case: a removed user's session reads team secrets until the session ends. |
| **B. Re-resolve on every secret read** | Tighter security boundary; adds a DB hit per resolution. |
| **C. Re-resolve at session-resume boundaries only** | Compromise; needs an event hook. |

### Q7. Plaintext error messages?

| Option | Implication |
|---|---|
| **A. Generic errors over HTTP ("forbidden", "not found")** | No info leakage about which secret exists or which capability is missing. |
| **B. Detailed errors for the caller's own scope, generic above** | More helpful UX without leaking what's set at higher scopes. |

---

## Decisions log

These were decided during the 2026-05-13 brainstorming session and are locked unless re-opened.

| # | Decision | Choice |
|---|---|---|
| D1 | Secret classes covered | LLM provider keys, compute provider credentials, agent integration tokens, arbitrary user-defined secrets -- all four classes use the same model |
| D2 | Resolution rule | **Tenant policy decides per-key**: each key in the registry is `locked` (tenant value only, lower bindings rejected at write time) or `overridable` (most-specific wins, user > team > tenant) |
| D3 | Storage / encryption | **In-house, in this repo**. Not AWS KMS, not external vault. Encrypted-at-rest using AES-256-GCM with AAD binding (tenant_id, scope_kind, scope_id, key, value_kind) |
| D4 | KEK strategy | **Single global KEK encrypts every secret directly** (no per-tenant DEKs in v1). KEK version byte on ciphertext enables future rotation without schema change. |
| D5 | KEK source | **Layered resolver**: `ARK_MASTER_KEY` env -> OS keychain (`ark.master-key`) -> `$ARK_DIR/.master.key` (mode 0600, auto-generated) -> `--unlock <passphrase>`. First hit wins; source logged at startup. |
| D6 | Write permissions | **Strict per level**: users write only their own user-level scope; team admins write their team's scope; tenant admins can force-write anywhere (audited as `admin_override`). Audit logging required from v1. |
| D7 | Implementation approach | **Approach B -- standalone Secrets Service** package (`packages/secrets`), in-process inside `arkd` for v1, extractable to a separate process later without changing consumers |
| D8 | Admin's own user-level secrets | Same path as any user: `scope_kind="user", scope_id=self.userId`. Authorization branch is self-write, *not* admin override. No audit flag. |
| D9 | Endpoint structure | **Single `PUT /secrets/bindings` endpoint**; the `canWrite()` function is the only place that distinguishes self-write / team-admin / tenant-admin / admin-override. URLs carry no role gate. |
| D10 | Authorization vocabulary | **Capabilities, not roles**. Secrets code asks `caller.capabilities.has(...)`; the role-to-capability map lives in `packages/core/auth/capabilities.ts` and is the single edit point for future RBAC. |
| D11 | Relationship to typed-secrets design | This spec **extends** `2026-04-30-typed-secrets-design.md`. Placement layer (per-type placers + per-provider `PlacementCtx`) is unchanged; this layer produces the effective tenant secret set that feeds into the existing pipeline. |
| D12 | Plaintext after write | Admins force-writing a binding receive no read-back of plaintext. Self-writes flow back at dispatch as plaintext, as expected. |

---

## References

- `docs/superpowers/specs/2026-04-30-typed-secrets-design.md` -- typed-secrets foundation
- `packages/core/secrets/types.ts` -- existing `SecretsCapability`
- `packages/core/scoping/resolver.ts` -- existing precedent for `user -> team -> tenant` walks
- `packages/core/drizzle/schema/sqlite.ts` -- `tenants`, `teams`, `users`, `memberships`, `api_keys`, `sessions_auth`, `scoping_overrides`, `tenant_claude_auth`
- `packages/conductor/mounts/auth-routes.ts` -- caller context resolution
- `packages/core/services/dispatch-claude-auth.ts` -- existing tenant-claude-auth dispatch path (will be replaced by the typed-secrets generalisation)
