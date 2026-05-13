# Temporal Phase 3 Helm Chart Gap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Temporal server, UI, schema/namespace Jobs, and Ark Temporal worker to `.infra/helm/ark/` so a new AWS account can deploy a working control plane with `helm upgrade --install` and an account-specific values file.

**Architecture:** Single Helm chart (no sub-chart). Monolithic `temporalio/server --service=all` Deployment, shared-RDS persistence via Ops-provisioned pgbouncer, schema migration via `pre-install,pre-upgrade` Helm Job hook, namespace creation via `post-install` hook. Detailed decisions in `docs/superpowers/specs/2026-05-12-temporal-helm-gap-design.md`.

**Tech Stack:** Helm 3, Kubernetes manifests (apiVersion `apps/v1`, `batch/v1`), `temporalio/server:1.27`, `temporalio/admin-tools:1.27`, `temporalio/ui:2.34.0`, `ark-temporal-worker` image (Node 20 + tsx on `oven/bun:1.3.13-slim` base, from `.infra/Dockerfile.temporal-worker`).

---

## File Structure

```
.infra/helm/ark/
├── values.yaml                                  modify: add temporal: block (Task 1)
├── values-production.yaml                       modify: prod temporal overrides (Task 12)
├── pai-risk-mlops-platform-values.yaml          UNCHANGED (reference deployment, not edited)
└── templates/
    ├── configmap.yaml                           modify: add ARK_TEMPORAL_* keys (Task 2)
    ├── temporal-server-deployment.yaml          create: Task 3
    ├── temporal-server-service.yaml             create: Task 4
    ├── temporal-schema-job.yaml                 create: Task 5
    ├── temporal-namespace-job.yaml              create: Task 6
    ├── temporal-ui-deployment.yaml              create: Task 7
    ├── temporal-ui-service.yaml                 create: Task 8
    ├── temporal-worker-deployment.yaml          create: Task 9
    └── ingress.yaml                             modify: add optional /temporal UI path (Task 10)

docs/superpowers/plans/values-test.yaml          create: test fixture (Task 0)
```

**Responsibility per file:**

- `values.yaml`: defaults for all chart knobs. Adds a `temporal:` block whose every leaf field has a sane default for a brand-new install.
- `values-production.yaml`: prod-shaped overrides (image tags, replica counts, persistence host blank to force per-env override).
- `configmap.yaml`: env vars consumed by `control-plane-deployment.yaml` and `temporal-worker-deployment.yaml` via `envFrom`. Adds the four `ARK_TEMPORAL_*` keys.
- `temporal-server-deployment.yaml`: single `Deployment` running `temporalio/server` in `service=all` mode against shared RDS.
- `temporal-server-service.yaml`: `ClusterIP` exposing port 7233 (gRPC) inside the cluster.
- `temporal-schema-job.yaml`: `Job` with `pre-install,pre-upgrade` Helm hook annotations, runs `temporal-sql-tool` to set up + update Temporal's schema in the shared RDS.
- `temporal-namespace-job.yaml`: `Job` with `post-install` hook, idempotently creates configured namespaces via `temporal operator namespace`.
- `temporal-ui-deployment.yaml`: `temporalio/ui` Deployment, gated by `temporal.ui.enabled`.
- `temporal-ui-service.yaml`: `ClusterIP` on port 8080 for the UI.
- `temporal-worker-deployment.yaml`: Deployment for Ark's Node+tsx Temporal worker process, points at `temporal-server:7233` and at Ark's DB via existing secret pattern.
- `ingress.yaml`: optional extension that adds a `/temporal` path to the existing ingress when `temporal.ui.ingress.enabled` is true.

All `temporal-*` templates are wrapped in `{{- if .Values.temporal.enabled }}` so the entire feature can be toggled off.

---

## Test strategy

Helm templates are declarative YAML, so "tests" are render-and-assert. Each task uses this loop:

1. **Failing render check** — write a `helm template`-based assertion (grep or yq pattern) that the new resource/field will exist. Run it; expect failure ("not found") because the template doesn't exist yet.
2. **Implement** — write the template.
3. **Passing render check** — re-run the same assertion. Expect success.
4. **Lint** — run `helm lint .infra/helm/ark`. Expect zero warnings.
5. **Commit**.

