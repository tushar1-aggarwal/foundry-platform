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

## Accessing the Temporal UI

The chart deploys the Temporal UI Deployment + ClusterIP Service (`temporal-ui:8080`)
but does NOT route it through the main ingress by default. Reason: the UI image
serves at `/` and the prod ingress would forward `/temporal/...` to the backend
unchanged (404). Two ways to expose it safely:

- **Port-forward** (operator/dev access):
  ```bash
  kubectl -n ark port-forward svc/temporal-ui 8088:8080
  # Open http://localhost:8088
  ```
- **Dedicated subdomain** (team access): create a separate Ingress resource with
  `host: temporal.<your-domain>` and a single `path: /` rule pointing at
  `temporal-ui:8080`. Not yet wired in the chart -- add a per-account values file
  or a custom manifest.

## Rollback

```bash
helm rollback ark
```

Schema migrations are forward-only; rolling back the chart does NOT roll back the
Temporal schema. Major Temporal version downgrades require an Ops-coordinated
schema restore from RDS snapshot.
