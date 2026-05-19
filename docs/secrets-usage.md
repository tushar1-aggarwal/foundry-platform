# Secrets -- Hierarchical Resolution

Ark dispatches an agent session under a `(tenant_id, user_id, team_chain)`
identity. Secrets are stored in the configured backend (SSM in hosted
mode, an encrypted file in local mode) and resolved at dispatch time by
walking three path namespaces:

```
/ark/<tenantId>/users/<userId>/<KEY>
/ark/<tenantId>/teams/<segment>[/<segment>...]/<KEY>
/ark/<tenantId>/tenant/<KEY>
```

The resolver lists every entry under those prefixes, merges them with
**first-hit-per-key precedence**, and exports the resulting map as env
vars to the launched session.

## Precedence

For each `KEY`, the resolver picks the first match in this order:

1. **User scope** -- `/ark/<tid>/users/<uid>/<KEY>` (most specific).
2. **Team chain** -- walked most-specific to least-specific. E.g. for a
   user in team chain `[platform, infra, eng]`, the resolver looks
   under `/ark/<tid>/teams/platform/`, then `/ark/<tid>/teams/infra/`,
   then `/ark/<tid>/teams/eng/`.
3. **Tenant default** -- `/ark/<tid>/tenant/<KEY>`.

A `KEY` defined at tenant scope is the default for everyone; a team
override shadows it for that team's members; a user override shadows
the team's override for that one user.

## What is stored where

Ark itself stores **no secret values**. The configured `SecretsCapability`
backend is the source of truth:

- **SSM** (hosted control plane): `SecureString` parameters under
  `/ark/<tid>/...`, encrypted with KMS, audited in CloudTrail.
- **File** (local dev): `~/.ark/secrets.json`, AES-256-GCM encrypted at
  rest with a machine-scoped key.

All scopes use the same path layout:

```
/ark/<tid>/users/<uid>/<KEY>        (user override)
/ark/<tid>/teams/<seg>[/<seg>]/<KEY> (team override)
/ark/<tid>/tenant/<KEY>             (tenant default)
```

The CLI, the v1 RPC surface (`secret/list`, `secret/get`, `secret/set`,
`secret/delete`), and the dispatch resolver all read and write the same
paths -- there is no legacy flat shape (`/ark/<tid>/<KEY>`).

## Stage YAML `secrets:` is assert-only

In Phase 2 the runtime / stage YAML `secrets:` allowlist is **not** the
source-of-truth wiring. The resolver always walks the backend and emits
whatever it finds.

When a stage declares `secrets: [FOO, BAR]`, that list is interpreted as
"assert these resolved" -- dispatch fails with a clear missing-list error
if any of them couldn't be produced.

The runtime-level `secrets:` YAML block has been dropped entirely from
`runtimes/claude-agent.yaml` and `runtimes/claude-code.yaml`.

## CLI cheatsheet

### Set a tenant-default secret

```sh
ark secrets set ANTHROPIC_API_KEY            # prompts masked
echo "sk-..." | ark secrets set ANTHROPIC_API_KEY
```

Writes `/ark/<tid>/tenant/ANTHROPIC_API_KEY`. Visible to every dispatch
in the tenant unless a team or user scope shadows it.

### Set a team-scoped secret

```sh
ark secrets set BUILD_TOKEN \
    --scope team --scope-id platform/eng
```

Writes `/ark/<tid>/teams/platform/eng/BUILD_TOKEN`. Members of any team
chain that includes the `platform/eng` segment will resolve this value
unless a tenant or user scope shadows it.

### Set a user-scoped secret (personal override)

```sh
ark secrets set ANTHROPIC_API_KEY \
    --scope user --scope-id <my-uid>
```

Writes `/ark/<tid>/users/<my-uid>/ANTHROPIC_API_KEY`. Only that user's
sessions will see this value -- the tenant default still applies for
everyone else.

### List by scope

```sh
ark secrets list                                # tenant-default view
ark secrets list --scope user --scope-id u1     # user-scoped view
ark secrets list --scope team --scope-id eng    # team-scoped view
```

### Get / delete / describe by scope

```sh
ark secrets get FOO --scope user --scope-id u1
ark secrets delete FOO --scope team --scope-id eng/infra -y
ark secrets describe FOO --scope user --scope-id u1
```

Bare `ark secrets get FOO` (or `delete` / `describe`) targets the
tenant-default scope (`/ark/<tid>/tenant/FOO`).

## Worked example

Say tenant `acme` has these entries:

```
/ark/acme/tenant/ANTHROPIC_API_KEY  = sk-tenant
/ark/acme/teams/eng/BUILD_TOKEN     = bt-eng
/ark/acme/users/u1/ANTHROPIC_API_KEY = sk-u1-personal
```