We do not use `helm-unittest` (not currently in the repo's tool inventory and not worth introducing for this scope).

---

## Task 0: Setup test fixture and verify Helm tooling

**Files:**
- Create: `docs/superpowers/plans/values-test.yaml`

- [ ] **Step 1: Verify Helm CLI is installed and at version 3.x**

Run: `helm version --short`
Expected output starts with `v3.` (e.g., `v3.14.0+gabc123`).

If missing, install: `brew install helm` (macOS) or follow https://helm.sh/docs/intro/install/.

- [ ] **Step 2: Create the test values fixture**

Create `docs/superpowers/plans/values-test.yaml`:

```yaml
# Minimal values for `helm template` smoke checks during plan execution.
# Not a real deployment values file.
namespace: ark-test

controlPlane:
  image:
    repository: ark
    tag: test

postgresql:
  enabled: false
  external:
    host: rds-test.example.com
    port: 5432
    database: ark
    existingSecret: ark-db-credentials

redis:
  enabled: false
  external:
    host: redis-test.example.com

temporal:
  enabled: true
  namespace: ark-test
  namespaces:
    - ark-test
  taskQueue: ark.default.stages
  serverServiceName: temporal-server
  persistence:
    host: pgbouncer.example.com
    port: 6432
    database: temporal
    visibilityDatabase: temporal_visibility
    existingSecret: temporal-db-credentials
  worker:
    image:
      repository: ghcr.io/ytarasova/ark-temporal-worker
      tag: test
```

- [ ] **Step 3: Verify a baseline render succeeds (before any temporal changes)**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml > /tmp/ark-baseline.yaml 2>&1 || cat /tmp/ark-baseline.yaml
```

Expected: command exits 0; `/tmp/ark-baseline.yaml` contains at least one `kind: Deployment` line. If it fails, do not proceed — the chart itself has an unrelated problem to fix first.

- [ ] **Step 4: Commit the fixture**

```bash
git add docs/superpowers/plans/values-test.yaml
git commit -m "chore: add helm template test fixture for temporal gap plan"
```

---

## Task 1: Add `temporal:` block to `values.yaml`

**Files:**
- Modify: `.infra/helm/ark/values.yaml` (append at end)

- [ ] **Step 1: Write the failing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml | grep -c "ARK_TEMPORAL"
```

Expected: `0` (no ARK_TEMPORAL keys exist yet). This baselines what we expect to grow in later tasks.

Also confirm the `temporal` values key is not yet defined:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml --debug 2>&1 | grep -c 'temporal:'
```

Expected: 0 occurrences (no temporal block in defaults).

- [ ] **Step 2: Append the temporal block to values.yaml**

Append this exact content to `.infra/helm/ark/values.yaml`:

```yaml

# -- Temporal (workflow orchestration for hosted/control-plane mode)
# Shipped as part of the main chart, not a sub-chart. The persistence layer
# (RDS + pgbouncer) is provisioned by Ops outside Helm; see
# `docs/superpowers/specs/2026-05-12-temporal-helm-gap-design.md`.
temporal:
  enabled: true
  # Default namespace passed to Ark control plane / worker.
  namespace: ark-prod
  # All namespaces created by the post-install Job. The default namespace
  # MUST appear in this list.
  namespaces:
    - ark-prod
  # Single task queue name used when taskQueueAssignments is empty.
  taskQueue: ark.default.stages
  # Comma-separated task queues for sharded workers. Empty means use taskQueue.
  taskQueueAssignments: ""
  # In-cluster Service name for the Temporal frontend.
  serverServiceName: temporal-server

  server:
    replicaCount: 1
    image:
      repository: temporalio/server
      tag: "1.27"
      pullPolicy: IfNotPresent
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: 2000m
        memory: 4Gi

  # Persistence -- shared RDS via Ops-provisioned pgbouncer.
  persistence:
    host: ""                           # pgbouncer host; required per env.
    port: 6432
    database: temporal
    visibilityDatabase: temporal_visibility
    existingSecret: temporal-db-credentials
    secretKeys:
      username: POSTGRES_USER
      password: POSTGRES_PWD

  # Helm Job: temporal-sql-tool setup-schema + update-schema.
  # Runs on pre-install AND pre-upgrade. Idempotent.
  schemaJob:
    enabled: true
    image:
      repository: temporalio/admin-tools
      tag: "1.27"
    backoffLimit: 1

  # Helm Job: post-install, creates namespaces idempotently.
  namespaceJob:
    enabled: true
    image:
      repository: temporalio/admin-tools
      tag: "1.27"
    retention: 72h

  ui:
    enabled: true
    image:
      repository: temporalio/ui
      tag: "2.34.0"
    corsOrigins: ""
    ingress:
      enabled: false
      path: /temporal

  # The Ark-side Temporal worker (Node+tsx process).
  worker:
    replicaCount: 2
    image:
      repository: ghcr.io/ytarasova/ark-temporal-worker
      tag: latest
      pullPolicy: Always
    resources:
      requests:
        cpu: 250m
        memory: 512Mi
      limits:
        cpu: 1000m
        memory: 2Gi
```

- [ ] **Step 3: Verify chart still renders cleanly**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml > /tmp/ark-with-temporal-values.yaml
diff /tmp/ark-baseline.yaml /tmp/ark-with-temporal-values.yaml
```

Expected: exit 0 (renders fine), zero diff lines (no templates use the new values yet -- that's correct).

- [ ] **Step 4: Lint**

Run: `helm lint .infra/helm/ark`
Expected: `[INFO] Chart.yaml: icon is recommended` and `1 chart(s) linted, 0 chart(s) failed`. No `ERROR` lines.

- [ ] **Step 5: Commit**

```bash
git add .infra/helm/ark/values.yaml
git commit -m "feature: add temporal values block to ark helm chart"
```

---

## Task 2: Add `ARK_TEMPORAL_*` env vars to ConfigMap

**Files:**
- Modify: `.infra/helm/ark/templates/configmap.yaml`

- [ ] **Step 1: Failing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml -s templates/configmap.yaml | grep ARK_TEMPORAL
```

Expected: empty output (no matches).

- [ ] **Step 2: Modify the ConfigMap template**

Replace the contents of `.infra/helm/ark/templates/configmap.yaml` with:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "ark.fullname" . }}-config
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "ark.labels" . | nindent 4 }}
data:
  ARK_CONDUCTOR_HOST: "0.0.0.0"
  ARK_CONDUCTOR_PORT: {{ .Values.controlPlane.ports.conductor | quote }}
  ARK_AUTH_ENABLED: {{ .Values.controlPlane.auth.enabled | quote }}
  ARK_ROUTER_POLICY: {{ .Values.controlPlane.router.policy | quote }}
  {{- $dbUrl := include "ark.databaseUrl" . }}
  {{- if $dbUrl }}
  DATABASE_URL: {{ $dbUrl | quote }}
  {{- end }}
  {{- $redisUrl := include "ark.redisUrl" . }}
  {{- if $redisUrl }}
  REDIS_URL: {{ $redisUrl | quote }}
  {{- end }}
  {{- if .Values.temporal.enabled }}
  ARK_TEMPORAL_ORCHESTRATION: "true"
  ARK_TEMPORAL_SERVER_URL: "{{ .Values.temporal.serverServiceName }}:7233"
  ARK_TEMPORAL_NAMESPACE: {{ .Values.temporal.namespace | quote }}
  ARK_TEMPORAL_TASK_QUEUE: {{ .Values.temporal.taskQueue | quote }}
  {{- if .Values.temporal.taskQueueAssignments }}
  ARK_TEMPORAL_TASK_QUEUE_ASSIGNMENTS: {{ .Values.temporal.taskQueueAssignments | quote }}
  {{- end }}
  {{- end }}
```

- [ ] **Step 3: Passing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml -s templates/configmap.yaml | grep ARK_TEMPORAL
```

Expected output (order may vary):
```
  ARK_TEMPORAL_ORCHESTRATION: "true"
  ARK_TEMPORAL_SERVER_URL: "temporal-server:7233"
  ARK_TEMPORAL_NAMESPACE: "ark-test"
  ARK_TEMPORAL_TASK_QUEUE: "ark.default.stages"
```

- [ ] **Step 4: Verify the keys disappear when temporal is disabled**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml --set temporal.enabled=false -s templates/configmap.yaml | grep -c ARK_TEMPORAL
```

Expected: `0`.

- [ ] **Step 5: Lint**

Run: `helm lint .infra/helm/ark`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add .infra/helm/ark/templates/configmap.yaml
git commit -m "feature: inject ARK_TEMPORAL_* env vars into chart configmap"
```

---

## Task 3: Create `temporal-server-deployment.yaml`

**Files:**
- Create: `.infra/helm/ark/templates/temporal-server-deployment.yaml`

- [ ] **Step 1: Failing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -c "name: temporal-server$"
```

Expected: `0`.

- [ ] **Step 2: Create the Deployment template**

Create `.infra/helm/ark/templates/temporal-server-deployment.yaml`:

```yaml
{{- if .Values.temporal.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: temporal-server
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "ark.labels" . | nindent 4 }}
    app.kubernetes.io/component: temporal-server
spec:
  replicas: {{ .Values.temporal.server.replicaCount }}
  selector:
    matchLabels:
      {{- include "ark.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: temporal-server
  template:
    metadata:
      labels:
        {{- include "ark.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: temporal-server
    spec:
      containers:
        - name: temporal-server
          image: "{{ .Values.temporal.server.image.repository }}:{{ .Values.temporal.server.image.tag }}"
          imagePullPolicy: {{ .Values.temporal.server.image.pullPolicy }}
          args:
            - --service=frontend
            - --service=history
            - --service=matching
            - --service=worker
          env:
            - name: DB
              value: postgres12
            - name: POSTGRES_SEEDS
              value: {{ .Values.temporal.persistence.host | quote }}
            - name: DB_PORT
              value: {{ .Values.temporal.persistence.port | quote }}
            - name: DBNAME
              value: {{ .Values.temporal.persistence.database | quote }}
            - name: VISIBILITY_DBNAME
              value: {{ .Values.temporal.persistence.visibilityDatabase | quote }}
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.temporal.persistence.existingSecret }}
                  key: {{ .Values.temporal.persistence.secretKeys.username }}
            - name: POSTGRES_PWD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.temporal.persistence.existingSecret }}
                  key: {{ .Values.temporal.persistence.secretKeys.password }}
            - name: TEMPORAL_BROADCAST_ADDRESS
              value: "0.0.0.0"
          ports:
            - name: grpc
              containerPort: 7233
              protocol: TCP
          resources:
            {{- toYaml .Values.temporal.server.resources | nindent 12 }}
          # Probes use temporal CLI shipped with the server image's debian base.
          readinessProbe:
            exec:
              command:
                - sh
                - -c
                - "temporal operator cluster health --address 127.0.0.1:7233 >/dev/null 2>&1"
            initialDelaySeconds: 15
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 6
          livenessProbe:
            tcpSocket:
              port: 7233
            initialDelaySeconds: 60
            periodSeconds: 30
            timeoutSeconds: 5
            failureThreshold: 3
{{- end }}
```

- [ ] **Step 3: Passing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -c "name: temporal-server$"
```

Expected: `1` (Deployment metadata.name).

Also verify args are right:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -A4 "args:" | grep -c -- "--service=frontend"
```

Expected: `1`.

- [ ] **Step 4: Verify gating works**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml --set temporal.enabled=false 2>&1 | grep -c "name: temporal-server$"
```

Expected: `0`.

- [ ] **Step 5: Lint**

Run: `helm lint .infra/helm/ark`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add .infra/helm/ark/templates/temporal-server-deployment.yaml
git commit -m "feature: add temporal-server deployment template"
```

---

## Task 4: Create `temporal-server-service.yaml`

**Files:**
- Create: `.infra/helm/ark/templates/temporal-server-service.yaml`

- [ ] **Step 1: Failing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | awk '/^kind: Service$/{found=1} /^---$/{found=0} found && /name: temporal-server$/' | wc -l
```

Expected: `0`.

- [ ] **Step 2: Create the Service template**

Create `.infra/helm/ark/templates/temporal-server-service.yaml`:

```yaml
{{- if .Values.temporal.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: {{ .Values.temporal.serverServiceName }}
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "ark.labels" . | nindent 4 }}
    app.kubernetes.io/component: temporal-server
spec:
  type: ClusterIP
  selector:
    {{- include "ark.selectorLabels" . | nindent 4 }}
    app.kubernetes.io/component: temporal-server
  ports:
    - name: grpc
      port: 7233
      targetPort: grpc
      protocol: TCP
{{- end }}
```

- [ ] **Step 3: Passing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -E "^kind: Service$|^  name: temporal-server$" | grep -A1 -B0 "kind: Service"
```

Expected: at least one `kind: Service` block whose next-shown line is `  name: temporal-server`.

Simpler positive check:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | yq 'select(.kind == "Service" and .metadata.name == "temporal-server") | .spec.ports[0].port' -
```

Expected: `7233`.

(If `yq` is not installed, run `brew install yq` first.)

- [ ] **Step 4: Lint**

Run: `helm lint .infra/helm/ark`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add .infra/helm/ark/templates/temporal-server-service.yaml
git commit -m "feature: add temporal-server service template"
```

---

## Task 5: Create `temporal-schema-job.yaml`

**Files:**
- Create: `.infra/helm/ark/templates/temporal-schema-job.yaml`

- [ ] **Step 1: Failing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml --include-crds 2>&1 | grep -c "name: temporal-schema"
```

Expected: `0`.

- [ ] **Step 2: Create the Job template**

Create `.infra/helm/ark/templates/temporal-schema-job.yaml`:

```yaml
{{- if and .Values.temporal.enabled .Values.temporal.schemaJob.enabled }}
apiVersion: batch/v1
kind: Job
metadata:
  name: temporal-schema
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "ark.labels" . | nindent 4 }}
    app.kubernetes.io/component: temporal-schema
  annotations:
    # Run before any server pods come up, on every install and upgrade.
    # update-schema is a no-op when schema is already current, so re-runs
    # are cheap and safe.
    "helm.sh/hook": pre-install,pre-upgrade
    "helm.sh/hook-weight": "-10"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: {{ .Values.temporal.schemaJob.backoffLimit }}
  template:
    metadata:
      labels:
        {{- include "ark.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: temporal-schema
    spec:
      restartPolicy: Never
      containers:
        - name: schema
          image: "{{ .Values.temporal.schemaJob.image.repository }}:{{ .Values.temporal.schemaJob.image.tag }}"
          env:
            - name: SQL_PLUGIN
              value: postgres12
            - name: SQL_HOST
              value: {{ .Values.temporal.persistence.host | quote }}
            - name: SQL_PORT
              value: {{ .Values.temporal.persistence.port | quote }}
            - name: SQL_USER
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.temporal.persistence.existingSecret }}
                  key: {{ .Values.temporal.persistence.secretKeys.username }}
            - name: SQL_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.temporal.persistence.existingSecret }}
                  key: {{ .Values.temporal.persistence.secretKeys.password }}
          command:
            - /bin/sh
            - -c
            - |
              set -e
              DB={{ .Values.temporal.persistence.database }}
              VDB={{ .Values.temporal.persistence.visibilityDatabase }}
              # Setup is no-op if schema_version table already exists at v0.0.
              temporal-sql-tool --db "$DB" setup-schema -v 0.0 || true
              temporal-sql-tool --db "$DB" update-schema --schema-dir schema/postgresql/v12/temporal/versioned
              temporal-sql-tool --db "$VDB" setup-schema -v 0.0 || true
              temporal-sql-tool --db "$VDB" update-schema --schema-dir schema/postgresql/v12/visibility/versioned
              echo "Schema setup + update complete for $DB and $VDB."
{{- end }}
```

- [ ] **Step 3: Passing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -c "name: temporal-schema$"
```

