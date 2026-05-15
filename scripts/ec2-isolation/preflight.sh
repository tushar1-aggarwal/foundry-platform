#!/usr/bin/env bash
# Preflight checks for an EC2-target session against the DEPLOYED CP.
#
# Verifies, in order:
#   1. AWS SSO creds are fresh (`aws sts get-caller-identity`)
#   2. The target EC2 instance is `running`
#   3. The EC2 instance is SSM-registered (so port-forward works)
#   4. EKS API reachable via curl+bearer (DNS hijack fix in place)
#   5. ark-worker container has `session-manager-plugin` on PATH
#      (BLOCKER: without it, EC2Compute.setupTransport spawn fails)
#   6. (info) Whether an EC2 compute row already exists in the deployed RDS
#
# Exit 0 if all hard checks pass.  Exit 1 on any failure; the failing
# step's remediation is printed.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

FAILS=0

log "1. AWS creds (profile=$AWS_PROFILE)"
if aws_creds_check; then
  ok "creds valid"
else
  fail "AWS creds expired or missing"
  echo "    fix: ! aws sso login --profile $AWS_PROFILE"
  FAILS=$((FAILS+1))
fi

log "2. EC2 instance state ($EC2_INSTANCE_ID, region=$AWS_REGION)"
INSTANCE_JSON=$(AWS_PROFILE="$AWS_PROFILE" aws ec2 describe-instances \
  --region "$AWS_REGION" --instance-ids "$EC2_INSTANCE_ID" \
  --query 'Reservations[].Instances[0]' --output json 2>&1)
if [ "$?" -eq 0 ] && [ "$INSTANCE_JSON" != "null" ]; then
  state=$(echo "$INSTANCE_JSON" | jq -r '.State.Name')
  ip=$(echo "$INSTANCE_JSON" | jq -r '.PrivateIpAddress // ""')
  case "$state" in
    running) ok "running (private ip=$ip)" ;;
    stopped)
      fail "instance stopped"
      echo "    fix: aws ec2 start-instances --instance-ids $EC2_INSTANCE_ID --region $AWS_REGION --profile $AWS_PROFILE"
      FAILS=$((FAILS+1))
      ;;
    *) fail "state=$state (not usable)"; FAILS=$((FAILS+1)) ;;
  esac
else
  fail "describe-instances failed: $INSTANCE_JSON"
  FAILS=$((FAILS+1))
fi

log "3. SSM registration"
SSM_JSON=$(AWS_PROFILE="$AWS_PROFILE" aws ssm describe-instance-information \
  --region "$AWS_REGION" \
  --filters "Key=InstanceIds,Values=$EC2_INSTANCE_ID" \
  --query 'InstanceInformationList[0]' --output json 2>&1)
if [ "$SSM_JSON" != "null" ] && [ -n "$SSM_JSON" ]; then
  ping=$(echo "$SSM_JSON" | jq -r '.PingStatus // "unknown"')
  if [ "$ping" = "Online" ]; then
    ok "SSM ping=Online"
  else
    fail "SSM ping=$ping (transport unreliable)"
    FAILS=$((FAILS+1))
  fi
else
  fail "instance not in SSM inventory -- missing AmazonSSMManagedInstanceCore role?"
  FAILS=$((FAILS+1))
fi

log "4. EKS API reachable"
ENDPOINT=$(eks_endpoint 2>&1)
if [ "$?" -eq 0 ] && [ -n "$ENDPOINT" ]; then
  HTTP=$(K_CURL_TIMEOUT=8 k_get /api/v1/namespaces \
    -o /dev/null -w "%{http_code}" 2>&1 | tail -1)
  if [ "$HTTP" = "200" ]; then
    ok "$ENDPOINT (HTTP 200)"
  else
    fail "EKS API HTTP=$HTTP"
    echo "    fix: refresh ENI in /etc/hosts -- see eks-vpn-dns-hijack-fix skill"
    FAILS=$((FAILS+1))
  fi
else
  fail "could not resolve EKS endpoint"
  FAILS=$((FAILS+1))
fi

