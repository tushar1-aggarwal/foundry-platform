# Single-chart local k8s deployment

**Date:** 2026-05-15
**Status:** Draft

## Goal

Deploy the full ark control plane to local OrbStack Kubernetes with a single Helm chart and a single `make` target. No per-environment values files, no opt-in flags for components that are structurally required. Each replaceable infra dependency has one boolean toggle: run it in-cluster, or point at an external endpoint.

## Background

The chart at `.infra/helm/ark/` accumulated three problems:

1. `temporal.enabled` is a phantom switch. The control plane requires Temporal (Phase 3 dispatch is workflow-driven); the flag exists so `helm lint` passes without account overlays.
2. `temporal.persistence.host` duplicates the postgres connection. Temporal uses the same postgres server as the control plane (different databases, different role) but the chart currently treats them as unrelated coordinates.
3. There is no LocalStack support. Hosted mode requires S3; locally there is no way to run the chart without real AWS credentials.

Together these make local k8s deployment infeasible without hand-editing the chart.

## Design

### Three toggles, one shape

Each replaceable dependency follows the same pattern: `enabled` controls in-cluster deployment; `external` carries the connection info when disabled.

```yaml
localstack:
  enabled: true
  image: localstack/localstack:3
  external:
    endpoint: ""           # used when enabled=false; empty means use real AWS S3

postgresql:
  enabled: true
  image: postgres:16-alpine
  storage: 10Gi
  auth:
    username: ark
    password: ark
    database: ark
  external:
    host: ""
    port: 5432
    existingSecret: ""     # K8s secret with DATABASE_URL (or DB_USERNAME/DB_PASSWORD)

redis:
  enabled: true
  image: redis:7-alpine
  external:
    host: ""
    port: 6379
    existingSecret: ""
```

### Temporal is structural

Temporal templates render unconditionally. The values block drops `enabled` and the persistence host/port fields:

```yaml
temporal:
  namespace: ark
  namespaces: [ark]
  taskQueue: ark.default.stages
  taskQueueAssignments: ""
  serverServiceName: temporal-server
  server:
    replicaCount: 1
    image: { repository: temporalio/server, tag: "1.27" }
    tls: { enabled: true }     # set false for local clusters without TLS
  worker:
    replicaCount: 2
    image: { repository: ghcr.io/ytarasova/ark-temporal-worker, tag: latest }
  ui:
    enabled: true
    image: { repository: temporalio/ui, tag: "2.34.0" }
  persistence:
    database: temporal
    visibilityDatabase: temporal_visibility
    existingSecret: temporal-db-credentials
    secretKeys: { username: POSTGRES_USER, password: POSTGRES_PWD }
  schemaJob:
    image: { repository: temporalio/admin-tools, tag: "1.27" }
    backoffLimit: 3
  namespaceJob:
    image: { repository: temporalio/admin-tools, tag: "1.27" }
    retention: 72h
```

Connection coordinates are resolved by the chart, not the operator.

### Helpers consolidate resolution

Three new helpers in `_helpers.tpl`:

| Helper | Returns |
|---|---|
| `ark.postgresHost` | `<release>-postgresql` when `postgresql.enabled`, else `postgresql.external.host` |
| `ark.postgresPort` | `5432` when `postgresql.enabled`, else `postgresql.external.port` |
| `ark.s3Endpoint` | `http://<release>-localstack:4566` when `localstack.enabled`, else `localstack.external.endpoint` |

`ark.databaseUrl` and `ark.redisUrl` already exist; both are updated to use the same enabled-vs-external pattern.

### Control plane env (from configmap + deployment)

Always emit:
- `ARK_TEMPORAL_ORCHESTRATION=true`
- `ARK_TEMPORAL_SERVER_URL=<temporal.serverServiceName>:7233`
- `ARK_TEMPORAL_NAMESPACE`, `ARK_TEMPORAL_TASK_QUEUE`

Emit when `ark.s3Endpoint` resolves non-empty:
- `ARK_S3_ENDPOINT=<resolved>`
- `AWS_ENDPOINT_URL_S3=<resolved>` (AWS SDK v3 honors this)
- `ARK_S3_PATH_STYLE=true` (LocalStack requires path-style)

### Temporal db bootstrap

Always runs the schema job (`temporal-schema-job`) against `ark.postgresHost`.

The db-bootstrap job (creates the `temporal` role + `temporal`/`temporal_visibility` databases) is gated on `postgresql.enabled`: the chart owns role creation only when it owns the postgres. When `postgresql.enabled=false`, the operator is responsible for provisioning the temporal role and databases out-of-band.

### LocalStack templates

Three new files in `templates/`:

