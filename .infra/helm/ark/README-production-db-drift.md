# Production DB drift one-time remediation

This document records SQL that was applied manually to the `ark` Postgres
database during the 2026-05-12 pai-risk-mlops-platform deploy to repair
schema drift accumulated since the original April-21 install. The drift
came from two underlying app-layer bugs that this chart does NOT paper
over -- the proper fix belongs in `packages/core/migrations/`.

## What was found

`ark_schema_migrations` reported all 14 then-applied versions (1-14) as
present, but the on-disk schema did not match what those migrations are
*now* written to produce:

1. **Migration 003 (`tenants_teams`)** -- recorded as applied 2026-04-21
   but the live database had only the `tenants` table; `users`, `teams`,
   and `memberships` were missing. The migration body was edited
   post-deploy to create these tables, but `MigrationRunner` keys on
   version not body hash, so it never re-ran.
2. **`compute_templates`** was missing the `compute_kind` and
   `isolation_kind` columns. No migration between 002 (compute_unify) and
   015 (drop_legacy_provider_columns) creates them; migration 015
   *assumes* they exist and issues `UPDATE compute_templates SET
   compute_kind = ...`, which then hard-fails on a drifted DB.

## What was applied (idempotent SQL, run once via a one-off Job)

```sql
-- From migration 003's current body (recreates the tables that were
-- never produced by the historic migration).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_teams_tenant ON teams(tenant_id);
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  UNIQUE (user_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_team ON memberships(team_id);

-- Migration 015's prereq columns (no earlier migration adds them; this
-- is what migration 002 / 011 / 012 ought to have done).
ALTER TABLE compute_templates
  ADD COLUMN IF NOT EXISTS compute_kind TEXT NOT NULL DEFAULT 'local';
ALTER TABLE compute_templates
  ADD COLUMN IF NOT EXISTS isolation_kind TEXT NOT NULL DEFAULT 'direct';

-- Future-proofing for migration 017's `users` ALTERs (deleted_at /
-- deleted_by come from migrations 004/005, which DID run -- but those
-- migrations target tables that exist; we just-now created users so it
-- needs the columns too).
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by TEXT;
```

All statements are `IF NOT EXISTS` / `IF NOT EXISTS` style and safe to
re-run on a fresh install (no-op) or any drifted DB.

## Why this isn't a chart hook

A defensive PreSync hook in the chart could run this SQL on every deploy,
but that would mask the underlying migration bugs and grow with every
future drift. The fix belongs in `packages/core/migrations/`:

- Migration 003's body needs to use `CREATE TABLE IF NOT EXISTS` guards
  AND keep doing so forever; the runner needs to call those guards on a
  *re-apply path* gated on a hash of the migration body so historic
  versions self-repair when the body legitimately changes.
- A new migration (numbered after the last applied one) needs to add
  `compute_kind` + `isolation_kind` to `compute_templates` so migration
  015's `UPDATE` has the columns it requires.

## Related cluster_membership cleanup (Temporal, not ark)

Separately, the `cluster_membership` table in the `temporal` database had
stale heartbeats from prior pod incarnations. `TRUNCATE TABLE
cluster_membership` cleared them; temporal-server re-registered itself
on the next heartbeat tick. This is operational/recovery time work, not
a deploy-time concern; the chart cannot prevent it, and Temporal
itself expires stale rows after ~10 min of missed heartbeats.
