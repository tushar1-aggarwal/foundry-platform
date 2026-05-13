#!/usr/bin/env bash
# Inject AWS_* env vars into the deployed ark-worker Deployment so EC2Compute
# can authenticate via the default credential chain. Reads credentials from
# the LAPTOP'S current SSO session and writes them into a k8s Secret in the
# `ark` namespace, then patches the ark-worker Deployment to envFrom that
# secret.
#
# IMPORTANT: SSO creds expire (~8h for most profiles). After expiry the
# worker pod will start failing AWS calls. Re-run this script to refresh.
# A production setup would use IRSA, not env-var injection -- this is a
# debugging/probe shortcut only.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

SECRET_NAME="ark-aws-creds-probe"
WORKER_DEPLOYMENT="ark-worker"

log "exporting SSO creds from profile=$AWS_PROFILE"
CREDS=$(AWS_PROFILE="$AWS_PROFILE" aws configure export-credentials --format json 2>&1)
if [ "$?" -ne 0 ]; then
  echo "FATAL: export-credentials failed: $CREDS" >&2
  echo "Hint: ! aws sso login --profile $AWS_PROFILE" >&2
  exit 1
fi

AK=$(echo "$CREDS" | jq -r '.AccessKeyId')
SK=$(echo "$CREDS" | jq -r '.SecretAccessKey')
ST=$(echo "$CREDS" | jq -r '.SessionToken // empty')
EXP=$(echo "$CREDS" | jq -r '.Expiration // "unknown"')
ok "creds expire at $EXP"

# Build secret data (base64-encoded values).
data_json=$(jq -nc \
  --arg ak "$(printf '%s' "$AK" | base64)" \
  --arg sk "$(printf '%s' "$SK" | base64)" \
  --arg st "$(printf '%s' "$ST" | base64)" \
  --arg region "$(printf '%s' "$AWS_REGION" | base64)" '
  {
    AWS_ACCESS_KEY_ID: $ak,
    AWS_SECRET_ACCESS_KEY: $sk,
    AWS_SESSION_TOKEN: $st,
    AWS_DEFAULT_REGION: $region
  } | with_entries(select(.value != ""))
')

SECRET_JSON=$(jq -nc --arg name "$SECRET_NAME" --arg ns "$EKS_NAMESPACE" --argjson data "$data_json" '{
  apiVersion: "v1", kind: "Secret",
  metadata: {name: $name, namespace: $ns},
  type: "Opaque",
  data: $data
}')

log "creating/refreshing Secret $SECRET_NAME"
# Delete-then-create to avoid race on stale data.
k_delete "/api/v1/namespaces/$EKS_NAMESPACE/secrets/$SECRET_NAME" >/dev/null 2>&1 || true
RESP=$(k_post_json "/api/v1/namespaces/$EKS_NAMESPACE/secrets" "$SECRET_JSON")
if echo "$RESP" | jq -e '.kind == "Secret"' >/dev/null 2>&1; then
  ok "secret created"
else
  echo "FATAL: secret create failed: $RESP" >&2
  exit 1
fi

log "patching $WORKER_DEPLOYMENT to envFrom this secret"
# Strategic-merge patch that adds (or no-ops on) an envFrom entry.
PATCH=$(jq -nc --arg secret "$SECRET_NAME" '{
  spec: {
    template: {
      metadata: { annotations: { "ec2-isolation-patched-at": (now | todate) } },
      spec: {
        containers: [
          {
            name: "ark-worker",
            envFrom: [
              { secretRef: { name: $secret } }
            ]
          }
        ]
      }
    }
  }
}')
RESP=$(k_patch_json "/apis/apps/v1/namespaces/$EKS_NAMESPACE/deployments/$WORKER_DEPLOYMENT" "$PATCH")
if echo "$RESP" | jq -e '.kind == "Deployment"' >/dev/null 2>&1; then
  ok "patch applied -- new rollout will pick up creds"
else
  echo "FATAL: patch failed: $RESP" >&2
  exit 1
fi

log "waiting for worker rollout (max 90s)"
deadline=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  status_json=$(k_get "/apis/apps/v1/namespaces/$EKS_NAMESPACE/deployments/$WORKER_DEPLOYMENT/status")
  ready=$(echo "$status_json" | jq -r '.status.readyReplicas // 0')
  updated=$(echo "$status_json" | jq -r '.status.updatedReplicas // 0')
  desired=$(echo "$status_json" | jq -r '.spec.replicas // 1')
  if [ "$ready" -ge "$desired" ] && [ "$updated" -ge "$desired" ]; then
    ok "rollout complete: $ready/$desired ready, $updated updated"
    exit 0
  fi
  sleep 3
done
echo "WARN: rollout did not complete within 90s; check k_get /apis/apps/v1/...$WORKER_DEPLOYMENT" >&2
exit 1
