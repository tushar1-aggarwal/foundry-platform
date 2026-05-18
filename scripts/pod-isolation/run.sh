#!/bin/bash
# Laptop-side orchestrator for the pod-isolation test.
#
# Builds and POSTs a Kubernetes Job to EKS via curl+bearer (Zscaler blocks
# kubectl). The Job mounts driver.sh + render-prompt.ts + do-pr-stage.ts +
# CONTRACT.md.tmpl from a ConfigMap and runs the docs-flow end-to-end inside
# one pod.
#
# Usage:
#   ./scripts/pod-isolation/run.sh \
#     [--summary TEXT] \
#     [--repo URL] \
#     [--image-tag TAG] \
#     [--no-wait]      # post the Job and exit without polling
#
# Outputs (on success): out/iso-<timestamp>/contract/{plan,implement,pr,CONTRACT.md}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── defaults ────────────────────────────────────────────────────────────────
AWS_PROFILE_DEFAULT=pai-risk-mlops
AWS_REGION_DEFAULT=ap-south-1
EKS_CLUSTER_DEFAULT=pai-risk-mlops-platform
EKS_ENDPOINT_DEFAULT="FE31813B454D7EB0B1F97A842603B163.gr7.ap-south-1.eks.amazonaws.com"
EKS_ENI_IP_DEFAULT="10.72.217.51"  # see memory: feedback_zscaler_eks_bypass
EKS_NAMESPACE_DEFAULT=ark
ARK_IMAGE_DEFAULT="880170353725.dkr.ecr.ap-south-1.amazonaws.com/pai-mlops-platform/ark"
ARK_IMAGE_TAG_DEFAULT="276fbb07-merged"
ARK_SA_DEFAULT=ark
TEST_REPO_DEFAULT="https://bitbucket.org/paytmteam/foundry-test-repo"
TEST_SUMMARY_DEFAULT="Add one paragraph to architecture.md"
TEST_MODEL_DEFAULT="pi-agentic/global.anthropic.claude-haiku-4-5-20251001-v1-0"

# Load .env.iso overrides if present
[ -f "$REPO_ROOT/.env.iso" ] && set -a && source "$REPO_ROOT/.env.iso" && set +a

AWS_PROFILE="${AWS_PROFILE:-$AWS_PROFILE_DEFAULT}"
AWS_REGION="${AWS_REGION:-$AWS_REGION_DEFAULT}"
EKS_CLUSTER="${EKS_CLUSTER:-$EKS_CLUSTER_DEFAULT}"
EKS_ENDPOINT="${EKS_ENDPOINT:-$EKS_ENDPOINT_DEFAULT}"
EKS_ENI_IP="${EKS_ENI_IP:-$EKS_ENI_IP_DEFAULT}"
EKS_NAMESPACE="${EKS_NAMESPACE:-$EKS_NAMESPACE_DEFAULT}"
ARK_IMAGE="${ARK_IMAGE:-$ARK_IMAGE_DEFAULT}"
ARK_IMAGE_TAG="${ARK_IMAGE_TAG:-$ARK_IMAGE_TAG_DEFAULT}"
ARK_SA="${ARK_SERVICE_ACCOUNT:-$ARK_SA_DEFAULT}"
REPO="${TEST_REPO:-$TEST_REPO_DEFAULT}"
SUMMARY="${TEST_SUMMARY:-$TEST_SUMMARY_DEFAULT}"
MODEL="${TEST_MODEL:-$TEST_MODEL_DEFAULT}"
WAIT_FOR_JOB=1

# ── arg parse ──────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --summary)   SUMMARY="$2"; shift 2 ;;
    --repo)      REPO="$2"; shift 2 ;;
    --image-tag) ARK_IMAGE_TAG="$2"; shift 2 ;;
    --no-wait)   WAIT_FOR_JOB=0; shift ;;
    -h|--help)   sed -n '2,15p' "$0"; exit 0 ;;
    *)           echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

TS=$(date -u +%Y%m%dt%H%M%S)
SESSION_ID="iso-${TS}"
BRANCH="feat/${SESSION_ID}"
JOB_NAME="iso-driver-${TS}"
CM_NAME="iso-scripts-${TS}"
OUT_DIR="$REPO_ROOT/out/${SESSION_ID}"
mkdir -p "$OUT_DIR/contract"

echo "==> session_id=$SESSION_ID branch=$BRANCH job=$JOB_NAME"

# ── cluster auth (curl+bearer; kubectl hangs through Zscaler) ──────────────
TOKEN=$(aws --profile "$AWS_PROFILE" eks get-token --cluster-name "$EKS_CLUSTER" \
        --region "$AWS_REGION" --query 'status.token' --output text)
API="https://${EKS_ENDPOINT}"
RESOLVE="${EKS_ENDPOINT}:443:${EKS_ENI_IP}"

k_curl() {
  curl -sk --resolve "$RESOLVE" -H "Authorization: Bearer ${TOKEN}" "$@"
}

