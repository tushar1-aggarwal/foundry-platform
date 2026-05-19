# SSM-backed KEK Backend -- Addendum

**Status:** addendum to `2026-05-13-hierarchical-secrets-design.md`. Supersedes D5 and D20.

## What changes

| ID | Original decision | Supersession |
|---|---|---|
| D5 | `EnvKekBackend` only; master KEK from `ARK_MASTER_KEY` env var; no layered fallback | **Superseded.** v1 ships **`SsmKekBackend` only**. Master KEK is a `SecureString` parameter in AWS SSM Parameter Store. No `EnvKekBackend`. |
| D20 | `KekBackend` interface not introduced in v1; single `loadMasterKey()` function | **Superseded.** `KekBackend` interface is introduced in v1. `SsmKekBackend` is its first concrete implementation. The seam is load-bearing from day one so subsequent backends (Vault, GCP Secret Manager, cloud KMS-direct) can be added without changing consumers. |

Everything else in the hierarchical-secrets design (per-tenant DEK, AES-256-GCM cipher with AAD discipline, two-layer envelope encryption, the "DB dump alone is useless" property, rotation primitives, `SecureBuffer`, etc.) is preserved unchanged. Only the **provenance of the master KEK** changes.

## Goal

Ship a `KekBackend` interface plus the first concrete implementation against AWS SSM Parameter Store, such that arkd can boot, load a 32-byte master KEK from an SSM SecureString parameter into a `SecureBuffer`, and hand that buffer to the (forthcoming) tenant-DEK and cipher modules. This is the *seam*, not the full hierarchical-secrets feature -- it unblocks downstream phases without locking the master KEK story to env-var custody.

## Non-goals

- Per-tenant DEK code (lands in the next plan).
- Cipher, resolver, audit, HTTP routes, CLI onboarding -- all later phases.
- KEK rotation workflow. The `kek_version` column from the original spec is honored; the rotation sweep is a v2 capability.
- KMS-direct envelope (calling `kms:Encrypt`/`kms:Decrypt` per tenant DEK with no local KEK material). That is a fundamentally different KekBackend shape and is left for a future addendum.
- A web-UI surface. CLI / config flags only.

## Architecture

### Package layout

```
packages/secrets/
  kek/
    backend.ts      # KekBackend interface + LoadedKek result type
    memory.ts       # SecureBuffer (32-byte off-heap, zero-on-dispose)
    ssm.ts          # SsmKekBackend implementation
    load.ts         # selectKekBackend(config) factory + loadMasterKey(config)
    __tests__/
      memory.test.ts
      backend.contract.test.ts   # contract any backend must satisfy
      ssm.test.ts                # mocked SSMClient
      ssm.localstack.test.ts     # describe.skip when docker unavailable
      load.test.ts               # selection + misconfig errors
```

No package.json -- the repo is a single-root `package.json` workspace; `packages/secrets/` is a plain folder importable via `@ark/secrets` (aliased like every other internal package once added to `tsconfig.json`).

### Interface

```ts
// packages/secrets/kek/backend.ts

/**
 * Result of a successful KEK load.
 * `material` is a SecureBuffer wrapping the 32 raw KEK bytes. The buffer is
 * zeroed on dispose. Consumers MUST call .dispose() on shutdown.
 * `version` is the integer the operator currently considers "current"; this
 * is recorded into tenant_deks.kek_version when DEKs are wrapped or rewrapped.
 * `describe()` produces a redacted identity string for startup logs and
 * audit records (e.g. "ssm:/ark/prod/master-kek@v3"). Never the bytes.
 */
export interface LoadedKek {
  material: SecureBuffer;
  version: number;
  describe(): string;
}

export interface KekBackend {
  /** Read and validate the master KEK. Must fail loudly on any error. */
  load(): Promise<LoadedKek>;
  /** Stable identifier for startup logs + audit. Never includes bytes. */
  describe(): string;
}
```

`SecureBuffer` is defined in `kek/memory.ts` (shared with the future tenant-DEK cache). Contract: 32 raw bytes, zero-fill on `dispose()`, no V8 string interning. Harm-reduction, not proof -- JS cannot fully guarantee no GC copy.

### SsmKekBackend

```ts
// packages/secrets/kek/ssm.ts

import type { SSMClient } from "@aws-sdk/client-ssm";

export interface SsmKekBackendConfig {
  /** Parameter name or full ARN. Required. */
  parameter: string;
  /** AWS region. Falls back to AWS SDK default chain when unset. */
  region?: string;
  /** Test hook: inject a pre-built SSMClient. Production code leaves this unset. */
  client?: SSMClient;
}

export class SsmKekBackend implements KekBackend { ... }
```

Behaviour:

