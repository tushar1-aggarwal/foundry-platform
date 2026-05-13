# Temporal Phase 3 Helm chart gap -- design

**Date:** 2026-05-12
**Status:** approved (brainstorm)
**Author:** Ark team (brainstormed with Claude)
**Related:** `docs/temporal.md`, `.infra/helm/ark/`, PR #538 (Phase 3)

## Problem

`.infra/helm/ark/` ships Ark's control plane in EKS but has **zero Temporal awareness**. Phase 3 makes Temporal mandatory for hosted-mode session orchestration, so the chart can't deploy a working control plane on a new AWS account until the gap is closed.

Confirmed gaps:

- `configmap.yaml` -- missing `ARK_TEMPORAL_ORCHESTRATION`, `ARK_TEMPORAL_SERVER_URL`, `ARK_TEMPORAL_NAMESPACE`, `ARK_TEMPORAL_TASK_QUEUE`.
- `values.yaml` -- no `temporal:` block.
- No `temporal-server`, `temporal-ui`, `temporal-worker`, schema-migration Job, or namespace Job templates.

## Goal

A new AWS account can deploy the full Ark control plane in hosted mode -- including a working Temporal cluster -- with one `helm upgrade --install` command and an account-specific values file.

Non-goals:

- Temporal Cloud support (deferred).
- Per-service Temporal HA topology (frontend/history/matching split). Single-Deployment `service=all` is enough for current scale.
- Replacing the in-cluster bundled Postgres / Redis options used for non-production deployments.

## Decisions (locked)

| # | Decision | Reason |
|---|---|---|
| D1 | Self-hosted Temporal **inside EKS** | User-chosen option (b) from brainstorm. Ops cost is acceptable; avoids Temporal Cloud lock-in for now. |
| D2 | Temporal persistence on **shared RDS, logical DB isolation** | Honors `docs/temporal.md:211-223` decision. Two logical DBs (`ark`, `temporal`) in one RDS cluster, separate roles, capped connection_limit. Deviates from local-dev (separate Postgres container) by design -- doc explicitly calls that out. |
| D3 | **pgbouncer provisioned by Ops, out of chart** | Sizing depends on RDS instance class; lives with Ops. Chart points at it via `temporal.persistence.host`. |
| D4 | Worker runtime: **Node 20 + tsx** on `oven/bun:1.3.13-slim` base | Implementation reality (commit `a681409d`). Temporal worker SDK needs `v8.promiseHooks.createHook`; Bun's V8 doesn't expose it. Doc plan "start on Bun" is stale and will be updated. |
| D5 | **Single Helm chart, not sub-chart** | Doc said "sub-chart for the worker"; we're shipping server in-cluster too, so simplicity wins. New templates land directly under `.infra/helm/ark/templates/`. Can extract later if needed. |
| D6 | **Monolithic Temporal server Deployment** (`server --service=all`) | Same `temporalio/server` image supports both modes. Splitting frontend/history/matching pays off >100 workflow ops/sec; we're nowhere near that. Switching is a one-line values flip later. |
| D7 | Schema migration via **`pre-install,pre-upgrade` Helm hook** | Idempotent (`temporal-sql-tool update-schema` no-ops when current). Loud failure mode (`helm upgrade` fails before pod restart). No runbook discipline required. Toggle via `temporal.schemaJob.enabled` for major-version coordination. |
| D8 | Namespace creation via **`post-install` Helm hook** | Mirrors local-dev's `temporal-admin` one-shot service. Idempotent (`namespace describe \|\| namespace create`). |
| D9 | Helm chart owns Temporal **server + UI + worker + schema/namespace Jobs**. Ops owns **RDS + pgbouncer + IAM + Secrets Manager** | Clean cut between "what runs in k8s" and "what runs in AWS infra". |

## Architecture