log "5. ark-worker has session-manager-plugin"
WORKER=$(k_get "/api/v1/namespaces/$EKS_NAMESPACE/pods?labelSelector=app=ark-worker" 2>/dev/null \
  | jq -r '.items[0].metadata.name // ""')
if [ -z "$WORKER" ]; then
  fail "no ark-worker pod found"
  FAILS=$((FAILS+1))
else
  # Use a sidecar Job to which-test the binary; spawning exec via curl is messy.
  PROBE="ark-smp-probe-$(date +%s)"
  PROBE_JSON=$(jq -nc --arg name "$PROBE" --arg ns "$EKS_NAMESPACE" --arg img "880170353725.dkr.ecr.ap-south-1.amazonaws.com/pai-mlops-platform/ark:276fbb07-merged" '{
    apiVersion:"v1",kind:"Pod",
    metadata:{name:$name,namespace:$ns},
    spec:{
      restartPolicy:"Never",
      containers:[{name:"probe",image:$img,
        command:["sh","-c","which session-manager-plugin || echo MISSING"]}]
    }
  }')
  k_post_json "/api/v1/namespaces/$EKS_NAMESPACE/pods" "$PROBE_JSON" >/dev/null
  wait_pod_phase "$PROBE" Succeeded 30 >/dev/null
  RESULT=$(pod_logs "$PROBE" 2>/dev/null | tr -d '\n')
  k_delete "/api/v1/namespaces/$EKS_NAMESPACE/pods/$PROBE" >/dev/null 2>&1 &
  if echo "$RESULT" | grep -q "MISSING"; then
    fail "session-manager-plugin MISSING in ark image -- EC2Compute cannot port-forward"
    echo "    fix: install via cloud-init OR add to Dockerfile; OR use a sidecar with the plugin"
    FAILS=$((FAILS+1))
  elif [ -n "$RESULT" ]; then
    ok "session-manager-plugin at $RESULT"
  else
    fail "probe returned empty output"
    FAILS=$((FAILS+1))
  fi
fi

log "6. existing EC2 compute row in deployed RDS"
PROBE="ark-ec2-row-probe-$(date +%s)"
PROBE_JSON=$(jq -nc --arg name "$PROBE" --arg ns "$EKS_NAMESPACE" '{
  apiVersion:"v1",kind:"Pod",
  metadata:{name:$name,namespace:$ns},
  spec:{
    restartPolicy:"Never",
    containers:[{
      name:"psql",image:"postgres:16-alpine",
      command:["sh","-c","psql -At -c \"SELECT count(*) FROM compute WHERE compute_kind='\''ec2'\''\""],
      env:[
        {name:"PGSSLMODE",value:"require"},
        {name:"PGHOST",value:"foundry.chy2qgkm0yi2.ap-south-1.rds.amazonaws.com"},
        {name:"PGPORT",value:"5432"},
        {name:"PGDATABASE",value:"ark"},
        {name:"PGUSER",valueFrom:{secretKeyRef:{name:"ark-secrets",key:"DB_USERNAME"}}},
        {name:"PGPASSWORD",valueFrom:{secretKeyRef:{name:"ark-secrets",key:"DB_PASSWORD"}}}
      ]
    }]
  }
}')
k_post_json "/api/v1/namespaces/$EKS_NAMESPACE/pods" "$PROBE_JSON" >/dev/null
wait_pod_phase "$PROBE" Succeeded 30 >/dev/null
COUNT=$(pod_logs "$PROBE" 2>/dev/null | tr -d '\n')
k_delete "/api/v1/namespaces/$EKS_NAMESPACE/pods/$PROBE" >/dev/null 2>&1 &
if [ "$COUNT" = "0" ]; then
  warn "no EC2 compute rows -- run register-compute.sh"
elif [ -n "$COUNT" ]; then
  ok "$COUNT EC2 row(s) already registered"
else
  warn "probe returned empty"
fi

echo
if [ "$FAILS" -eq 0 ]; then
  log "PREFLIGHT OK -- ready to register-compute + patch-worker-creds + dispatch-session"
  exit 0
else
  log "PREFLIGHT FAILED ($FAILS issues) -- fix the marked items above"
  exit 1
fi