1. Lazily imports `@aws-sdk/client-ssm` (matches `aws-provider.ts` pattern; keeps test mocks light).
2. Issues a single `GetParameter` with `WithDecryption=true` against `config.parameter`.
3. Treats the returned `Value` as **base64-encoded 32-byte material**. Validates: defined, decodes cleanly, exactly 32 bytes after decode. On any failure (missing parameter, IAM denied, wrong length, not base64), throws a `KekLoadError` whose message includes the parameter name, the AWS error code if present, and **never** any partial bytes.
4. Returns `{ material: SecureBuffer(decoded), version: parameter.Version ?? 1, describe: () => "ssm:" + config.parameter + "@v" + version }`. The SSM-provided `Version` is the source of truth for `tenant_deks.kek_version`.
5. AWS authentication uses the standard SDK credential chain (IAM role on EC2/EKS, env vars, profile). No bespoke credential plumbing.

### Loader factory

```ts
// packages/secrets/kek/load.ts

export interface KekConfig {
  backend: "ssm";                  // only "ssm" in v1
  ssm?: { parameter: string; region?: string };
}

export function selectKekBackend(c: KekConfig): KekBackend;
export async function loadMasterKey(c: KekConfig): Promise<LoadedKek>;
```

`KekConfig` is read from arkd config / env at startup:

- `ARK_KEK_BACKEND` -- must be `ssm` (any other value, including unset, fails startup with a list of supported backends).
- `ARK_KEK_SSM_PARAMETER` -- SSM parameter name or ARN; required.
- `ARK_KEK_SSM_REGION` -- optional; otherwise SDK default chain.

`ARK_MASTER_KEY` is intentionally ignored -- if set, the loader logs a one-line warning ("`ARK_MASTER_KEY` is set but EnvKekBackend is not shipped in v1; ignoring") and continues. This is a defensive guard against operators carrying old env-var habits forward; it does not silently change behaviour.

### Boot integration

`AppContext.boot()` (`packages/core/app.ts:118`) gains one step after `_initSchema(db)` and before container build:

```ts
this._kek = await loadMasterKey(this.config.kek);
// register in the DI container as a singleton so downstream services
// (tenant-dek, cipher) resolve it via cradle and the lifecycle dispose
// chain zeroes the SecureBuffer on shutdown.
```

The KEK is **eagerly resolved at boot**, not lazily, so a misconfigured deployment fails fast with a clear error rather than at first secret read. This mirrors the existing pattern at `app.ts:163` for hosted-mode `blobStore`/`snapshotStore`.

For v1 there is no downstream consumer yet -- this addendum lands the seam. A smoke integration test asserts that arkd boots cleanly with a valid SSM parameter and fails loudly without one.

### Test strategy

| File | Coverage |
|---|---|
| `memory.test.ts` | SecureBuffer allocates 32 bytes, accepts only 32-byte inputs, zeros on dispose (verified via `Buffer.equals(zeroed, Buffer.alloc(32))`), double-dispose is a no-op |
| `backend.contract.test.ts` | A small contract suite parameterized over a `KekBackend`. Asserts `load()` returns a valid `LoadedKek` with 32-byte material and a non-empty `describe()`. Used by `ssm.test.ts` and any future backend. |
| `ssm.test.ts` | Mocked `SSMClient` (record `send()` calls, return canned responses). Cases: happy path, missing parameter, IAM denied, throttle, wrong length, non-base64, base64 of wrong length, AWS region propagation, parameter-version captured into `LoadedKek.version`. |
| `ssm.localstack.test.ts` | LocalStack-backed round-trip. Reuses the existing `localstack-helper.ts` pattern, extended to start `SERVICES=ssm` instead of `s3`. `describe.skip` when docker unavailable. |
| `load.test.ts` | `ARK_KEK_BACKEND` missing / wrong value / valid; `ARK_KEK_SSM_PARAMETER` missing fails; `ARK_MASTER_KEY` set emits a warning but proceeds; error messages never include bytes. |
| arkd boot integration | Smoke test under `packages/arkd/__tests__/` that boots `AppContext.forTestAsync()` with a stubbed `KekBackend` (returning a known 32-byte buffer) and asserts the cradle exposes the LoadedKek and dispose zeroes it. |

## Failure semantics

- Any backend `load()` failure throws `KekLoadError`. Message format: `"KEK load failed via <backend.describe()>: <reason>"`. Never includes bytes.
- arkd boot fails with that error printed to stderr; exit code 1.
- No retries at the backend layer -- the AWS SDK has its own retry/backoff for transient errors. A persistent failure is not something arkd can resolve by polling.

## Operator workflow

1. Generate KEK material: `openssl rand -base64 32 > kek.b64`.
2. Push to SSM: `aws ssm put-parameter --name /ark/prod/master-kek --type SecureString --value "$(cat kek.b64)" --key-id alias/aws/ssm` (or a customer-managed CMK ARN).
3. Wipe the local file: `shred -u kek.b64`.
4. Configure arkd: `ARK_KEK_BACKEND=ssm ARK_KEK_SSM_PARAMETER=/ark/prod/master-kek ARK_KEK_SSM_REGION=us-east-1`.
5. Ensure arkd's IAM role has `ssm:GetParameter` + `kms:Decrypt` on the parameter and its CMK.