- `localstack-deployment.yaml` -- single replica `localstack/localstack:3`, gated on `localstack.enabled`
- `localstack-service.yaml` -- ClusterIP, port 4566
- `localstack-init-job.yaml` -- post-install hook, uses `awscli` to run `s3 mb s3://<bucket>` against the in-cluster LocalStack; idempotent

### Drops (no backward-compat)

- `temporal.enabled` -- always on
- `temporal.persistence.host` / `temporal.persistence.port` -- derived
- `temporal.dbBootstrap.enabled` -- gated on `postgresql.enabled`
- `temporal.schemaJob.enabled` -- always runs (Temporal won't start without its schema)
- `temporal.namespaceJob.enabled` -- always runs (workers fail without the namespace)
- `temporal.persistence.secretManagerKey` -- mutually exclusive path collapsed; ExternalSecrets users put their secret in `temporal.persistence.existingSecret` directly
- `controlPlane.devAllowLocalHostedStorage` -- dead with LocalStack reachable

### Makefile target

```makefile
dev-k8s-local: ## Deploy ark to local OrbStack k8s (full mode)
	docker build -t ark:local .
	kubectl config use-context orbstack
	helm upgrade --install ark .infra/helm/ark \
		--set controlPlane.image.tag=local \
		--set controlPlane.image.pullPolicy=Never \
		--set controlPlane.auth.enabled=false \
		--set temporal.server.tls.enabled=false \
		--set s3.bucket=ark-local \
		--set s3.region=us-east-1 \
		--set llm.anthropicApiKey=$$ANTHROPIC_API_KEY \
		--wait --timeout 8m
	@echo "Done. Port-forward with:"
	@echo "  kubectl port-forward -n ark svc/ark-control-plane 8420:8420"
	@echo "  open http://localhost:8420"

dev-k8s-local-down: ## Tear down local k8s deployment
	helm uninstall ark
	kubectl delete pvc -l app.kubernetes.io/instance=ark --ignore-not-found
```

### Documentation

New file `docs/local-k8s-deploy.md`:
- Prerequisites: OrbStack k8s enabled, `ANTHROPIC_API_KEY` exported
- Single command: `make dev-k8s-local`
- Verification steps: port-forward, hit `/health`, kick off a session
- Teardown: `make dev-k8s-local-down`
- Troubleshooting: temporal-schema-job timeout, LocalStack bucket race, OrbStack image visibility

## Out of scope

- External Temporal (someday: `temporal.external.serverUrl`); not needed for local or current production
- Multi-replica control plane with shared snapshot store (separate roadmap; `devAllowLocalHostedStorage` was the prior workaround)
- Auth wiring for local (OIDC); local runs with `auth.enabled=false`
- Migrating the production overlay (`values-production.yaml`) -- handled in a follow-up PR alongside the chart cut

## Files touched

**New:**
- `.infra/helm/ark/templates/localstack-deployment.yaml`
- `.infra/helm/ark/templates/localstack-service.yaml`
- `.infra/helm/ark/templates/localstack-init-job.yaml`
- `docs/local-k8s-deploy.md`

**Modified:**
- `.infra/helm/ark/values.yaml` -- restructure as above
- `.infra/helm/ark/templates/_helpers.tpl` -- add `ark.postgresHost`, `ark.postgresPort`, `ark.s3Endpoint`
- `.infra/helm/ark/templates/configmap.yaml` -- always emit temporal env; emit S3 endpoint env when resolved
- `.infra/helm/ark/templates/control-plane-deployment.yaml` -- drop `devAllowLocalHostedStorage` branch; pass S3 endpoint env
- `.infra/helm/ark/templates/temporal-*.yaml` -- drop `if .Values.temporal.enabled` conditionals; use `ark.postgresHost`/`ark.postgresPort` for connection
- `.infra/helm/ark/templates/temporal-db-bootstrap.yaml` -- gate on `postgresql.enabled`; use `ark.postgresHost`
- `.infra/helm/ark/values-production.yaml` -- update to match new values shape
- `Makefile` -- add `dev-k8s-local` + `dev-k8s-local-down` targets

## Validation

1. `helm lint .infra/helm/ark` passes with defaults (no overlay required).
2. `helm template .infra/helm/ark` produces a renderable manifest with `localstack.enabled=true, postgresql.enabled=true, redis.enabled=true`.
3. `helm template .infra/helm/ark --set localstack.enabled=false --set postgresql.enabled=false --set redis.enabled=false --set postgresql.external.host=ext-pg --set redis.external.host=ext-redis` produces a manifest without the in-cluster resources, with control plane env pointing at the externals.
4. `make dev-k8s-local` brings up the stack on OrbStack with a fresh image and the LocalStack bucket created.
5. Kicking off a session via the web UI completes end-to-end (Temporal workflow visible in the in-cluster Temporal UI).