```
                                EKS cluster (Ark namespace)
                  +-----------------------------------------------------+
                  |                                                     |
helm install ---->| Helm renders + applies:                             |
                  |                                                     |
                  |  * temporal-schema-job (Job, pre-upgrade hook)      |
                  |       |                                             |
                  |       v                                             |
                  |   [migrates RDS schema via pgbouncer]               |
                  |                                                     |
                  |  * temporal-server (Deployment)                     |
                  |       image: temporalio/server:1.27                 |
                  |       cmd:   temporal-server --service=frontend,    |
                  |              history,matching,worker                |
                  |       env:   POSTGRES via pgbouncer                 |
                  |       svc:   temporal-server:7233 (gRPC)            |
                  |                                                     |
                  |  * temporal-namespace-job (Job, post-install hook)  |
                  |       creates "ark-<env>" namespace (idempotent)    |
                  |                                                     |
                  |  * temporal-ui (Deployment + Service, optional)     |
                  |       image: temporalio/ui:2.34.0                   |
                  |                                                     |
                  |  * temporal-worker (Deployment)                     |
                  |       image: ark-temporal-worker (Dockerfile.temporal-worker)
                  |       cmd:   tsx packages/core/temporal/worker.ts   |
                  |       --> connects to temporal-server:7233          |
                  |       --> connects to RDS via pgbouncer (lazy)      |
                  |                                                     |
                  |  * control-plane (existing Deployment, modified)    |
                  |       env:  ARK_TEMPORAL_ORCHESTRATION=true         |
                  |             ARK_TEMPORAL_SERVER_URL=temporal-server:7233
                  |             ARK_TEMPORAL_NAMESPACE=ark-<env>        |
                  |             ARK_TEMPORAL_TASK_QUEUE=ark.<tenant>.stages
                  |                                                     |
                  +-----------------------------------------------------+
                                       |
                                       | (out-of-cluster, Ops-provisioned)
                                       v
                  +-----------------------------------------------------+
                  |  AWS account infra                                  |
                  |  * RDS Postgres 16 (shared cluster, 2 logical DBs)  |
                  |  * pgbouncer (per-service pools)                    |
                  |  * Secrets Manager (rotating RDS creds + app keys)  |
                  |  * IAM roles (IRSA -- S3, SM)                       |
                  +-----------------------------------------------------+
```

## File changes

### New templates (7)

#### 1. `templates/temporal-server-deployment.yaml`
- `kind: Deployment`, `replicas: {{ .Values.temporal.server.replicaCount }}` (default 1).
- Container: `temporalio/server:{{ .Values.temporal.server.imageTag }}`.
- Args: `--service=frontend --service=history --service=matching --service=worker`.
- Env:
  - `DB=postgres12`
  - `POSTGRES_USER`, `POSTGRES_PWD` from `temporal.persistence.existingSecret`
  - `POSTGRES_SEEDS={{ .Values.temporal.persistence.host }}`
  - `DB_PORT={{ .Values.temporal.persistence.port }}`
  - `DBNAME={{ .Values.temporal.persistence.database }}`
  - `VISIBILITY_DBNAME={{ .Values.temporal.persistence.visibilityDatabase }}`
  - `TEMPORAL_BROADCAST_ADDRESS=0.0.0.0`
- Probes: gRPC health check on :7233 via `grpc_health_probe` sidecar OR `temporal operator cluster health` exec probe.
- Resources: defaults sized for ~10 sessions/min (~50 workflow ops/sec). Overridable.

#### 2. `templates/temporal-server-service.yaml`
- `kind: Service`, `ClusterIP`, port `7233` (gRPC).
- Selector matches server Deployment labels.

#### 3. `templates/temporal-schema-job.yaml`
- `kind: Job` with annotations:
  - `helm.sh/hook: pre-install,pre-upgrade`
  - `helm.sh/hook-weight: -10`
  - `helm.sh/hook-delete-policy: hook-succeeded,before-hook-creation`
