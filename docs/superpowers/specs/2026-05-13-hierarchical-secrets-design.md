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

### Typed-secrets decisions: what this spec preserves vs supersedes

| Typed-secrets decision | This spec |
|---|---|
| Schema shape (`type`, `metadata`, bytes) | **Preserved** |
| Per-type placer architecture + per-provider `PlacementCtx` | **Preserved** |
| v1 type taxonomy (`env-var`, `ssh-private-key`, `generic-blob`, `kubeconfig`) | **Preserved** |
| Narrowing filter (stage / runtime YAML `secrets: [NAME]` lists) | **Preserved** -- applies on top of the per-user resolved set |
| `ssh-keyscan` execution on the control plane | **Preserved** |
| **Auto-attach all tenant secrets to every session** (typed-secrets D2) | **SUPERSEDED** -- the input to `placeAllSecrets` is now the per-user effective set produced by this layer's resolver, not the flat tenant secret list. Operator must explicitly accept this supersession before implementation begins; it is the load-bearing motivation for this entire spec. |
| Phasing of typed-secrets work | **Preserved**, with explicit sequencing below |

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
    load.ts                      # EnvKekBackend: reads ARK_MASTER_KEY, validates 32 bytes
    memory.ts                    # SecureBuffer: zero-on-free off-heap buffers
  tenant-dek.ts                  # per-tenant DEK generation, wrap/unwrap, cache
  cipher.ts                      # AES-256-GCM wrapper with AAD discipline
  service.ts                     # SecretsService: read/write/resolve API
  resolver.ts                    # scope walker (user -> teamChain -> tenant)
  registry.ts                    # secret_keys_registry CRUD + required_at_scope
  audit.ts                       # audit log writer
  onboarding/
    tenant.ts                    # ark onboard tenant
    team.ts                      # ark onboard team
    user.ts                      # ark onboard user
    seed-registry.json           # built-in registry seed for first boot
  placement-isolation.ts         # RAM-backed FS invariant per (compute, isolation) combo
  routes/
    registry.ts                  # /secrets/registry
    bindings.ts                  # /secrets/bindings
    audit.ts                     # /secrets/audit
    onboarding.ts                # /onboarding/{tenant,team,user}
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