# ── secrets from SSM (inline-set into Job env to avoid chart-dep) ──────────
ssm_get() {
  aws --profile "$AWS_PROFILE" --region "$AWS_REGION" ssm get-parameter \
    --name "$1" --with-decryption --query 'Parameter.Value' --output text
}
echo "==> reading SSM secrets"
BB_TOKEN=$(ssm_get /ark/default/BITBUCKET_TOKEN)
BB_USER=$(ssm_get /ark/default/BITBUCKET_USERNAME)
ANTH_KEY=$(ssm_get /ark/default/ANTHROPIC_API_KEY)
ANTH_BASE=$(ssm_get /ark/default/ANTHROPIC_BASE_URL)
ANTH_HDR=$(ssm_get /ark/default/ANTHROPIC_CUSTOM_HEADERS)

# ── build ConfigMap with all 3 script files ─────────────────────────────────
echo "==> building ConfigMap $CM_NAME"
CM_JSON=$(python3 -c "
import json, sys
cm = {
  'apiVersion': 'v1', 'kind': 'ConfigMap',
  'metadata': {'name': '$CM_NAME', 'namespace': '$EKS_NAMESPACE'},
  'data': {
    'driver.sh':         open('$SCRIPT_DIR/driver.sh').read(),
    'render-prompt.ts':  open('$SCRIPT_DIR/render-prompt.ts').read(),
    'do-pr-stage.ts':    open('$SCRIPT_DIR/do-pr-stage.ts').read(),
    'CONTRACT.md.tmpl':  open('$SCRIPT_DIR/fixtures/expected/CONTRACT.md.tmpl').read(),
  }
}
print(json.dumps(cm))
")

k_curl -X DELETE "$API/api/v1/namespaces/$EKS_NAMESPACE/configmaps/$CM_NAME" >/dev/null 2>&1 || true
k_curl -H "Content-Type: application/json" \
  -X POST "$API/api/v1/namespaces/$EKS_NAMESPACE/configmaps" \
  -d "$CM_JSON" | jq -r '"  cm=" + (.metadata.name // "(error)")'

# ── build Job spec ──────────────────────────────────────────────────────────
# Secrets are passed via env-of-env to python so shell quoting can't mangle them.
echo "==> building Job $JOB_NAME"
JOB_JSON=$(JSON_REPO="$REPO" JSON_SUMMARY="$SUMMARY" JSON_MODEL="$MODEL" \
           JSON_BB_TOKEN="$BB_TOKEN" JSON_BB_USER="$BB_USER" \
           JSON_ANTH_KEY="$ANTH_KEY" JSON_ANTH_BASE="$ANTH_BASE" JSON_ANTH_HDR="$ANTH_HDR" \
  python3 - <<PY
import json, os
job = {
  'apiVersion': 'batch/v1', 'kind': 'Job',
  'metadata': {'name': '$JOB_NAME', 'namespace': '$EKS_NAMESPACE'},
  'spec': {
    'ttlSecondsAfterFinished': 3600,
    'backoffLimit': 0,
    'activeDeadlineSeconds': 900,
    'template': {
      'metadata': {'labels': {'app': 'pod-isolation', 'session-id': '$SESSION_ID'}},
      'spec': {
        'restartPolicy': 'Never',
        'serviceAccountName': '$ARK_SA',
        'containers': [{
          'name': 'driver',
          'image': '$ARK_IMAGE:$ARK_IMAGE_TAG',
          'command': ['/bin/bash', '/opt/iso/driver.sh'],
          'volumeMounts': [{'name': 'iso', 'mountPath': '/opt/iso'}],
          'env': [
            {'name': 'ARK_IMAGE_TAG',   'value': '$ARK_IMAGE_TAG'},
            {'name': 'ISO_SESSION_ID',  'value': '$SESSION_ID'},
            {'name': 'ISO_BRANCH',      'value': '$BRANCH'},
            {'name': 'ISO_REPO',        'value': os.environ['JSON_REPO']},
            {'name': 'ISO_SUMMARY',     'value': os.environ['JSON_SUMMARY']},
            {'name': 'ISO_TICKET',      'value': ''},
            {'name': 'ISO_MODEL',       'value': os.environ['JSON_MODEL']},
            {'name': 'BITBUCKET_TOKEN',         'value': os.environ['JSON_BB_TOKEN']},
            {'name': 'BITBUCKET_USERNAME',      'value': os.environ['JSON_BB_USER']},
            {'name': 'ANTHROPIC_API_KEY',       'value': os.environ['JSON_ANTH_KEY']},
            {'name': 'ANTHROPIC_BASE_URL',      'value': os.environ['JSON_ANTH_BASE']},
            {'name': 'ANTHROPIC_CUSTOM_HEADERS','value': os.environ['JSON_ANTH_HDR']},
            {'name': 'IS_SANDBOX',      'value': '1'},
            {'name': 'HOME',            'value': '/root'},
          ],
        }],
        'volumes': [{
          'name': 'iso',
          'configMap': {
            'name': '$CM_NAME',
            'defaultMode': 0o755,
            'items': [
              {'key': 'driver.sh', 'path': 'driver.sh', 'mode': 0o755},
              {'key': 'render-prompt.ts', 'path': 'render-prompt.ts'},
              {'key': 'do-pr-stage.ts', 'path': 'do-pr-stage.ts'},
              {'key': 'CONTRACT.md.tmpl', 'path': 'CONTRACT.md.tmpl'},
            ]
          }
        }]
      }
    }
  }
}
print(json.dumps(job))
PY
)

# ── POST Job ────────────────────────────────────────────────────────────────
k_curl -X DELETE "$API/apis/batch/v1/namespaces/$EKS_NAMESPACE/jobs/$JOB_NAME?propagationPolicy=Background" >/dev/null 2>&1 || true
sleep 2
POST_RESP=$(k_curl -H "Content-Type: application/json" \
  -X POST "$API/apis/batch/v1/namespaces/$EKS_NAMESPACE/jobs" -d "$JOB_JSON")
echo "==> Job posted:"
echo "$POST_RESP" | jq '{name: .metadata.name, code, message}'

[ "$WAIT_FOR_JOB" -eq 0 ] && { echo "==> --no-wait set; exiting"; exit 0; }

# ── poll until pod terminal ────────────────────────────────────────────────
echo "==> waiting for pod (timeout 12 min)"
POD=""
DEADLINE=$(($(date +%s) + 720))
LAST=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  POD=$(k_curl "$API/api/v1/namespaces/$EKS_NAMESPACE/pods?labelSelector=job-name=$JOB_NAME" \
        | jq -r '.items[0].metadata.name // ""')
  if [ -n "$POD" ] && [ "$POD" != "null" ]; then
    PHASE=$(k_curl "$API/api/v1/namespaces/$EKS_NAMESPACE/pods/$POD" | jq -r '.status.phase // ""')
    if [ "$PHASE" != "$LAST" ]; then
      echo "  pod=$POD phase=$PHASE"
      LAST="$PHASE"
    fi
    case "$PHASE" in
      Succeeded|Failed) break ;;
    esac
  fi
  sleep 6