Expected: `1`.

Verify the Helm hook annotation:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -c "pre-install,pre-upgrade"
```

Expected: `1`.

- [ ] **Step 4: Verify the schemaJob toggle works**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml --set temporal.schemaJob.enabled=false 2>&1 | grep -c "name: temporal-schema$"
```

Expected: `0`.

- [ ] **Step 5: Lint**

Run: `helm lint .infra/helm/ark`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add .infra/helm/ark/templates/temporal-schema-job.yaml
git commit -m "feature: add temporal schema migration job (pre-install,pre-upgrade hook)"
```

---

## Task 6: Create `temporal-namespace-job.yaml`

**Files:**
- Create: `.infra/helm/ark/templates/temporal-namespace-job.yaml`

- [ ] **Step 1: Failing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -c "name: temporal-namespace"
```

Expected: `0`.

- [ ] **Step 2: Create the Job template**

Create `.infra/helm/ark/templates/temporal-namespace-job.yaml`:

```yaml
{{- if and .Values.temporal.enabled .Values.temporal.namespaceJob.enabled }}
apiVersion: batch/v1
kind: Job
metadata:
  name: temporal-namespace
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "ark.labels" . | nindent 4 }}
    app.kubernetes.io/component: temporal-namespace
  annotations:
    # Post-install: server must be up before we can call its API.
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-weight": "10"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: 3
  template:
    metadata:
      labels:
        {{- include "ark.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: temporal-namespace
    spec:
      restartPolicy: Never
      containers:
        - name: namespace
          image: "{{ .Values.temporal.namespaceJob.image.repository }}:{{ .Values.temporal.namespaceJob.image.tag }}"
          env:
            - name: TEMPORAL_ADDRESS
              value: "{{ .Values.temporal.serverServiceName }}:7233"
            - name: TEMPORAL_CLI_ADDRESS
              value: "{{ .Values.temporal.serverServiceName }}:7233"
          command:
            - /bin/sh
            - -c
            - |
              set -e
              # Wait up to 90s for server to be reachable.
              for i in $(seq 1 30); do
                if temporal operator cluster health --address "$TEMPORAL_ADDRESS" >/dev/null 2>&1; then
                  break
                fi
                echo "waiting for temporal-server... ($i)"
                sleep 3
              done
              # Idempotent namespace creation.
              {{- range .Values.temporal.namespaces }}
              if temporal operator namespace describe {{ . | quote }} >/dev/null 2>&1; then
                echo "namespace {{ . }} exists"
              else
                temporal operator namespace create --retention {{ $.Values.temporal.namespaceJob.retention }} {{ . | quote }}
                echo "namespace {{ . }} created"
              fi
              {{- end }}
{{- end }}
```