**Daemon-to-daemon (conductor -> arkd over HTTP) does NOT get its own `kind`.** The bearer token between daemons authenticates the *channel*, not an identity. Daemon callers are required to forward the originating `SecretsCallerContext` in a signed sidecar header (`X-Ark-Caller-Ctx`, HMAC'd with the inter-daemon shared secret). The receiving daemon verifies the HMAC and re-hydrates the context. There is no path by which a daemon HTTP caller can invoke the secrets service without a forwarded user/api_key/system context -- the service rejects requests whose channel-auth succeeded but whose `X-Ark-Caller-Ctx` is missing or fails HMAC verification.

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

Five new tables in `packages/secrets/schema/{sqlite,postgres}.ts`. SQLite and Postgres definitions are identical except for column types where required.

### `tenant_deks`

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | TEXT PRIMARY KEY | FK `tenants.id` ON DELETE CASCADE |
| `wrapped_dek` | BLOB NOT NULL | AES-256-GCM ciphertext of the 32-byte tenant DEK |
| `nonce` | BLOB NOT NULL | 12 bytes |
| `tag` | BLOB NOT NULL | 16 bytes |
| `kek_version` | INTEGER NOT NULL DEFAULT 1 | Supports future master KEK rotation |
| `dek_version` | INTEGER NOT NULL DEFAULT 1 | Incremented on tenant DEK rotation |
| `created_at` | INTEGER NOT NULL | epoch ms |
| `rotated_at` | INTEGER NULL | last rotation; NULL if never rotated |

One row per tenant. Generated by `ark onboard tenant` immediately after the `tenants` row is created. Unwrapped DEK is cached in arkd RAM per tenant for the daemon's lifetime; cache invalidated on rotation. The master KEK never touches this table -- only the wrapped output does.

### `secret_blobs`

| Column | Type | Notes |
|---|---|---|
| `ref` | TEXT PRIMARY KEY | UUID; opaque identifier referenced by bindings |
| `tenant_id` | TEXT NOT NULL | FK `tenants.id` ON DELETE CASCADE; defense-in-depth filter; determines which tenant DEK to use |
| `ciphertext` | BLOB NOT NULL | AES-256-GCM ciphertext, **encrypted with the tenant DEK** (not the master KEK) |
| `nonce` | BLOB NOT NULL | 12 bytes, per-secret random |
| `tag` | BLOB NOT NULL | 16-byte GCM tag (may be appended to ciphertext; column kept separate for clarity) |
| `aad_fingerprint` | TEXT NOT NULL | SHA-256 hex of the AAD that was bound to this ciphertext; used for tamper detection |
| `dek_version` | INTEGER NOT NULL DEFAULT 1 | Which version of the tenant DEK encrypted this blob; supports gradual re-encryption during rotation |
| `created_at` | INTEGER NOT NULL | epoch ms |
| Indexes | `(tenant_id)` |

The cipher's storage shape (string vs blob) is **derived** from the binding's `secret_type` (env-var / ssh-private-key / kubeconfig -> string; generic-blob -> blob). No `value_kind` column on `secret_blobs` -- single source of truth lives on the binding.

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
| `required_at_scope` | TEXT NULL | One of `"tenant" \| "team" \| "user" \| null`. Drives onboarding wizards. A `null` value means "not surfaced as a required key at any onboarding step". |
| `secret_type` | TEXT NULL | Default typed-secrets shape for bindings created against this key, when not specified on the binding. `"env-var" \| "ssh-private-key" \| "generic-blob" \| "kubeconfig"`. |
| `description` | TEXT NULL | |
| `created_by_user_id` | TEXT NULL | |
| `created_at` | INTEGER NOT NULL | |
| `updated_at` | INTEGER NOT NULL | |
| Primary key | `(tenant_id, key)` |

Registration is required iff Open Question Q1 chooses strict mode (see below). Default v1: registry is **advisory** -- bindings can exist for any key, but if the key is registered as `locked` the policy is enforced. The registry is also the source of truth for **onboarding wizards** (see §Onboarding wizards) and for default secret types when CLI / API callers don't specify one.

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

Two-layer envelope encryption: per-tenant **Data Encryption Key (DEK)** encrypts secrets; a single **master Key Encryption Key (KEK)** wraps every tenant DEK. The master KEK never touches the data store; tenant DEKs are only stored wrapped.

### Layer 1 -- Per-secret cipher

- **Algorithm:** AES-256-GCM with a 12-byte per-secret random nonce and a 16-byte auth tag.
- **Key:** the tenant's DEK (32 bytes). Distinct from every other tenant's DEK.
- **AAD:** `tenant_id || 0x00 || scope_kind || 0x00 || scope_id || 0x00 || key || 0x00 || secret_type`. Verified at decrypt -- tampering with any AAD field (e.g. copying a ciphertext to a different scope, swapping a binding's `secret_type`) causes decryption to fail.
- **AAD fingerprint** (SHA-256 hex of the AAD bytes) is stored on `secret_blobs.aad_fingerprint` for row-level tamper detection at audit time before a decrypt is attempted.

### Layer 2 -- Tenant DEK wrapping

- Each tenant has one 32-byte DEK generated at tenant creation (`crypto.randomBytes(32)`).
- The DEK is encrypted with the master KEK (AES-256-GCM, AAD = `"dek" || 0x00 || tenant_id`) and stored in `tenant_deks`.
- On first use per tenant, arkd unwraps the DEK into a `SecureBuffer` and caches it for the daemon's lifetime. Cache is invalidated on tenant DEK rotation.

**Property -- "DB dump alone is useless":** a leaked `pg_dump` contains ciphertexts and wrapped DEKs but no master KEK. The master KEK lives outside the data store entirely (see Master KEK custody). An attacker with the DB but not the env var cannot decrypt anything.

**Property -- "per-tenant cryptographic isolation":** even if app code had a bug that mis-scoped a query, ciphertext from tenant A still requires tenant A's DEK to decrypt; tenant B's DEK does not produce valid plaintext (AAD includes `tenant_id`, so cross-tenant attempts fail GCM verification).

### Master KEK custody (`EnvKekBackend` only)

The master KEK is provided **only** via the `ARK_MASTER_KEY` environment variable:

- 32 bytes, base64-encoded.
- Injected by the orchestrator that owns deployment secrets: k8s `Secret` mounted via env-from or projected via `LoadCredential=`, systemd `LoadCredential=`, Nomad/ECS native secret injection, or a Vault Agent sidecar.
- arkd reads it once at startup, materializes it as a `SecureBuffer` (`packages/secrets/kek/memory.ts`), and disposes on shutdown.
- Missing or non-32-byte values fail startup with a clear error including the generator command:
  ```bash
  export ARK_MASTER_KEY="$(openssl rand -base64 32)"
  ```

**No layered fallback.** The original draft of this spec included `OS keychain -> $ARK_DIR/.master.key (auto-generated) -> --unlock passphrase` chain. v1 ships **only** `EnvKekBackend`. Rationale: the env var path is the only one that works uniformly across desktop, hosted, and CI deployments without bespoke per-platform code (keychain shims, Argon2id derivation, file-permission threat model carve-outs), and orchestrator-managed env injection is already the production posture for every other secret in those deployments. A `KekBackend` interface is **not** introduced -- a single `loadMasterKey(): Promise<SecureBuffer>` function is sufficient. Future backends (cloud KMS, Vault) can be added when a concrete deployment requests one.

**Loss of `ARK_MASTER_KEY` is irrecoverable** -- every tenant DEK and therefore every secret becomes undecryptable. Backup of the env var to whatever long-term store the orchestrator already uses is the operator's responsibility.

### `SecureBuffer`

`packages/secrets/kek/memory.ts` allocates 32-byte off-heap `Buffer`s for the master KEK and unwrapped tenant DEKs, zeros them on `dispose()`, and avoids V8 string interning. JavaScript cannot guarantee that no GC copy leaks; this is harm reduction (heap dumps don't yield interned strings) not a proof. The implementation is shared between the master KEK and tenant DEK caches.

### Key rotation (v1 capability, not workflow)

Two rotation primitives. Both supported as capabilities; the workflows (background job, progress tracking) are v2.

- **Tenant DEK rotation.** Generate a new DEK, rewrap under the master KEK, increment `tenant_deks.dek_version`. Existing `secret_blobs` keep their old `dek_version` and are gradually re-encrypted on next write or by an explicit `ark secrets rotate-dek --tenant=<id>` sweep. Mixed-version reads are supported by keeping the old wrapped DEK alongside the new during the transition window.
- **Master KEK rotation.** Operator rotates `ARK_MASTER_KEY` in the orchestrator's secret store, then runs `ark secrets rewrap-deks --from-old-key=<base64>` which unwraps every `tenant_deks` row with the old KEK and rewraps with the new. `secret_blobs` are untouched. The `tenant_deks.kek_version` column is incremented.

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

All routes mount under `/secrets/` and `/onboarding/`. `TenantContext` and `SecretsCallerContext` are pre-resolved by middleware.

| Method | Path | Capability | Description |
|---|---|---|---|
| `POST` | `/secrets/registry` | `secrets.registry.write` | Register a key with policy (`locked` / `overridable`) and optional `required_at_scope` + `secret_type` |
| `GET`  | `/secrets/registry` | `secrets.metadata.read` | List registered keys for caller's tenant |
| `PUT`  | `/secrets/bindings` | computed by `canWrite()` per body | Create or update one binding |
| `DELETE` | `/secrets/bindings` | computed by `canWrite()` per body | Delete one binding |
| `GET`  | `/secrets/bindings` | `secrets.metadata.read` (results filtered by what caller can see) | List binding *metadata* (key, scope, set-by, updated-at). Never plaintext. |
| `GET`  | `/secrets/audit` | `secrets.audit.read` | Tenant-scoped audit log; query params for filters |
| `GET`  | `/onboarding/tenant` | `secrets.bindings.tenant.write` | List required-but-unset tenant-scope keys for the caller's tenant |
| `POST` | `/onboarding/tenant` | `secrets.bindings.tenant.write` | Submit values for one or more tenant-scope required keys (multi-write transaction) |
| `GET`  | `/onboarding/team?team_id=<id>` | `secrets.bindings.team.write` | List required-but-unset team-scope keys for the given team |
| `POST` | `/onboarding/team` | `secrets.bindings.team.write` | Submit values for one or more team-scope required keys |
| `GET`  | `/onboarding/user` | `secrets.bindings.user.write.self` | List required-but-unset user-scope keys for the caller |
| `POST` | `/onboarding/user` | `secrets.bindings.user.write.self` | Submit values for one or more user-scope required keys |

Read-of-plaintext is reserved to dispatch (`kind=system`); there is no plaintext-fetch endpoint over HTTP.

The CLI (`ark secrets ...` and `ark onboard ...`) wraps these endpoints. The CLI's local mode (no daemon, direct DB) goes through the same `SecretsService` API and the same authorization checks against a locally-constructed `SecretsCallerContext`.

---

## Onboarding wizards

The "easy first-run" UX hinges on three CLI flows that walk the registry for keys marked `required_at_scope` and prompt for the corresponding bindings. Each wraps the same `PUT /secrets/bindings` endpoint with discovery + prompt orchestration on top.

### `ark onboard tenant`

Runs once per tenant immediately after the `tenants` row is created. Sequence:

1. **Provision tenant DEK** -- `tenant-dek.ts` generates 32 random bytes, wraps with master KEK, inserts the `tenant_deks` row. Idempotent: if the row exists, this step is a no-op.
2. **Walk required keys** -- `SELECT key, secret_type FROM secret_keys_registry WHERE tenant_id=? AND required_at_scope='tenant' AND <no existing tenant binding>`.
3. **Prompt** -- for each key, prompt the tenant admin (TTY) or read from `ARK_ONBOARD_<KEY>=value` env vars (`--non-interactive`).
4. **Write bindings** -- one `PUT /secrets/bindings` per key, all at `scope_kind="tenant"`.
5. **Idempotent re-run** -- re-running only prompts for missing keys; satisfied keys are skipped with a one-line note.

### `ark onboard team <team_id>`

Walks `required_at_scope='team'`, prompts the team admin, writes at `scope_kind="team"`. Authorization: `secrets.bindings.team.write` + live team admin membership check (same path as `canWrite()`).

### `ark onboard user`

User self-walks. Walks `required_at_scope='user'`, defaults `scope_id=caller.userId`, prompts for personal credentials.

For `secret_type="ssh-private-key"`, offers two modes:
- **Paste-existing** -- user pastes a PEM (default; works with hardware keys backed by SSH agents).
- **Generate** -- runs `ssh-keygen -t ed25519 -N "" -f -` in a tmpfs, uploads the private key as the secret, prints the public key for the user to register at GitHub/etc.

### Registry seed (`required_at_scope` defaults)

Ark ships with a seed registry (`packages/secrets/onboarding/seed-registry.json`) loaded on first boot per tenant:

| Key | Policy | Required at | Secret type |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | overridable | tenant | env-var |
| `OPENAI_API_KEY` | overridable | -- | env-var |
| `GOOGLE_API_KEY` | overridable | -- | env-var |
| `CLAUDE_SUBSCRIPTION_BLOB` | overridable | user | generic-blob |
| `GITHUB_TOKEN` | overridable | user | env-var |
| `SSH_PRIVATE_KEY` | overridable | user | ssh-private-key |
| `NPM_TOKEN` | overridable | -- | env-var |
| `KUBECONFIG` | overridable | -- | kubeconfig |
| `AWS_ACCESS_KEY_ID` | locked | -- | env-var |
| `AWS_SECRET_ACCESS_KEY` | locked | -- | env-var |

`required_at_scope` defaults are tuned to the "minimum to make a session productive" set, not "every supported key". Operators add or override per tenant via `POST /secrets/registry`. A team admin can mark additional keys as `required_at_scope="team"` (e.g., a team-specific Linear PAT) without affecting other tenants.

### Failure semantics

- A `required_at_scope` key with no binding at session start emits a `system_warning` audit row (`outcome="not_found"`) and the placer skips that key. Dispatch does **not** fail -- this preserves dev ergonomics where a user hasn't completed `ark onboard user` yet. If the agent's flow YAML lists that key under a stage-level `secrets: [NAME]` narrowing filter, the existing typed-secrets behavior takes over (typically a stage-level failure).
- Onboarding is **never** invoked transparently from a session. It is always an explicit `ark onboard ...` invocation.

---

## Runtime materialization (where secrets land on the agent)

Two enforced rules govern what touches what kind of filesystem.

### Rule 1 -- RAM-backed FS for file-based placers

Every placer that writes a file writes to a per-session RAM-backed filesystem. Bytes never reach a block device. Implementation per compute+isolation combo:

- **Linux host:** mount `tmpfs` at `/run/ark/session/<session_id>/` with `noexec`, `nosuid`, `mode=0700`, owner = the agent UID.
- **Docker isolation:** add `--tmpfs /run/ark:rw,noexec,nosuid,size=64m` to the container run command.
- **Kubernetes:** mount a Volume `emptyDir: { medium: Memory, sizeLimit: 64Mi }` at `/run/ark`.
- **MicroVM (Firecracker, Kata):** the rootfs is already RAM-backed; placer just uses an in-rootfs path that the cleanup teardown unlinks.
- **EC2 / remote:** the agent provisioning step mounts a tmpfs as part of cloud-init before `DeferredPlacementCtx` replays the queued file ops.

On session teardown, the tmpfs is unmounted (or the container/VM is destroyed); RAM is reclaimed by the kernel.

### Rule 2 -- `LocalCompute` + `direct` isolation is env-var-only

`LocalCompute.capabilities.supportsSecretMount` is already `false` (see `packages/core/compute/local.ts:47`). This combination shares the host's filesystem with arkd and other sessions; the operator cannot give it a true RAM-backed mount without root.

When the (compute, isolation) combination resolves to `LocalCompute` + `direct`, the dispatcher inspects the effective secret set and **rejects dispatch** if any binding has `secret_type ∈ {ssh-private-key, kubeconfig, generic-blob-as-file}`. Error message names the offending key(s) and suggests `--isolation=docker` or a different compute target.

Env-var-only secrets (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, etc.) work fine on this combination -- they go into the agent process's env, never to disk.

### Capability matrix (declared per compute, enforced at placer construction)

| Compute | Isolation | RAM-backed FS available? | File-based secrets allowed? |
|---|---|---|---|
| `LocalCompute` | `direct` | No (shares arkd's FS) | **No** -- env-var only |
| `LocalCompute` | `docker` | Yes (`--tmpfs`) | Yes |
| `LocalCompute` | `compose` | Yes (per-service `tmpfs`) | Yes |
| `LocalCompute` | `devcontainer` | Yes (`--tmpfs`) | Yes |
| `K8sCompute` | `pod` | Yes (`emptyDir.medium=Memory`) | Yes |
| `K8sKataCompute` | `pod` | Yes (microVM rootfs + tmpfs) | Yes |
| `Ec2Compute` | `remote` | Yes (per-instance tmpfs via cloud-init) | Yes |
| `FirecrackerCompute` | `vm` | Yes (microVM rootfs + tmpfs) | Yes |

The matrix is enforced at **placer construction time**, not runtime -- a session targeting `LocalCompute`+`direct` with an SSH key in its effective set fails dispatch with a clear error before any secret is decrypted. This avoids the "agent ran, then crashed" failure mode and keeps decryption tied to a session that will actually use the result.

### What about plaintext in arkd's RAM?

Plaintext is unavoidable in arkd's process RAM during dispatch -- we have to hand actual bytes to the placer. The cost is bounded by Q2's plaintext-cache decision (default: dropped after `placeAllSecrets` returns). `SecureBuffer` is used for the decrypted values during placement to reduce the heap-dump exposure window, with the same JS-can't-fully-prevent-this caveat that applies to the master KEK.

---

## Backwards compatibility

### Existing `tenant_claude_auth`

Becomes a thin shim. The table stays. Reads delegate to `SecretsService.resolve(systemCtx, {tenantId, userId: null, teamChain: []}, "ANTHROPIC_API_KEY" | <blob name>)`. Writes get a deprecation warning and a follow-up issue is tracked for removing the shim. Existing tenants experience no change in behaviour.

### Typed-secrets `secrets.json` (v2 file)

The migration step:

1. Boot detects `secrets.json` (any version) and `arkDir/secrets.db` absent or empty.
2. **Provision the tenant DEK** if `tenant_deks` has no row for the tenant: generate 32 random bytes, wrap with master KEK (AES-256-GCM, AAD `"dek" || tenant_id`), insert. Idempotent.
3. For each entry in `secrets.json`, write a row into `secret_blobs` (encrypted with the **tenant DEK**, AAD bound to `(tenant_id, "tenant", tenant_id, key, secret_type)`), and a corresponding row into `secret_bindings` with `scope_kind="tenant", scope_id=tenant_id`. Type and metadata copied from the v2 envelope.
4. Rename `secrets.json` to `secrets.json.migrated`. Daemon logs a one-time migration event.

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
- `cipher.test.ts` -- AAD round-trip, tamper detection (mutate `tenant_id`, `scope_id`, `key`, expect decrypt failure), `dek_version` byte handling.
- `kek-load.test.ts` -- missing `ARK_MASTER_KEY` fails with helpful error; wrong byte length fails; valid 32-byte base64 returns `SecureBuffer`.
- `tenant-dek.test.ts` -- generation produces 32 random bytes; wrap/unwrap round-trip; AAD `"dek" || tenant_id` binding prevents cross-tenant unwrap; cache invalidation on rotation.
- `resolver.test.ts` -- precedence walk, `policy=locked` enforcement on read, missing key returns null, deep teamChain.
- `service.test.ts` -- `canWrite()` matrix per caller context type; self-write vs admin override branch selection; live membership check for team writes.
- `audit.test.ts` -- every action emits exactly one row with correct fields; plaintext-not-logged invariant tested by mutating decoded payload.
- `onboarding.test.ts` -- wizard walks `required_at_scope` for each scope; idempotent re-run skips satisfied keys; non-interactive mode reads `ARK_ONBOARD_<KEY>` env; SSH keypair generation mode produces matching public key.
- `placement-isolation.test.ts` -- `LocalCompute`+`direct` with an SSH-key binding in the effective set fails dispatch pre-decryption with a named error; other combos accept file-based types.

**Integration (`packages/secrets/__tests__/`):**
- `resolution.integration.test.ts` -- boot `AppContext.forTestAsync()`, seed tenant + teams + users + bindings, run `effectiveSecretsForSession`, assert correct top-down resolution and that the output feeds `placeAllSecrets` correctly (via a mock provider).
- `dek-rotation.test.ts` -- rotate tenant DEK, confirm mixed-version reads work during transition window, confirm sweep re-encrypts all blobs to new `dek_version`.
- `kek-rotation.test.ts` -- `rewrap-deks --from-old-key=<>` correctly rewraps every `tenant_deks` row; secret_blobs untouched; old KEK no longer needed after sweep.
- `migration.test.ts` -- legacy `secrets.json` v1 + v2 both migrate; idempotent on second run; encrypted output verifiable.
- `tenant_claude_auth.compat.test.ts` -- existing tenant-claude-auth flow continues to work via the shim.
- `tmpfs-runtime.test.ts` -- on each compute+isolation combo declaring RAM-backed FS, confirm placed files land on a `tmpfs`-like mount (Linux: `findmnt`; k8s: `emptyDir.medium=Memory` in pod spec; docker: container inspect).

**Cross-tenant isolation:**
- `isolation.test.ts` -- attempt every write/read/list operation with tenant A's context against tenant B's data; assert every attempt is denied or returns empty.

**Authorization matrix:**
- `auth-matrix.test.ts` -- table-driven test with rows for (caller kind, capability set, scope_kind, scope_id, expected outcome). Catches regressions in `canWrite()`.

---

## Phasing

| Phase | Scope |
|---|---|
| Phase 1 -- Foundation | Schema migrations (including `tenant_deks`), `SecretsService`, `EnvKekBackend` (`loadMasterKey`), per-tenant DEK wrap/unwrap + `SecureBuffer`, AES-GCM cipher, `secrets.json` migration, registry seed loader. No HTTP routes yet. Read path operates via in-process `kind=system`. `tenant_claude_auth` shim wired. `LocalCompute`+`direct` file-secret rejection check wired into dispatch. |
| Phase 2 -- HTTP & CLI & Onboarding | `/secrets/registry`, `/secrets/bindings`, `/secrets/audit`, `/onboarding/{tenant,team,user}` routes. `ark secrets ...` and `ark onboard ...` CLI commands. Capability middleware enforces. Onboarding wizards walk the registry. |
| Phase 3 -- Hierarchy in dispatch | `effectiveSecretsForSession` replaces flat tenant list in dispatch. RAM-backed FS placement enforced per (compute, isolation) capability matrix. End-to-end resolution observable in audit log. |

Each phase has its own implementation plan; this design covers all three.

### Sequencing with the typed-secrets work

Both specs have Phase 1/2/3. They are **not** independent. Gate dependencies:

| Typed-secrets phase | This spec's phase | Order |
|---|---|---|
| TS Phase 1 (schema migration: `type` + `metadata` on stored secrets) | -- | **Must land first**. This spec's `secret_bindings.secret_type` and `metadata_json` columns directly mirror that shape; landing this before TS Phase 1 would create a fork. |
| TS Phase 2 (`ssh-private-key` placer + EC2 unblock) | -- | Can land in parallel with this spec's Phase 1 (foundation). They touch disjoint code. |
| -- | This Phase 1 (foundation: schema, KEK, cipher, service) | Lands after TS Phase 1. Migration code converts existing tenant-only secrets into `scope_kind="tenant"` bindings. |
| -- | This Phase 2 (HTTP + CLI) | Lands after this Phase 1. |
| TS Phase 3 (generalise: claude-blob deletion, full provider coverage) | This Phase 3 (hierarchy in dispatch) | Must land **together** -- the moment dispatch starts feeding the per-user effective set into `placeAllSecrets`, the typed-secrets generalisation must be in place so every type is handled. |

Recommended cut: ship `[TS-1, TS-2, This-1, This-2]` as a coherent slice, then `[TS-3, This-3]` as the second slice.

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

**Volume driver to note:** the dominant audit-row producer is **resolution at dispatch**, not writes. A tenant with N registered secrets and S sessions/day emits ~N*S resolve rows/day, plus a smaller number of write rows. For a tenant with 30 secrets and 100 sessions/day, that's 3000 resolve rows/day -- ~1M/year. Retention strategy should be sized to this, not to write volume.

| Option | Implication |
|---|---|
| **A. Indefinite (v1 default)** | Simplest; grows linearly with resolutions, not writes. |
| **B. TTL-driven (e.g. 90 days), rolling delete background job** | Bounded growth; needs a scheduler. Configurable per tenant. |
| **C. Tenant-controlled retention with admin-set TTL** | Compliance-friendly; more configuration surface. |
| **D. Split tables: writes (indefinite) + resolves (TTL'd)** | Keeps the compliance-relevant write trail forever; cheap-to-lose resolve trail rolls. Two tables, one query helper. |

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
| D4 | KEK strategy | **SUPERSEDED.** v1 uses **per-tenant DEK wrapped by master KEK** (envelope encryption). Secrets are encrypted with the tenant's DEK; the DEK is wrapped with the master KEK and stored in `tenant_deks`. Property: DB dump alone is useless; tenant A's DEK cannot decrypt tenant B's ciphertext (AAD-bound). `kek_version` + `dek_version` columns support independent rotation. |
| D5 | KEK source | **SUPERSEDED.** v1 ships **`EnvKekBackend` only** -- master KEK loaded from `ARK_MASTER_KEY` env var (32 bytes base64). No layered fallback, no OS keychain, no auto-generated file, no `--unlock` passphrase. Orchestrator (k8s Secret / systemd LoadCredential / Vault Agent) owns custody. Missing or wrong-length env fails startup with the `openssl rand -base64 32` hint. |
| D6 | Write permissions | **Strict per level**: users write only their own user-level scope; team admins write their team's scope; tenant admins can force-write anywhere (audited as `admin_override`). Audit logging required from v1. |
| D7 | Implementation approach | **Approach B -- standalone Secrets Service** package (`packages/secrets`), in-process inside `arkd` for v1, extractable to a separate process later without changing consumers |
| D8 | Admin's own user-level secrets | Same path as any user: `scope_kind="user", scope_id=self.userId`. Authorization branch is self-write, *not* admin override. No audit flag. |
| D9 | Endpoint structure | **Single `PUT /secrets/bindings` endpoint**; the `canWrite()` function is the only place that distinguishes self-write / team-admin / tenant-admin / admin-override. URLs carry no role gate. |
| D10 | Authorization vocabulary | **Capabilities, not roles**. Secrets code asks `caller.capabilities.has(...)`; the role-to-capability map lives in `packages/core/auth/capabilities.ts` and is the single edit point for future RBAC. |
| D11 | Relationship to typed-secrets design | This spec **extends** `2026-04-30-typed-secrets-design.md`. Placement layer (per-type placers + per-provider `PlacementCtx`) is unchanged; this layer produces the effective tenant secret set that feeds into the existing pipeline. |
| D12 | Plaintext after write | Admins force-writing a binding receive no read-back of plaintext. Self-writes flow back at dispatch as plaintext, as expected. |
| D13 | **Supersession of typed-secrets D2 (auto-attach all tenant secrets to every session)** | **Pending explicit operator confirmation.** This spec replaces auto-attach with per-user resolution via `effectiveSecretsForSession`. It is the load-bearing motivation for this design; without superseding D2, hierarchy cannot exist. Operator must accept before implementation begins. |
| D14 | Daemon-to-daemon caller | Daemon HTTP callers forward the originating `SecretsCallerContext` via HMAC-signed sidecar header. No new caller `kind`; channel auth is separate from identity auth. |
| D15 | Cipher storage shape | Derived from `secret_type` on the binding. No redundant `value_kind` column. AAD binds `secret_type`. |
| D16 | Onboarding UX | Three CLI wizards (`ark onboard {tenant,team,user}`) walk `required_at_scope` registry entries. Tenant wizard provisions the tenant DEK as its first step. All wizards wrap the same `PUT /secrets/bindings` endpoint -- no privileged side path. Required keys missing at session start emit a warning, do not block dispatch (preserves dev ergonomics). |
| D17 | Registry seed | Ark ships `seed-registry.json` with sensible `policy` + `required_at_scope` + `secret_type` for the canonical key set (LLM provider keys, GITHUB_TOKEN, SSH_PRIVATE_KEY, CLAUDE_SUBSCRIPTION_BLOB, NPM_TOKEN, KUBECONFIG, AWS_*). Loaded on first boot per tenant; operators override per tenant via `POST /secrets/registry`. |
| D18 | Runtime materialization | Every file-based placer writes to a per-session RAM-backed FS (tmpfs / `emptyDir.medium=Memory` / docker `--tmpfs` / microVM rootfs). Enforced by a declared capability matrix per (compute, isolation) combination. **`LocalCompute` + `direct` is restricted to env-var secret types only** -- file-based secret types fail dispatch with a clear error before decryption. |
| D19 | Plaintext in arkd RAM | Plaintext is unavoidable during placement. Q2 still governs cache lifetime. `SecureBuffer` used for in-flight plaintext to reduce heap-dump exposure; JS GC can still copy -- this is harm reduction, not proof. |
| D20 | `KekBackend` interface | **Not introduced in v1.** A single `loadMasterKey(): Promise<SecureBuffer>` function is enough while only one backend exists. The interface seam can be added later when a concrete second backend (cloud KMS, Vault) is requested. YAGNI. |

---

## References

- `docs/superpowers/specs/2026-04-30-typed-secrets-design.md` -- typed-secrets foundation
- `packages/core/secrets/types.ts` -- existing `SecretsCapability`
- `packages/core/scoping/resolver.ts` -- existing precedent for `user -> team -> tenant` walks
- `packages/core/drizzle/schema/sqlite.ts` -- `tenants`, `teams`, `users`, `memberships`, `api_keys`, `sessions_auth`, `scoping_overrides`, `tenant_claude_auth`
- `packages/conductor/mounts/auth-routes.ts` -- caller context resolution
- `packages/core/services/dispatch-claude-auth.ts` -- existing tenant-claude-auth dispatch path (will be replaced by the typed-secrets generalisation)