A `make` target or CLI helper to wrap steps 1-3 is out of scope for v1.

## Migration

There is nothing to migrate. No production deployments depend on `EnvKekBackend` because the hierarchical-secrets feature itself has not shipped yet -- this addendum lands the KEK seam *before* any per-tenant DEK or `secret_blobs` row exists. The reversal is therefore free; no operator action is required to switch off `EnvKekBackend`.

## References

- `2026-05-13-hierarchical-secrets-design.md` -- original design (D5, D20 superseded by this addendum)
- `packages/core/secrets/aws-provider.ts` -- existing SSM SDK usage pattern reused here
- `packages/core/storage/__tests__/localstack-helper.ts` -- LocalStack helper pattern extended for SSM
- `packages/core/app.ts:118` -- `AppContext.boot()` integration point

---

## Shipped status (post-merge addendum)

As of the `feature/ssm-kek-backend` branch, the following has landed beyond what the original spec contemplated:

### Path-layout cleanup (no back-compat)

The legacy flat shape `/ark/<tid>/<KEY>` is **removed entirely**. CLI, v1 RPC (`secret/list`, `secret/get`, `secret/set`, `secret/delete`), and the dispatch resolver all read and write the same canonical layout:

```
/ark/<tid>/users/<uid>/<KEY>            (user override)
/ark/<tid>/teams/<seg>[/<seg>...]/<KEY> (team override)
/ark/<tid>/tenant/<KEY>                 (tenant default)
```

Pre-existing `/ark/<tid>/<KEY>` entries from older deployments are NOT migrated automatically. Operators must re-seed at the canonical path. The resolver does not walk the legacy prefix.

### LocalStack as a first-class dev target

- `.infra/docker-compose.dev.yaml` -- new `localstack` service (SSM + KMS, persisted volume) on `:4566`.
- `.infra/localstack-init/01-seed-kek.sh` -- idempotent ready.d hook that writes `/ark/kek/dev` on first boot.
- `AwsSecretsConfig.endpoint` -- new optional field on `AwsSecretsProvider`, parsed from `ARK_SECRETS_AWS_ENDPOINT`. Mirrors `SsmKekBackendConfig.endpoint` (which already existed). Dev story is one compose command + four env vars; no SSO required.
- `SecretsCapability.listAt(prefix, { recursive })` -- new optional flag; default `true` preserves prior behaviour. Backwards-compatible API improvement.

### Operator workflow (LocalStack variant)

```bash
docker compose -f .infra/docker-compose.dev.yaml up -d localstack
export AWS_REGION=ap-south-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
export ARK_KEK_BACKEND=ssm ARK_KEK_SSM_PARAMETER=/ark/kek/dev \
       ARK_KEK_SSM_ENDPOINT=http://localhost:4566
export ARK_SECRETS_BACKEND=aws ARK_SECRETS_AWS_ENDPOINT=http://localhost:4566
make dev
```

No SSO refresh, no expired tokens, identical code path as prod.

### Out-of-band operational scripts

Two one-shot scripts are checked in under `scripts/`:

- `scripts/seed-tenant.ts` -- creates a tenant by calling `app.tenants.create()` in-process. Bypasses the RPC tenant-admin gate (the `admin/tenant/create` handler hard-throws `system-admin role; unavailable in the tenant-admin model` per `packages/conductor/handlers/admin.ts:60`). Operational path for tenant creation until the system-admin role is introduced.
- `scripts/test-resolver.ts` -- probes `HierarchicalSecretResolver.resolveAll` for a given `(tenant_id, user_id, team_chain)` shape and prints the resolved env map. Verifies SSM precedence (`user > team > tenant`) without dispatching a full session.

### What did NOT ship (still future work)

The original spec named tenant DEKs and per-secret envelope encryption as the next layer. **None of that lands in this branch.** The KEK is loaded at boot, registered in DI, and disposed on shutdown -- nothing consumes it yet. AWS KMS does the actual SecureString crypto on SSM round-trips. The KEK exists today as:

1. A boot-time gate (loud failure on misconfig).
2. A per-environment identity pin (`/ark/kek/dev` ≠ `/ark/kek/prod`).
3. The seam where `tenant_deks` will eventually be unwrapped.

See `docs/secrets-usage.md` -- section "What the KEK is for today" -- for the operator-facing explanation.

### Known follow-ups noted but not addressed

- `--scope tenant` UI in the web app -- the SecretsPage only writes tenant scope; team/user scope is CLI-only.
- Resolver caching -- every dispatch issues fresh `listAt` + `batchGet` calls. Per-session memoisation noted in `docs/secrets-usage.md` operator notes.
- Bulk import/export, tenant cloning -- for 50-tenant scale these are the next operational wins.
