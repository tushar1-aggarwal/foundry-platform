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
  rest with a machine-scoped key. Legacy flat names (`ANTHROPIC_API_KEY`)
  are still readable; they're treated as living at
  `/ark/<tid>/tenant/<NAME>` on read.

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

### Set a tenant-default secret (back-compat shape)

```sh
ark secrets set ANTHROPIC_API_KEY            # prompts masked
echo "sk-..." | ark secrets set ANTHROPIC_API_KEY
```

This keeps writing the legacy flat shape; reads still discover it under
`/ark/<tid>/tenant/ANTHROPIC_API_KEY`.

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
ark secrets list                                # legacy tenant view
ark secrets list --scope user --scope-id u1     # path-aware view
ark secrets list --scope team --scope-id eng    # team view
```

### Get / delete / describe by scope

```sh
ark secrets get FOO --scope user --scope-id u1
ark secrets delete FOO --scope team --scope-id eng/infra -y
ark secrets describe FOO --scope user --scope-id u1
```

Bare `ark secrets get FOO` (or `delete` / `describe`) keeps using the
existing RPC path against the tenant default -- no observable change for
operators who never touch `--scope`.

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
- Migration of legacy flat entries to the new `/ark/<tid>/tenant/` shape
  happens lazily on read; explicit migration is **not** required.
- Phase 1's KEK seam (`packages/secrets/kek/*`) is unchanged. The Phase 2
  resolver intentionally does NOT consume the KEK -- the backend (SSM /
  file) handles encryption end-to-end.
