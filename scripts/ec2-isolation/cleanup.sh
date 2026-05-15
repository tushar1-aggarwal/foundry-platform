#!/usr/bin/env bash
# Roll back what the ec2-isolation suite created.
#
# Steps (best-effort; each step continues on error):
#   1. Revert ark-worker Deployment patch (remove envFrom secret)
#   2. Delete the ark-aws-creds-probe Secret
#   3. Delete dispatch ConfigMaps + Jobs (ark-ec2-dispatch-*)
#   4. Optionally delete the EC2 compute row (--delete-row)
#
# Defaults to keeping the compute row -- so a future session can target it
# without re-registering. Pass `--delete-row` to wipe it.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

DELETE_ROW=0
for arg in "$@"; do
  case "$arg" in
    --delete-row) DELETE_ROW=1 ;;
    -h|--help)
      echo "Usage: $0 [--delete-row]"
      exit 0
      ;;
  esac
done

SECRET_NAME="ark-aws-creds-probe"
WORKER_DEPLOYMENT="ark-worker"

log "1. revert worker envFrom patch"
# Strategic-merge with envFrom: [] replaces (empties) the list. But we want
# to remove our specific entry only. Easiest: re-patch with the original
# (empty) envFrom. Pods that didn't have envFrom originally get null treated
# as empty, which is what we want.
REVERT=$(jq -nc '{
  spec: {
    template: {
      metadata: { annotations: { "ec2-isolation-patched-at": null } },
      spec: { containers: [ { name: "ark-worker", envFrom: [] } ] }
    }
  }
}')
RESP=$(k_patch_json "/apis/apps/v1/namespaces/$EKS_NAMESPACE/deployments/$WORKER_DEPLOYMENT" "$REVERT")
if echo "$RESP" | jq -e '.kind == "Deployment"' >/dev/null 2>&1; then
  ok "envFrom cleared"
else
  warn "patch revert response: $(echo "$RESP" | jq -r '.message // .')"
fi

log "2. delete Secret $SECRET_NAME"
RESP=$(k_delete "/api/v1/namespaces/$EKS_NAMESPACE/secrets/$SECRET_NAME")
case "$(echo "$RESP" | jq -r '.status // .kind')" in
  Success|Secret) ok "deleted" ;;
  *) warn "$(echo "$RESP" | jq -r '.message // .')" ;;
esac

log "3. delete dispatch ConfigMaps + Jobs (ark-ec2-dispatch-*)"
CMS=$(k_get "/api/v1/namespaces/$EKS_NAMESPACE/configmaps" \
  | jq -r '.items[].metadata.name' | grep '^ark-ec2-dispatch-' || true)
JOBS=$(k_get "/apis/batch/v1/namespaces/$EKS_NAMESPACE/jobs" \
  | jq -r '.items[].metadata.name' | grep '^ark-ec2-dispatch-' || true)
for cm in $CMS; do
  k_delete "/api/v1/namespaces/$EKS_NAMESPACE/configmaps/$cm" >/dev/null 2>&1
  ok "cm $cm"
done
for j in $JOBS; do
  K_CURL_PATH="/apis/batch/v1/namespaces/$EKS_NAMESPACE/jobs/$j?propagationPolicy=Background" k_curl -X DELETE >/dev/null 2>&1
  ok "job $j"
done

if [ "$DELETE_ROW" -eq 1 ]; then
  log "4. delete EC2 compute row name=$EC2_COMPUTE_NAME"
  SQL="DELETE FROM compute WHERE name='$EC2_COMPUTE_NAME' AND tenant_id='default' RETURNING name;"
  POD="ark-del-ec2-$(date +%s)"
  POD_JSON=$(jq -nc --arg name "$POD" --arg ns "$EKS_NAMESPACE" --arg sql "$SQL" '{
    apiVersion:"v1", kind:"Pod",
    metadata:{name:$name, namespace:$ns},
    spec:{
      restartPolicy:"Never",
      containers:[{
        name:"psql", image:"postgres:16-alpine",
        command:["sh","-c", ("psql -c \"" + $sql + "\"")],
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
  wait_pod_phase "$POD" Succeeded 30 >/dev/null
  pod_logs "$POD"
  k_delete "/api/v1/namespaces/$EKS_NAMESPACE/pods/$POD" >/dev/null 2>&1 &
else
  log "4. keep EC2 compute row (pass --delete-row to wipe)"
fi

echo
log "cleanup done"