User `u1`, member of team chain `[eng]`, dispatches a session. The
resolver returns:

```
ANTHROPIC_API_KEY = sk-u1-personal   # user wins over tenant
BUILD_TOKEN       = bt-eng           # team only
```

User `u2` (same tenant, same team chain) dispatches:

```
ANTHROPIC_API_KEY = sk-tenant        # tenant default, no user override
BUILD_TOKEN       = bt-eng           # team only
```

## "Tenant vs team vs user" -- decision tree

- Every member of the tenant needs the same value: **tenant scope**.
- Only a specific team should see the value (or override the tenant
  default): **team scope**. Use the most-specific team segment that
  every member of that team is in.
- One person needs a personal override (their own API key on top of a
  tenant default, debugging credential, etc.): **user scope**.

When in doubt, start at tenant and promote down -- the resolver makes
this incremental without any data migration.

## Path naming rules

- `<tenantId>`, every team `<segment>`, and `<userId>` must match
  `[a-z0-9][a-z0-9-]{0,62}` (lowercase kebab-case, 1..63 chars).
- `<KEY>` must match `[A-Z0-9_]+` -- maps directly to an env var.
- Full path must stay under 2048 chars (SSM Parameter Store limit).
- `..`, `/`, leading dots, and traversal shapes are rejected at write time.

## Operator notes

- The resolver issues parallel `listAt()` calls per prefix and a single
  batched `batchGet()` for the winners. Large tenants with many keys
  may want to consider per-session memoisation -- not done in v1.
- All scopes use a single canonical layout under `/ark/<tid>/{tenant,teams,users}/...`.
  The legacy flat shape `/ark/<tid>/<KEY>` is no longer produced or read
  by any code path (CLI, v1 RPC, dispatch resolver). Pre-existing flat
  entries from earlier deployments are NOT migrated automatically -- if
  you have them, re-seed at the canonical path or delete them.
- The KEK seam (`packages/secrets/kek/*`) is loaded at boot but not yet
  consumed by the resolver. v1 ships **the KEK seam only**; envelope
  encryption with tenant DEKs is the next iteration (see
  "What the KEK is for today" below).

## What the KEK is for today

The master KEK is loaded at app boot from `/ark/kek/<env>` (e.g.
`/ark/kek/dev`, `/ark/kek/prod`) and held in a `SecureBuffer` for the
process lifetime. **It does not encrypt or decrypt secrets in v1.**

| Layer | What actually does the crypto in v1 |
|---|---|
| SSM SecureString encryption | AWS KMS (alias `alias/aws/ssm` or `secrets.awsKmsKeyId`) |
| SSM SecureString decryption | AWS KMS (transparent on `GetParameters` with `WithDecryption=true`) |
| File-provider encryption | AES-256-GCM with a machine-derived key (FileSecretsProvider) |
| Master KEK | Boot-time presence check + DI registration; **reserved** for envelope encryption |

The KEK exists to:

1. **Fail loud at boot** if the deployment is misconfigured (no KMS access,
   wrong region, missing parameter). A bad config can't silently start a
   server that dispatches sessions with broken secret resolution.
2. **Pin a per-environment identity.** `/ark/kek/dev` ≠ `/ark/kek/prod`.
   Reading the wrong env's KEK is impossible by accident.
3. **Provide the seam** for the next layer: tenant DEKs wrapped by KEK,
   per-secret ciphertext encrypted by DEK. That layer is not in v1.

Per-env separation **today** is enforced by three independent things:

1. A distinct KMS key alias / IAM-role policy per env (KMS does the
   actual SecureString crypto).
2. A distinct `/ark/kek/<env>` SSM parameter (boot-time gate).
3. A distinct `/ark/<tid>/...` path prefix per tenant (resolver walks).

## Local dev with LocalStack

For offline / no-AWS-SSO dev, the SSM backend can point at LocalStack.

`make` your way to it:

```bash
docker compose -f .infra/docker-compose.dev.yaml up -d localstack
# auto-seeds /ark/kek/dev on first boot via .infra/localstack-init/01-seed-kek.sh
```

Then export the LocalStack env before starting Ark:

```bash
export AWS_REGION=ap-south-1
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
export ARK_KEK_BACKEND=ssm ARK_KEK_SSM_PARAMETER=/ark/kek/dev \
       ARK_KEK_SSM_ENDPOINT=http://localhost:4566
export ARK_SECRETS_BACKEND=aws ARK_SECRETS_AWS_ENDPOINT=http://localhost:4566
make dev
```

`ARK_KEK_SSM_ENDPOINT` and `ARK_SECRETS_AWS_ENDPOINT` are both optional
overrides on top of the standard SSM client; production never sets them.
