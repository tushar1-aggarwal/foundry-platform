# Deploying ark to local Kubernetes (OrbStack)

The full ark control plane -- control plane, workers, Temporal (server +
worker + UI + schema/namespace jobs), Postgres, Redis, and LocalStack (S3
emulator) -- runs in a local OrbStack cluster via a single `make` target.

## Prerequisites

- **OrbStack with Kubernetes enabled.** Open OrbStack, click the cluster
  icon, enable Kubernetes. The context name is `orbstack`.
- **Docker** -- ships with OrbStack; the `make` target uses it to build the
  ark image. OrbStack k8s pulls local images automatically, so no separate
  `kind load` / `minikube image` step is needed.
- **`helm` v3.** `brew install helm`.
- **`kubectl`.** OrbStack provisions a kubeconfig context automatically.
- **`ANTHROPIC_API_KEY`** exported in your shell -- the chart pipes it into
  the LLM secret so agents can call Claude.

## Bring it up

```bash
export ANTHROPIC_API_KEY=sk-ant-...
make dev-k8s-local
```

The target:
1. Builds the ark image as `ark:local`.
2. Switches kubectl to the `orbstack` context.
3. Runs `helm upgrade --install ark .infra/helm/ark` with inline `--set`
   flags that enable LocalStack, point the chart at the in-cluster
   Postgres + Redis, turn off auth and TLS, and inject the API key.
4. Waits up to 10 min for all pods to become ready (Temporal server may
   crashloop briefly while the schema job runs; this is expected).

## Verify

Port-forward the control plane and Temporal UI:

```bash
kubectl -n ark port-forward svc/ark-control-plane 8420:8420 &
kubectl -n ark port-forward svc/temporal-ui      8088:8080 &
open http://localhost:8420
open http://localhost:8088
```

Smoke-check the in-cluster S3:

```bash
kubectl -n ark exec deploy/ark-localstack -- \
  awslocal s3 ls s3://ark-local
```

Kick off a session via the web UI. The Temporal UI will show a workflow
started under namespace `ark`, task queue `ark.default.stages`.

## Tear it down

```bash
make dev-k8s-local-down
```

This uninstalls the helm release, deletes all PVCs (including the
postgres data volume), and removes the `ark` namespace.

## What the chart deploys

| Component       | In-cluster? | Toggled by              |
|-----------------|-------------|-------------------------|
| Control plane   | always      | (structural)            |
| Workers         | always      | `workers.enabled`       |
| Temporal stack  | always      | (structural)            |
| Postgres        | optional    | `postgresql.enabled`    |
| Redis           | optional    | `redis.enabled`         |
| LocalStack (S3) | optional    | `localstack.enabled`    |
| TensorZero      | optional    | `tensorZero.enabled`    |
| Ingress         | optional    | `ingress.enabled`       |

Temporal is structural -- it is always deployed. To point ark at an
external Postgres (the production shape), set `postgresql.enabled=false`
plus `postgresql.external.host` / `external.existingSecret`. Same pattern
applies to Redis (`redis.external.*`) and LocalStack
(`localstack.external.endpoint`).

## Troubleshooting

**Pods stuck in `ImagePullBackOff` for `ark:local`.** OrbStack normally
shares the docker daemon with the cluster. If pulling fails, confirm
OrbStack k8s and your docker context are in sync (Settings -> Kubernetes
-> "Use Docker images from host").

**`temporal-server` crashlooping after the install completes.** The
`temporal-schema` Job runs post-install (because in-cluster Postgres only
exists after the install phase). Server pods crashloop until schema is
laid down. Watch:
```bash
kubectl -n ark logs job/temporal-schema -f
```
Once that job logs `Schema setup + update complete...`, the server stabilizes
on its next restart.

**`temporal-db-bootstrap` Job fails.** It waits up to 120s for Postgres to
be reachable before trying to create the temporal role. If postgres is
slow to come up:
```bash
kubectl -n ark logs job/temporal-db-bootstrap
kubectl -n ark get pods -l app.kubernetes.io/component=postgresql
```

**`localstack-init` Job fails with "bucket already exists" warnings.**
Benign -- the job is idempotent; the second run sees the bucket from the
first.

**Control plane fails with "blob backend rejected".** Means `s3.bucket` is
set but the S3 endpoint is unreachable. Check LocalStack:
```bash
kubectl -n ark logs deploy/ark-localstack
kubectl -n ark exec deploy/ark-control-plane -- env | grep S3
```

**Auth/UI redirect loop.** `controlPlane.auth.enabled=false` is set by the
`make` target. If you flip it on without configuring Google OIDC, the UI
will loop. Keep it off for local.
