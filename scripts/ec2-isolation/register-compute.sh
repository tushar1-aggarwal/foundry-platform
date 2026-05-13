#!/usr/bin/env bash
# Insert an EC2 compute row into the deployed CP's RDS Postgres so a session
# can target it via `compute_name`. Uses `attachExistingHandle` path -- the
# instance is reused, no fresh provision.
#
# Env knobs (with defaults from lib.sh):
#   EC2_COMPUTE_NAME    name used in session.compute_name (default: test-ec2)
#   EC2_INSTANCE_ID     existing EC2 to attach to (default: i-08b0a5598afefe5a5)
#   AWS_REGION          ec2 region (default: ap-south-1)
#
# Idempotent: ON CONFLICT DO UPDATE on (name, tenant_id).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

log "registering ec2 compute name=$EC2_COMPUTE_NAME instance=$EC2_INSTANCE_ID region=$AWS_REGION"

# Build config JSON. NOTE: no `aws_profile` -> EC2Compute falls back to the
# default AWS credential chain (env vars), which is what we'll inject into
# ark-worker via patch-worker-creds.sh.
CONFIG=$(jq -nc \
  --arg instance_id "$EC2_INSTANCE_ID" \
  --arg region "$AWS_REGION" \
  --arg stack "ark-compute-$EC2_COMPUTE_NAME" '{
    instance_id: $instance_id,
    region: $region,
    stack_name: $stack,
    size: "m",
    arch: "x64"
  }')

# Use a here-string for the SQL so escaping stays sane.
read -r -d '' SQL <<EOF || true
INSERT INTO compute (name, provider, compute_kind, isolation_kind, status, config, tenant_id, created_at, updated_at)
VALUES ('$EC2_COMPUTE_NAME', 'ec2', 'ec2', 'direct', 'running', '$CONFIG'::jsonb, 'default', now()::text, now()::text)
ON CONFLICT (name) DO UPDATE
  SET compute_kind = EXCLUDED.compute_kind,
      isolation_kind = EXCLUDED.isolation_kind,
      provider = EXCLUDED.provider,
      status = EXCLUDED.status,
      config = EXCLUDED.config,
      updated_at = now()::text;
SELECT compute_kind, name, status, config FROM compute WHERE name='$EC2_COMPUTE_NAME';
EOF

POD="ark-register-ec2-$(date +%s)"
POD_JSON=$(jq -nc --arg name "$POD" --arg ns "$EKS_NAMESPACE" --arg sql "$SQL" '{
  apiVersion:"v1", kind:"Pod",
  metadata:{name:$name, namespace:$ns},
  spec:{
    restartPolicy:"Never",
    containers:[{
      name:"psql", image:"postgres:16-alpine",
      command:["sh","-c", ("psql <<'\''SQL'\''\n" + $sql + "\nSQL\n")],
      env:[
        {name:"PGSSLMODE", value:"require"},
        {name:"PGHOST", value:"foundry.chy2qgkm0yi2.ap-south-1.rds.amazonaws.com"},
        {name:"PGPORT", value:"5432"},
        {name:"PGDATABASE", value:"ark"},
        {name:"PGUSER", valueFrom:{secretKeyRef:{name:"ark-secrets", key:"DB_USERNAME"}}},
        {name:"PGPASSWORD", valueFrom:{secretKeyRef:{name:"ark-secrets", key:"DB_PASSWORD"}}}
      ]
    }]
  }
}')

k_post_json "/api/v1/namespaces/$EKS_NAMESPACE/pods" "$POD_JSON" >/dev/null
phase=$(wait_pod_phase "$POD" Succeeded 40)
echo "phase=$phase"
echo "--- logs ---"
pod_logs "$POD"
k_delete "/api/v1/namespaces/$EKS_NAMESPACE/pods/$POD" >/dev/null 2>&1 &

if [ "$phase" = "Succeeded" ]; then
  log "compute row registered (or refreshed)"
  exit 0
else
  log "FAILED to register compute row"
  exit 1
fi