- Container: `temporalio/admin-tools:1.27`
- Command (one shot):
  ```sh
  temporal-sql-tool --plugin postgres12 \
    --endpoint $POSTGRES_HOST --port $POSTGRES_PORT \
    --user $POSTGRES_USER --pw $POSTGRES_PWD \
    --db $DBNAME setup-schema -v 0.0 || true
  temporal-sql-tool --plugin postgres12 ... update-schema --schema-dir schema/postgresql/v12/temporal/versioned
  # same for VISIBILITY_DBNAME with v12/visibility/versioned
  ```
- `backoffLimit: 1`; failure aborts the helm upgrade.
- Gated on `{{ if .Values.temporal.schemaJob.enabled }}`.

#### 4. `templates/temporal-namespace-job.yaml`
- `kind: Job` with annotations:
  - `helm.sh/hook: post-install`
  - `helm.sh/hook-weight: 10`
  - `helm.sh/hook-delete-policy: hook-succeeded,before-hook-creation`
- Container: `temporalio/admin-tools:1.27`
- Command:
  ```sh
  for ns in {{ join " " .Values.temporal.namespaces }}; do
    temporal operator namespace describe "$ns" >/dev/null 2>&1 \
      || temporal operator namespace create --retention "${RETENTION:-72h}" "$ns"
  done
  ```
- Idempotent; safe to re-run.