- [ ] **Step 3: Passing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -c "name: temporal-namespace$"
```

Expected: `1`.

Verify the post-install hook is set:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -c "post-install,post-upgrade"
```

Expected: `1`.

Verify namespace iteration:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -c "namespace describe \"ark-test\""
```

Expected: `1`.

- [ ] **Step 4: Lint**

Run: `helm lint .infra/helm/ark`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add .infra/helm/ark/templates/temporal-namespace-job.yaml
git commit -m "feature: add temporal namespace post-install job"
```

---

## Task 7: Create `temporal-ui-deployment.yaml`

**Files:**
- Create: `.infra/helm/ark/templates/temporal-ui-deployment.yaml`

- [ ] **Step 1: Failing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -c "name: temporal-ui$"
```

Expected: `0`.

- [ ] **Step 2: Create the Deployment template**

Create `.infra/helm/ark/templates/temporal-ui-deployment.yaml`:

```yaml
{{- if and .Values.temporal.enabled .Values.temporal.ui.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: temporal-ui
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "ark.labels" . | nindent 4 }}
    app.kubernetes.io/component: temporal-ui
spec:
  replicas: 1
  selector:
    matchLabels:
      {{- include "ark.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: temporal-ui
  template:
    metadata:
      labels:
        {{- include "ark.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: temporal-ui
    spec:
      containers:
        - name: ui
          image: "{{ .Values.temporal.ui.image.repository }}:{{ .Values.temporal.ui.image.tag }}"
          env:
            - name: TEMPORAL_ADDRESS
              value: "{{ .Values.temporal.serverServiceName }}:7233"
            {{- if .Values.temporal.ui.corsOrigins }}
            - name: TEMPORAL_CORS_ORIGINS
              value: {{ .Values.temporal.ui.corsOrigins | quote }}
            {{- end }}
          ports:
            - name: http
              containerPort: 8080
              protocol: TCP
          readinessProbe:
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
{{- end }}
```

- [ ] **Step 3: Passing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -c "name: temporal-ui$"
```

Expected: `1`.

- [ ] **Step 4: Verify UI toggle**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml --set temporal.ui.enabled=false 2>&1 | grep -c "name: temporal-ui$"
```

Expected: `0`.

- [ ] **Step 5: Lint**

Run: `helm lint .infra/helm/ark`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add .infra/helm/ark/templates/temporal-ui-deployment.yaml
git commit -m "feature: add temporal-ui deployment template (gated)"
```

---

## Task 8: Create `temporal-ui-service.yaml`

**Files:**
- Create: `.infra/helm/ark/templates/temporal-ui-service.yaml`

- [ ] **Step 1: Failing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | yq 'select(.kind == "Service" and .metadata.name == "temporal-ui")' - | wc -l
```

Expected: `0`.

- [ ] **Step 2: Create the Service template**

Create `.infra/helm/ark/templates/temporal-ui-service.yaml`:

```yaml
{{- if and .Values.temporal.enabled .Values.temporal.ui.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: temporal-ui
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "ark.labels" . | nindent 4 }}
    app.kubernetes.io/component: temporal-ui
spec:
  type: ClusterIP
  selector:
    {{- include "ark.selectorLabels" . | nindent 4 }}
    app.kubernetes.io/component: temporal-ui
  ports:
    - name: http
      port: 8080
      targetPort: http
      protocol: TCP
{{- end }}
```

- [ ] **Step 3: Passing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | yq 'select(.kind == "Service" and .metadata.name == "temporal-ui") | .spec.ports[0].port' -
```

Expected: `8080`.

- [ ] **Step 4: Lint**

Run: `helm lint .infra/helm/ark`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add .infra/helm/ark/templates/temporal-ui-service.yaml
git commit -m "feature: add temporal-ui service template"
```

---

## Task 9: Create `temporal-worker-deployment.yaml`

**Files:**
- Create: `.infra/helm/ark/templates/temporal-worker-deployment.yaml`

- [ ] **Step 1: Failing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -c "name: temporal-worker$"
```

Expected: `0`.

- [ ] **Step 2: Create the Deployment template**

Create `.infra/helm/ark/templates/temporal-worker-deployment.yaml`:

```yaml
{{- if .Values.temporal.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: temporal-worker
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "ark.labels" . | nindent 4 }}
    app.kubernetes.io/component: temporal-worker
spec:
  replicas: {{ .Values.temporal.worker.replicaCount }}
  selector:
    matchLabels:
      {{- include "ark.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: temporal-worker
  template:
    metadata:
      labels:
        {{- include "ark.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: temporal-worker
    spec:
      {{- if .Values.serviceAccount.create }}
      serviceAccountName: {{ include "ark.serviceAccountName" . }}
      {{- end }}
      containers:
        - name: worker
          image: "{{ .Values.temporal.worker.image.repository }}:{{ .Values.temporal.worker.image.tag }}"
          imagePullPolicy: {{ .Values.temporal.worker.image.pullPolicy }}
          # Entrypoint is defined in .infra/Dockerfile.temporal-worker:
          #   exec tsx packages/core/temporal/worker.ts
          envFrom:
            - configMapRef:
                name: {{ include "ark.fullname" . }}-config
            {{- if and (not .Values.postgresql.enabled) .Values.postgresql.external.existingSecret }}
            - secretRef:
                name: {{ .Values.postgresql.external.existingSecret }}
            {{- end }}
          env:
            {{- if and (not .Values.postgresql.enabled) .Values.postgresql.external.host }}
            - name: DB_HOST
              value: {{ .Values.postgresql.external.host | quote }}
            - name: DB_PORT
              value: {{ .Values.postgresql.external.port | quote }}
            - name: DB_NAME
              value: {{ .Values.postgresql.external.database | quote }}
            {{- end }}
          resources:
            {{- toYaml .Values.temporal.worker.resources | nindent 12 }}
          # Liveness via a noop curl to Temporal frontend -- if frontend is
          # unreachable for >30s the worker process self-terminates via SDK
          # retry exhaustion. We let k8s restart the pod.
          livenessProbe:
            exec:
              command:
                - sh
                - -c
                - "pgrep -f 'tsx packages/core/temporal/worker.ts' >/dev/null"
            initialDelaySeconds: 30
            periodSeconds: 30
            timeoutSeconds: 5
            failureThreshold: 3
{{- end }}
```

- [ ] **Step 3: Passing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -c "name: temporal-worker$"
```

Expected: `1`.

Verify ConfigMap envFrom is wired so the worker gets ARK_TEMPORAL_* vars:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | awk '/^kind: Deployment$/,/^---$/ { if (/name: temporal-worker$/) flag=1; if (flag) print }' | grep -c "configMapRef"
```

Expected: `1`.

- [ ] **Step 4: Verify gating**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml --set temporal.enabled=false 2>&1 | grep -c "name: temporal-worker$"
```

Expected: `0`.

- [ ] **Step 5: Lint**

Run: `helm lint .infra/helm/ark`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add .infra/helm/ark/templates/temporal-worker-deployment.yaml
git commit -m "feature: add ark temporal-worker deployment template"
```

---

## Task 10: Extend ingress for `/temporal` UI path

**Files:**
- Modify: `.infra/helm/ark/templates/ingress.yaml`

- [ ] **Step 1: Read existing ingress**

Run: `cat .infra/helm/ark/templates/ingress.yaml`
Read the existing structure to understand the path/rule pattern. The Ark control plane likely lives at `/`. We add `/temporal` only when `temporal.ui.ingress.enabled` is true.

- [ ] **Step 2: Failing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml --set temporal.ui.ingress.enabled=true 2>&1 | grep -c "/temporal"
```

Expected: `0` (no rule yet).

- [ ] **Step 3: Append the temporal-ui ingress rule**

Locate the `paths:` array inside the existing rule and add (using Edit, do not regenerate the whole file). Append this block adjacent to the existing path entry, inside the same `paths:` list:

```yaml
            {{- if and .Values.temporal.enabled .Values.temporal.ui.enabled .Values.temporal.ui.ingress.enabled }}
            - path: {{ .Values.temporal.ui.ingress.path }}
              pathType: Prefix
              backend:
                service:
                  name: temporal-ui
                  port:
                    number: 8080
            {{- end }}
```

Exact placement: inside the existing `- host:` -> `http:` -> `paths:` block. If the existing ingress has multiple hosts, add the rule only to the first.

- [ ] **Step 4: Passing render check**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml --set temporal.ui.ingress.enabled=true 2>&1 | grep -c "path: /temporal"
```

Expected: `1`.

Run with default (disabled):
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml 2>&1 | grep -c "path: /temporal"
```

Expected: `0`.

- [ ] **Step 5: Lint**

Run: `helm lint .infra/helm/ark`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add .infra/helm/ark/templates/ingress.yaml
git commit -m "enhancement: add optional /temporal ui ingress rule"
```

---

## Task 11: Full-chart render regression test

**Files:**
- (no file changes; this is a verification task)

- [ ] **Step 1: Render entire chart and count expected Temporal resources**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml > /tmp/ark-full-render.yaml
grep -c "^kind:" /tmp/ark-full-render.yaml
```

Note the count (baseline). Expected: original chart resource count + 7 new (server Deployment, server Service, schema Job, namespace Job, UI Deployment, UI Service, worker Deployment).

- [ ] **Step 2: Verify each Temporal resource exists exactly once**

Run:
```bash
for name in temporal-server temporal-schema temporal-namespace temporal-ui temporal-worker; do
  count=$(grep -c "^  name: $name$" /tmp/ark-full-render.yaml || true)
  echo "$name: $count"
done
```

Expected (1 or 2 per row -- 2 for components with both Deployment and Service):
```
temporal-server: 2
temporal-schema: 1
temporal-namespace: 1
temporal-ui: 2
temporal-worker: 1
```

- [ ] **Step 3: Verify nothing renders when disabled**

Run:
```bash
helm template ark .infra/helm/ark -f docs/superpowers/plans/values-test.yaml --set temporal.enabled=false 2>&1 | grep -c "temporal-"
```

Expected: `0`.

- [ ] **Step 4: kubeval the rendered output (if installed)**

Optional but recommended. Run:
```bash
which kubeval >/dev/null && kubeval /tmp/ark-full-render.yaml || echo "kubeval not installed, skipping"
```

If installed: expect `PASS - * is valid` for every document. Fix any failures by going back to the offending template.

---

## Task 12: Production values overrides

**Files:**
- Modify: `.infra/helm/ark/values-production.yaml`

- [ ] **Step 1: Read existing production values**

Run: `cat .infra/helm/ark/values-production.yaml`
Note the structure -- this file overrides chart defaults for production-shaped deployments.

- [ ] **Step 2: Append the temporal production overrides**

Append to `.infra/helm/ark/values-production.yaml`:

```yaml

# -- Temporal (production overrides)
# The persistence.host MUST be set per AWS account in the account-specific
# values file (e.g., values-<account>.yaml). It is intentionally blank here.
temporal:
  enabled: true
  # Each environment overrides namespace + namespaces in its own values file.
  server:
    replicaCount: 2
    resources:
      requests:
        cpu: 1000m
        memory: 2Gi
      limits:
        cpu: 4000m
        memory: 8Gi
  schemaJob:
    enabled: true
  namespaceJob:
    enabled: true
  ui:
    enabled: true
    ingress:
      enabled: true
      path: /temporal
  worker:
    replicaCount: 3
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: 2000m
        memory: 4Gi
```

- [ ] **Step 3: Verify production values render**

Run:
```bash
helm template ark .infra/helm/ark -f .infra/helm/ark/values-production.yaml --set temporal.persistence.host=pgbouncer.prod --set postgresql.external.host=rds.prod --set postgresql.external.existingSecret=ark-db-credentials > /tmp/ark-prod-render.yaml 2>&1
grep -c "^kind:" /tmp/ark-prod-render.yaml
```

Expected: positive count, no error output.

- [ ] **Step 4: Lint**

Run: `helm lint .infra/helm/ark -f .infra/helm/ark/values-production.yaml`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add .infra/helm/ark/values-production.yaml
git commit -m "enhancement: add temporal production overrides to values-production"
```

---

## Task 13: Update `docs/temporal.md` follow-ups

**Files:**
- Modify: `docs/temporal.md`

- [ ] **Step 1: Locate the Bun-vs-Node section**

Run: `grep -n "Bun-vs-Node\|start on Bun" docs/temporal.md`
Find the production-runtime line that currently says "start on Bun".

- [ ] **Step 2: Update worker runtime decision**

Replace the "Production: start on Bun" sentence with a note that the Helm chart ships the Node+tsx worker (per commit `a681409d`), referencing `.infra/Dockerfile.temporal-worker`. The "switch to Node only if needed" criterion is now irrelevant; remove or annotate that paragraph.

Use Edit; the exact content depends on the doc state at execution time. Capture the change as a one-paragraph correction citing the implementation that already exists.

- [ ] **Step 3: Locate the Helm sub-chart section**

Run: `grep -n "sub-chart" docs/temporal.md`
Find lines 253 and 280 (or wherever they live at execution time).

- [ ] **Step 4: Annotate the sub-chart deviation**

Add a paragraph immediately after line 280 (the "Ship the worker as a sub-chart" row) noting that the implementation ships the entire Temporal stack (server + UI + worker + Jobs) in the main `.infra/helm/ark/` chart, not a sub-chart, because self-hosting the Temporal server in-cluster made a sub-chart's overhead unjustified. Reference `docs/superpowers/specs/2026-05-12-temporal-helm-gap-design.md` D5.

- [ ] **Step 5: Commit**

```bash
git add docs/temporal.md
git commit -m "chore: align temporal.md with shipped helm chart layout"
```

---

## Task 14: Deployment runbook

**Files:**
- Create: `.infra/helm/ark/README-temporal-deploy.md`

- [ ] **Step 1: Create the runbook**

Create `.infra/helm/ark/README-temporal-deploy.md`:

```markdown
# Deploying Ark with Temporal to a new AWS account

This runbook covers the prerequisites and `helm` commands to deploy Ark control plane
with Temporal Phase 3 orchestration to a fresh AWS account.

## Prerequisites (Ops, out of Helm)

1. **EKS cluster** with nginx-ingress and External Secrets Operator installed.
2. **RDS Postgres 16** instance with two logical databases:
   ```sql
   CREATE DATABASE ark;
   CREATE DATABASE temporal;
   CREATE DATABASE temporal_visibility;
   CREATE ROLE temporal LOGIN PASSWORD '...' CONNECTION LIMIT 50;
   GRANT ALL PRIVILEGES ON DATABASE temporal TO temporal;
   GRANT ALL PRIVILEGES ON DATABASE temporal_visibility TO temporal;
   ```
3. **pgbouncer** Deployment in the EKS cluster pointing at RDS. Per-database pools
   sized per `docs/temporal.md:218`.
4. **Secrets Manager** entries:
   - `ark-db-credentials` -- DB_USERNAME, DB_PASSWORD for the `ark` DB
   - `temporal-db-credentials` -- POSTGRES_USER, POSTGRES_PWD for the `temporal` role
   - App keys (ANTHROPIC_API_KEY, etc.)
5. **IRSA** role bound to the chart's ServiceAccount with S3 + Secrets Manager
   permissions.
6. **Container images** pushed:
   - `ark:<tag>` from main Dockerfile
   - `ark-temporal-worker:<tag>` from `.infra/Dockerfile.temporal-worker`

## Helm install

```bash
helm upgrade --install ark .infra/helm/ark \
  -f .infra/helm/ark/values-production.yaml \
  -f values-<account>.yaml \
  --namespace ark --create-namespace
```

Account-specific values file (`values-<account>.yaml`) sets at minimum:
- `controlPlane.image.repository` / `controlPlane.image.tag`
- `postgresql.external.host` (RDS endpoint)
- `redis.external.host` (ElastiCache endpoint)
- `temporal.persistence.host` (pgbouncer endpoint)
- `temporal.namespace` and `temporal.namespaces`
- `temporal.worker.image.repository` / `temporal.worker.image.tag`
- `ingress.host`
- `serviceAccount.annotations.eks.amazonaws.com/role-arn` (IRSA)

## Verify

```bash
kubectl -n ark get pods
kubectl -n ark logs deploy/temporal-server | head -20
kubectl -n ark logs deploy/temporal-worker | head -20
kubectl -n ark exec deploy/temporal-server -- temporal operator namespace list
```

Expected: all pods Running, namespace list includes the configured namespaces.

## Rollback

```bash
helm rollback ark
```

Schema migrations are forward-only; rolling back the chart does NOT roll back the
Temporal schema. Major Temporal version downgrades require an Ops-coordinated
schema restore from RDS snapshot.
```

- [ ] **Step 2: Commit**

```bash
git add .infra/helm/ark/README-temporal-deploy.md
git commit -m "chore: add temporal deployment runbook for new AWS accounts"
```

---

## Self-Review Notes

After writing the plan, I checked it against the spec:

**Spec coverage:**
- D1 (self-hosted in EKS): Task 3 ships the server Deployment. ✓
- D2 (shared RDS, logical DB isolation): Task 3's env vars + Task 5's schema Job target two logical DBs. ✓
- D3 (pgbouncer out of chart): Task 14 runbook documents Ops responsibility; templates only point at `temporal.persistence.host`. ✓
- D4 (Node+tsx worker runtime): Task 9 uses the existing `Dockerfile.temporal-worker` image. ✓
- D5 (single chart, not sub-chart): all templates go to `.infra/helm/ark/templates/`. ✓
- D6 (monolithic `service=all`): Task 3's args. ✓
- D7 (pre-install,pre-upgrade hook): Task 5. ✓
- D8 (post-install namespace hook): Task 6. ✓
- D9 (chart owns server/UI/worker/Jobs; Ops owns infra): split across tasks; Task 14 runbook captures the Ops boundary. ✓

**Placeholder scan:** zero TBD/TODO/etc. in the plan body. The two "blank by design" values (`temporal.persistence.host`, `temporal.ui.corsOrigins`) are documented as account-overridden.

**Type consistency:** values keys are consistent across tasks (`temporal.serverServiceName`, `temporal.persistence.host`, `temporal.namespaces` list).

**No gaps detected.**

---

## Plan complete

Plan saved to `docs/superpowers/plans/2026-05-12-temporal-helm-gap.md`. Two execution options:

**1. Subagent-Driven (recommended)** -- I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** -- Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
