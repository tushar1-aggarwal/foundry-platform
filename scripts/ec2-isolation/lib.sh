#!/usr/bin/env bash
# Shared helpers for scripts/ec2-isolation/*.sh
#
# Source this file: `source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"`

set -uo pipefail

# ── config ──────────────────────────────────────────────────────────────────
: "${AWS_PROFILE:=pai-risk-mlops}"
: "${AWS_REGION:=ap-south-1}"
: "${EKS_CLUSTER:=pai-risk-mlops-platform}"
: "${EKS_NAMESPACE:=ark}"

# EC2 we attach to (reuse existing rather than provision)
: "${EC2_INSTANCE_ID:=i-08b0a5598afefe5a5}"
: "${EC2_COMPUTE_NAME:=test-ec2}"

# Docs-flow session knobs
: "${SESSION_FLOW:=docs}"
: "${SESSION_SUMMARY:=Add one paragraph to architecture.md (EC2 isolation A/B)}"
: "${SESSION_REPO:=https://bitbucket.org/paytmteam/foundry-test-repo}"
: "${SESSION_BRANCH:=}"  # default: server-picked
: "${SESSION_AGENT:=}"   # default: flow-picked

# Internal
EKS_ENDPOINT=""
EKS_TOKEN=""
EKS_TOKEN_TS=0

# ── EKS API access (curl + bearer) ──────────────────────────────────────────
# Uses the Zscaler-bypass pattern: hit the API via /etc/hosts-pinned ENI IP.
# Returns endpoint URL (with the hashed host).
eks_endpoint() {
  if [ -z "$EKS_ENDPOINT" ]; then
    EKS_ENDPOINT=$(AWS_PROFILE="$AWS_PROFILE" aws eks describe-cluster \
      --name "$EKS_CLUSTER" --region "$AWS_REGION" \
      --query 'cluster.endpoint' --output text 2>/dev/null) || {
        echo "FATAL: aws eks describe-cluster failed for $EKS_CLUSTER" >&2
        return 1
      }
  fi
  echo "$EKS_ENDPOINT"
}

# Cache the bearer token for 10 min (EKS tokens expire ~15 min)
eks_token() {
  local now; now=$(date +%s)
  if [ $((now - EKS_TOKEN_TS)) -gt 600 ] || [ -z "$EKS_TOKEN" ]; then
    EKS_TOKEN=$(AWS_PROFILE="$AWS_PROFILE" aws eks get-token \
      --cluster-name "$EKS_CLUSTER" --region "$AWS_REGION" \
      --output json 2>/dev/null | jq -r '.status.token') || return 1
    EKS_TOKEN_TS=$now
  fi
  echo "$EKS_TOKEN"
}

# Curl helper -- args after the first one are passed to curl as-is.
# Adds bearer + insecure (relying on /etc/hosts ENI pin), 12s default timeout.
k_curl() {
  local ep tok
  ep=$(eks_endpoint) || return 1
  tok=$(eks_token)   || return 1
  curl -sk --max-time "${K_CURL_TIMEOUT:-12}" \
    -H "Authorization: Bearer $tok" \
    "$@" \
    "${ep}$K_CURL_PATH"
}

# Higher-level: GET against a path.  k_get /api/v1/namespaces/ark/pods
k_get() {
  K_CURL_PATH="$1" k_curl
}
k_post_json() {
  K_CURL_PATH="$1" k_curl -H "Content-Type: application/json" -X POST -d "$2"
}
k_delete() {
  K_CURL_PATH="$1" k_curl -X DELETE
}
k_patch_json() {
  K_CURL_PATH="$1" k_curl -H "Content-Type: application/strategic-merge-patch+json" -X PATCH -d "$2"
}

# ── AWS creds verification ──────────────────────────────────────────────────
aws_creds_check() {
  AWS_PROFILE="$AWS_PROFILE" aws sts get-caller-identity >/dev/null 2>&1
}

# ── pretty output ───────────────────────────────────────────────────────────
log()  { echo "[$(date -u +%H:%M:%SZ)] $*" >&2; }
ok()   { echo "  ✓ $*" >&2; }
fail() { echo "  ✗ $*" >&2; }
warn() { echo "  ! $*" >&2; }

# ── pod waiting helpers ─────────────────────────────────────────────────────
# Poll pod phase. Returns 0 on Succeeded, 1 on Failed/Timeout.
wait_pod_phase() {
  local pod="$1" want="${2:-Succeeded}" max_secs="${3:-60}"
  local deadline=$(( $(date +%s) + max_secs ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local phase
    phase=$(k_get "/api/v1/namespaces/$EKS_NAMESPACE/pods/$pod" 2>/dev/null | jq -r '.status.phase // ""')
    case "$phase" in
      "$want") echo "$phase"; return 0 ;;
      Failed)  echo "$phase"; return 1 ;;
    esac
    sleep 2
  done
  echo "Timeout"; return 1
}

pod_logs() {
  local pod="$1"
  K_CURL_PATH="/api/v1/namespaces/$EKS_NAMESPACE/pods/$pod/log" k_curl
}