done

[ -z "$POD" ] || [ "$POD" = "null" ] && { echo "no pod"; exit 1; }
FINAL_PHASE=$(k_curl "$API/api/v1/namespaces/$EKS_NAMESPACE/pods/$POD" | jq -r '.status.phase')
echo "==> final pod phase: $FINAL_PHASE"

# ── pull log + parse contract artifacts out of it ──────────────────────────
echo "==> retrieving pod log"
LOG_FILE="$OUT_DIR/pod.log"
k_curl "$API/api/v1/namespaces/$EKS_NAMESPACE/pods/$POD/log" > "$LOG_FILE"

# The driver prints `===== outputs.json [<stage>] =====` headers before each
# JSON blob and `===== inputs.json [<stage>] =====` similarly. Slice them out.
extract_section() {
  local marker="$1" outfile="$2"
  awk -v m="$marker" '
    $0 == m { capture=1; next }
    /^===== / { capture=0 }
    capture { print }
  ' "$LOG_FILE" > "$outfile"
}

mkdir -p "$OUT_DIR/contract/plan" "$OUT_DIR/contract/implement" "$OUT_DIR/contract/pr"
for stage in plan implement pr; do
  extract_section "===== outputs.json [$stage] =====" "$OUT_DIR/contract/$stage/outputs.json"
  [ "$stage" != "pr" ] && extract_section "===== inputs.json [$stage] =====" "$OUT_DIR/contract/$stage/inputs.json"
done
# CONTRACT.md is the section after `===== CONTRACT.md =====` until the next marker
awk '
  $0 == "===== CONTRACT.md =====" { capture=1; next }
  /^===== / { capture=0 }
  capture { print }
' "$LOG_FILE" > "$OUT_DIR/contract/CONTRACT.md"

echo
echo "===== STAGE SUMMARY ====="
for stage in plan implement pr; do
  if [ -s "$OUT_DIR/contract/$stage/outputs.json" ]; then
    line=$(jq -c "{stage:\"$stage\", exit:.exit_code, terminal:(.terminal_reason//\"-\"), commits:(.commit_count//\"-\"), pr_url:(.pr_url//\"-\")}" \
                "$OUT_DIR/contract/$stage/outputs.json" 2>/dev/null || echo "{stage:\"$stage\", error:\"parse-fail\"}")
    echo "  $line"
  else
    echo "  {stage:\"$stage\", error:\"missing\"}"
  fi
done

echo
echo "==> artifacts in: $OUT_DIR/"
ls -1 "$OUT_DIR/contract/"

if [ "$FINAL_PHASE" = "Succeeded" ]; then
  echo "==> success"; exit 0
else
  echo "==> failed (pod phase: $FINAL_PHASE)"; exit 1
fi