#### 5. `templates/temporal-ui-deployment.yaml`
- `kind: Deployment`, `replicas: 1` (it's just a UI).
- Container: `temporalio/ui:{{ .Values.temporal.ui.imageTag }}`.
- Env: `TEMPORAL_ADDRESS=temporal-server:7233`, `TEMPORAL_CORS_ORIGINS={{ .Values.temporal.ui.corsOrigins }}`.
- Gated on `{{ if .Values.temporal.ui.enabled }}` (default true).

#### 6. `templates/temporal-ui-service.yaml`
- `kind: Service`, `ClusterIP`, port `8080` (UI).
- Optional ingress rule (extends existing `ingress.yaml`) at path `/temporal`.

#### 7. `templates/temporal-worker-deployment.yaml`
- `kind: Deployment`, `replicas: {{ .Values.temporal.worker.replicaCount }}` (default 2).
- Container: `{{ .Values.temporal.worker.image.repository }}:{{ .Values.temporal.worker.image.tag }}`.
- CMD: from `Dockerfile.temporal-worker` (`scripts/temporal-worker-entrypoint.sh`).
- Env:
  - `ARK_TEMPORAL_SERVER_URL=temporal-server:7233`
  - `ARK_TEMPORAL_NAMESPACE={{ .Values.temporal.namespace }}`
  - `ARK_TEMPORAL_TASK_QUEUE_ASSIGNMENTS={{ .Values.temporal.taskQueueAssignments }}`
  - DB env via `envFrom: secretRef: ark-db-credentials`
  - App env via `envFrom: secretRef: ark-secrets`
- ServiceAccount: same as control plane (IRSA-bound for S3 access).
- Probes: liveness via process check (worker process exits on Temporal connection loss with retry exhausted).
- Resources: defaults sized for 20 concurrent workflow tasks per pod.

### Modified templates (1)

#### `templates/configmap.yaml`
Append to existing ConfigMap data:

```yaml
ARK_TEMPORAL_ORCHESTRATION: {{ .Values.temporal.enabled | quote }}
ARK_TEMPORAL_SERVER_URL: "{{ .Values.temporal.serverServiceName }}:7233"
ARK_TEMPORAL_NAMESPACE: {{ .Values.temporal.namespace | quote }}
ARK_TEMPORAL_TASK_QUEUE: {{ .Values.temporal.taskQueue | quote }}
```

The control-plane Deployment already loads ConfigMap envs via `envFrom`, so no Deployment change needed.

### Modified values (1)

#### `values.yaml`
Add a new top-level `temporal:` block:

```yaml
temporal:
  enabled: true
  namespace: ark-prod
  namespaces:                       # all namespaces to create on first install
    - ark-prod
  taskQueue: ark.default.stages
  taskQueueAssignments: ""          # comma-separated, overrides single taskQueue

  serverServiceName: temporal-server

  server:
    replicaCount: 1
    image:
      repository: temporalio/server
      tag: "1.27"
      pullPolicy: IfNotPresent
    resources:
      requests: { cpu: 500m, memory: 1Gi }
      limits:   { cpu: 2,    memory: 4Gi }

  persistence:
    host: ""                        # set per environment (pgbouncer host)
    port: 6432                      # pgbouncer default
    database: temporal
    visibilityDatabase: temporal_visibility
    existingSecret: temporal-db-credentials
    secretKeys:
      username: POSTGRES_USER
      password: POSTGRES_PWD

  schemaJob:
    enabled: true                   # disable for major-version upgrades
    imageTag: "1.27"

  ui:
    enabled: true
    imageTag: "2.34.0"
    corsOrigins: ""                 # set per env if exposing via ingress
    ingress:
      enabled: false
      path: /temporal

  worker:
    replicaCount: 2
    image:
      repository: ghcr.io/ytarasova/ark-temporal-worker
      tag: latest
      pullPolicy: Always
    resources:
      requests: { cpu: 250m, memory: 512Mi }
      limits:   { cpu: 1,    memory: 2Gi }
```

A new account's overlay (`values-<account>.yaml`) sets `temporal.persistence.host`, image tags, and namespace name; all other fields use defaults.

## Operational checklist (out of chart -- Ops scope)

These are not part of this design but are blocking prerequisites:

- [ ] RDS Postgres 16 cluster (shared with Ark control plane).
- [ ] Two logical DBs: `temporal`, `temporal_visibility`. Created with a `temporal` role having capped `connection_limit`.
- [ ] pgbouncer Deployment + Service in same VPC, pointing at RDS. Per-DB pools sized per `docs/temporal.md:218`.
- [ ] Secrets Manager entry `temporal-db-credentials` with `POSTGRES_USER` / `POSTGRES_PWD` keys; pulled into K8s via existing `ExternalSecret` pattern.
- [ ] Container image pushed to registry: `ark-temporal-worker` built from `.infra/Dockerfile.temporal-worker`.
- [ ] CloudWatch alarm on Temporal DB CPU (per doc:221).

## What this does NOT change

- Local dev (`make dev-temporal` + `docker-compose.temporal.yaml`) stays exactly as is. Local uses separate `temporal-postgres` container; prod uses RDS. Documented divergence.
- Existing `control-plane-deployment.yaml`, `worker-deployment.yaml` (arkd), `postgresql-statefulset.yaml`, `redis-deployment.yaml` -- untouched except the ConfigMap rendering they already consume.
- `docs/temporal.md` -- needs a follow-up update (D4 worker runtime, D5 chart layout deviation from "sub-chart"). Not blocking this implementation.

## Testing strategy

1. **Local-equivalent test**: `helm template .infra/helm/ark -f values-test.yaml` against a kind cluster + ephemeral Postgres; confirm pods come up and `temporal operator cluster health` succeeds.
2. **Schema migration idempotency**: `helm upgrade` against an existing cluster; schema Job re-runs and exits 0.
3. **Worker connectivity**: `temporal-worker` pod logs show successful namespace registration to `temporal-server:7233`.
4. **End-to-end on EKS**: dispatch a session via control-plane API; observe the workflow in `temporal-ui`; confirm completion.

## Open follow-ups (not blocking this design)

- Helm test hook (`templates/tests/test-connection.yaml`) to validate gRPC reachability post-install.
- `temporal.metrics.enabled` for Prometheus scraping (Phase 5 observability work).
- Per-tenant namespace lifecycle: doc plan calls for `ark-<tenant>` runtime-created namespaces. Current design uses static install-time namespaces. Defer the runtime-creation path to Phase 5.
