# EC2 Compute in Deployed Prod CP — Implementation Plan (IRSA edition)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock the EC2-compute path in the deployed `pai-risk-mlops-platform` EKS control-plane so a docs-flow session with `compute_name=test-ec2` runs end-to-end. The probe doubles as an A/B against the current K8s-per-session-pod docs-flow hang.

**Architecture:** The deployed CP runs three ark Deployments (`ark-control-plane`, `ark-worker`, `temporal-worker`), all using `ServiceAccount ark` which IRSA-binds to IAM role `arn:aws:iam::880170353725:role/platform-ark`. Temporal activities run in `temporal-worker`. `EC2Compute.setupTransport` shells out to `aws ssm start-session …` which needs (1) `aws cli` + `session-manager-plugin` on PATH and (2) `ssm:StartSession` etc. on the IRSA role. Neither is present today. We add both, register the EC2 row, dispatch one probe session.

**Tech Stack:** AWS EKS (deployed CP), AWS EC2 + SSM Session Manager, AWS CLI v2 + session-manager-plugin, Docker / ECR (account 880170353725 / region ap-south-1), Postgres RDS (deployed), TypeScript / Bun.

**Audit results that shaped this plan (`2026-05-13`):**
- ✅ `eks.amazonaws.com/role-arn` annotation on `ark` SA → `platform-ark` (IRSA wired)
- ✅ All 3 deployments use SA `ark`
- ✅ NAT egress to `ssm.ap-south-1.amazonaws.com` works (AWS returns `AccessDeniedException`, not network error)
- ❌ Both ark images lack `aws cli` and `session-manager-plugin`
- ❌ `platform-ark` policy has S3 + Parameter-Store + KMS only — no EC2 / no SSM Session-Manager
- ❌ No VPC endpoints for ssm/ssmmessages/ec2messages — NAT path is current path (works, but Zscaler MITM risk noted as follow-up)

---

## File Structure

| File | Purpose | Status |
|---|---|---|
| `.infra/Dockerfile.temporal-worker` | Build the temporal-worker image | **MODIFY** — add aws cli v2 + session-manager-plugin install |
| `scripts/ec2-isolation/build-push-temporal-worker.sh` | Build + push the new temporal-worker image to ECR | **CREATE** |
| `scripts/ec2-isolation/expand-iam-policy.sh` | Add EC2 + SSM statements to `platform-ark` policy via `iam create-policy-version` | **CREATE** |
| `scripts/ec2-isolation/bump-worker-image.sh` | Patch `temporal-worker` Deployment to a new image tag, wait for rollout | **CREATE** |
| `scripts/ec2-isolation/probe-irsa-ssm.sh` | One-shot Pod: verify `aws cli` + `session-manager-plugin` on PATH AND `aws sts get-caller-identity` AND `aws ssm describe-instance-information` against `test-ec2` | **CREATE** |
| `scripts/ec2-isolation/verify-session.sh` | Tail a session's status + last 10 events from deployed RDS | **CREATE** |
| `scripts/ec2-isolation/register-compute.sh` | Insert EC2 compute row | use as-is (commit `4bd6551a`) |
| `scripts/ec2-isolation/dispatch-session.sh` | Send `session/start` WS to the CP | use as-is |
| `scripts/ec2-isolation/lib.sh` | Shared helpers | use as-is |
| `scripts/ec2-isolation/patch-worker-creds.sh` | (obsolete in this plan — IRSA replaces env-var injection) | **DELETE** at end of plan |

---

## Task 1: Add aws cli v2 + session-manager-plugin to temporal-worker Dockerfile

**Files:**
- Modify: `.infra/Dockerfile.temporal-worker:17-21`

- [ ] **Step 1: Show the current install block**

Run:
```bash
sed -n '17,21p' .infra/Dockerfile.temporal-worker
```
Expected output:
```
RUN apt-get update && apt-get install -y --no-install-recommends \
        nodejs npm curl git tmux procps \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx
```

- [ ] **Step 2: Edit the Dockerfile to install aws + smp**

Replace lines 17-21 with this exact block:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
        nodejs npm curl git tmux procps unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx

# AWS CLI v2 + session-manager-plugin. Required by EC2Compute.setupTransport:
# packages/core/compute/ec2/ssm.ts:24-30 documents these as hard prereqs.
# amd64 only -- arm64 builds need a $(uname -m) switch.
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip \
  && unzip -q /tmp/awscli.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/awscli.zip /tmp/aws \
  && curl -fsSL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" \
       -o /tmp/smp.deb \
  && dpkg -i /tmp/smp.deb \
  && rm /tmp/smp.deb
```

- [ ] **Step 3: Verify the binaries land inside the image**

Run:
```bash
docker build -f .infra/Dockerfile.temporal-worker -t ark-temporal-worker:probe-aws . 2>&1 | tail -5
docker run --rm ark-temporal-worker:probe-aws sh -c 'which aws session-manager-plugin && aws --version && session-manager-plugin --version'
```
Expected output (versions may differ):
```
/usr/local/bin/aws
/usr/local/bin/session-manager-plugin
aws-cli/2.x.x Python/3.x.x Linux/...
SessionManagerPlugin version 1.2.x.x
```

- [ ] **Step 4: Commit**

```bash
git add .infra/Dockerfile.temporal-worker
git commit -m "feature: install aws cli + session-manager-plugin in temporal-worker image for EC2Compute"
```

---

## Task 2: Build + push the temporal-worker image to ECR

**Files:**
- Create: `scripts/ec2-isolation/build-push-temporal-worker.sh`

- [ ] **Step 1: Write the script**

Create `scripts/ec2-isolation/build-push-temporal-worker.sh` with these exact contents:

```bash
#!/usr/bin/env bash
# Build .infra/Dockerfile.temporal-worker (now with aws cli + smp) and push
# to ECR. Tag = <short-sha>-ec2 so we don't clobber the prod 276fbb07-merged
# tag while A/B'ing.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../.."

: "${AWS_PROFILE:=pai-risk-mlops}"
: "${AWS_REGION:=ap-south-1}"
: "${ECR_REGISTRY:=880170353725.dkr.ecr.ap-south-1.amazonaws.com}"
: "${ECR_REPO:=pai-mlops-platform/ark-temporal-worker}"

SHORT_SHA=$(git rev-parse --short HEAD)
TAG="${SHORT_SHA}-ec2"
IMAGE="$ECR_REGISTRY/$ECR_REPO:$TAG"

echo "==> building $IMAGE"
docker build -f .infra/Dockerfile.temporal-worker -t "$IMAGE" .

echo "==> ECR login"
AWS_PROFILE="$AWS_PROFILE" aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

echo "==> push $IMAGE"
docker push "$IMAGE"

echo
echo "TAG=$TAG"
```

Then:
```bash
chmod +x scripts/ec2-isolation/build-push-temporal-worker.sh
```

- [ ] **Step 2: Run it**

```bash
./scripts/ec2-isolation/build-push-temporal-worker.sh
```
Expected: ends with `TAG=<short-sha>-ec2`. Record that exact string — used in Task 4.

- [ ] **Step 3: Verify ECR has the tag**

Substitute the recorded tag into `<TAG>`:
```bash
TAG=<TAG-from-step-2>
AWS_PROFILE=pai-risk-mlops aws ecr describe-images \
  --region ap-south-1 \
  --repository-name pai-mlops-platform/ark-temporal-worker \
  --image-ids imageTag="$TAG" \
  --query 'imageDetails[0].{tag:imageTags[0],pushedAt:imagePushedAt,sizeMB:(imageSizeInBytes / `1048576`)}'
```
Expected: an object with `tag` = the new tag and `pushedAt` within the last few minutes.

- [ ] **Step 4: Commit**

```bash
git add scripts/ec2-isolation/build-push-temporal-worker.sh
git commit -m "feature: build-push-temporal-worker.sh ships new image to ECR"
```

---

## Task 3: Expand `platform-ark` IAM policy with EC2 + SSM Session-Manager actions

**Files:**
- Create: `scripts/ec2-isolation/expand-iam-policy.sh`
- Side effect: creates a new policy version on `arn:aws:iam::880170353725:policy/platform-ark` and sets it as default. **Direct AWS-side change** — if this role is managed by Terraform/IaC, this creates drift. Document the drift in Task 7 follow-ups.

- [ ] **Step 1: Write the script**

Create `scripts/ec2-isolation/expand-iam-policy.sh`:

```bash
#!/usr/bin/env bash
# Expand platform-ark IAM policy to allow:
#   - ec2:DescribeInstances, ec2:DescribeNetworkInterfaces (attach to existing)
#   - ec2:StartInstances, ec2:StopInstances (warm-pool / idle resume)
#   - ssm:StartSession (open SSM port-forward)
#   - ssm:TerminateSession (cleanup)
#   - ssm:DescribeInstanceInformation (verify SSM agent online)
#   - ssm:DescribeSessions (reuse logic in EC2Compute.setupTransport)
#
# Uses `aws iam create-policy-version --set-as-default`. AWS-managed policies
# keep up to 5 versions; we prune the oldest non-default if at the limit.
#
# Idempotent: if the policy already includes every action we want, exits 0
# without creating a new version.

set -euo pipefail

: "${AWS_PROFILE:=pai-risk-mlops}"
POLICY_ARN="arn:aws:iam::880170353725:policy/platform-ark"

# Required actions, sorted for stable diffs.
REQ_EC2=(
  ec2:DescribeInstances
  ec2:DescribeNetworkInterfaces
  ec2:StartInstances
  ec2:StopInstances
)
REQ_SSM=(
  ssm:DescribeInstanceInformation
  ssm:DescribeSessions
  ssm:StartSession
  ssm:TerminateSession
)

echo "==> reading current default policy version"
VER=$(AWS_PROFILE="$AWS_PROFILE" aws iam get-policy --policy-arn "$POLICY_ARN" --query 'Policy.DefaultVersionId' --output text)
DOC=$(AWS_PROFILE="$AWS_PROFILE" aws iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$VER" \
  --query 'PolicyVersion.Document' --output json)
echo "    current default = $VER"

# Idempotency check: does the doc already contain every required action?
NEEDED=()
for a in "${REQ_EC2[@]}" "${REQ_SSM[@]}"; do
  if ! echo "$DOC" | jq -e --arg a "$a" '[.Statement[].Action] | flatten | index($a)' >/dev/null; then
    NEEDED+=("$a")
  fi
done
if [ "${#NEEDED[@]}" -eq 0 ]; then
  echo "==> policy already grants every required action. nothing to do."
  exit 0
fi
echo "==> missing actions: ${NEEDED[*]}"

# Build new document = existing statements + 2 new sids.
NEW_DOC=$(echo "$DOC" | jq '
  .Statement += [
    {
      Sid: "Ec2InstancesForEC2Compute",
      Effect: "Allow",
      Action: ["ec2:DescribeInstances","ec2:DescribeNetworkInterfaces","ec2:StartInstances","ec2:StopInstances"],
      Resource: "*"
    },
    {
      Sid: "SsmSessionManagerForEC2Compute",
      Effect: "Allow",
      Action: ["ssm:DescribeInstanceInformation","ssm:DescribeSessions","ssm:StartSession","ssm:TerminateSession"],
      Resource: "*"
    }
  ]
')

# Prune oldest non-default version if we are at the 5-version limit.
COUNT=$(AWS_PROFILE="$AWS_PROFILE" aws iam list-policy-versions --policy-arn "$POLICY_ARN" \
  --query 'length(Versions)' --output text)
if [ "$COUNT" -ge 5 ]; then
  OLDEST_NONDEFAULT=$(AWS_PROFILE="$AWS_PROFILE" aws iam list-policy-versions --policy-arn "$POLICY_ARN" \
    --query 'sort_by(Versions[?IsDefaultVersion==`false`], &CreateDate)[0].VersionId' --output text)
  echo "==> at 5-version limit; deleting oldest non-default = $OLDEST_NONDEFAULT"
  AWS_PROFILE="$AWS_PROFILE" aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLDEST_NONDEFAULT"
fi

echo "==> creating new policy version + setting as default"
AWS_PROFILE="$AWS_PROFILE" aws iam create-policy-version \
  --policy-arn "$POLICY_ARN" \
  --policy-document "$NEW_DOC" \
  --set-as-default \
  --query 'PolicyVersion.{version:VersionId,isDefault:IsDefaultVersion,created:CreateDate}'
```

Then:
```bash
chmod +x scripts/ec2-isolation/expand-iam-policy.sh
```

- [ ] **Step 2: Dry-run check the new policy document before applying**

Run a dry preview (no AWS mutation):
```bash
AWS_PROFILE=pai-risk-mlops aws iam get-policy-version \
  --policy-arn arn:aws:iam::880170353725:policy/platform-ark \
  --version-id $(AWS_PROFILE=pai-risk-mlops aws iam get-policy --policy-arn arn:aws:iam::880170353725:policy/platform-ark --query 'Policy.DefaultVersionId' --output text) \
  --query 'PolicyVersion.Document.Statement[].Sid'
```
Expected (BEFORE):
```
[
    "S3ListBucket",
    "S3ReadWriteArkPrefix",
    "SsmArkSecrets",
    "KmsForSsm"
]
```

- [ ] **Step 3: Apply**

```bash
./scripts/ec2-isolation/expand-iam-policy.sh
```
Expected output (last line): a JSON object showing the new VersionId.

- [ ] **Step 4: Re-check the policy includes the new SIDs**

```bash
AWS_PROFILE=pai-risk-mlops aws iam get-policy-version \
  --policy-arn arn:aws:iam::880170353725:policy/platform-ark \
  --version-id $(AWS_PROFILE=pai-risk-mlops aws iam get-policy --policy-arn arn:aws:iam::880170353725:policy/platform-ark --query 'Policy.DefaultVersionId' --output text) \
  --query 'PolicyVersion.Document.Statement[].Sid'
```
Expected (AFTER):
```
[
    "S3ListBucket",
    "S3ReadWriteArkPrefix",
    "SsmArkSecrets",
    "KmsForSsm",
    "Ec2InstancesForEC2Compute",
    "SsmSessionManagerForEC2Compute"
]
```

- [ ] **Step 5: Commit**

```bash
git add scripts/ec2-isolation/expand-iam-policy.sh
git commit -m "feature: expand-iam-policy.sh adds EC2+SSM actions to platform-ark"
```

---

## Task 4: Roll temporal-worker to the new image + verify IRSA + binaries together

**Files:**
- Create: `scripts/ec2-isolation/bump-worker-image.sh`
- Create: `scripts/ec2-isolation/probe-irsa-ssm.sh`

- [ ] **Step 1: Write `bump-worker-image.sh`**

Create the file:

```bash
#!/usr/bin/env bash
# Patch the deployed temporal-worker Deployment to a new image tag (the one
# Task 2 just pushed). In-place patch via curl+bearer to the EKS API; does
# not touch pi-risk-mlops Helm values -- that PR is a follow-up after the
# A/B is conclusive.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

: "${IMAGE_TAG:?Need IMAGE_TAG=<sha>-ec2 from build-push-temporal-worker.sh}"
IMAGE="880170353725.dkr.ecr.ap-south-1.amazonaws.com/pai-mlops-platform/ark-temporal-worker:$IMAGE_TAG"

log "patching temporal-worker → $IMAGE"
PATCH=$(jq -nc --arg img "$IMAGE" '{
  spec: {
    template: {
      metadata: { annotations: { "ec2-isolation-image-bumped-at": (now | todate) } },
      spec: { containers: [ { name: "temporal-worker", image: $img } ] }
    }
  }
}')
RESP=$(k_patch_json "/apis/apps/v1/namespaces/$EKS_NAMESPACE/deployments/temporal-worker" "$PATCH")
echo "$RESP" | jq -e '.kind == "Deployment"' >/dev/null || { echo "patch failed: $RESP"; exit 1; }
ok "patched"

log "waiting for rollout (max 120s)"
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  s=$(k_get "/apis/apps/v1/namespaces/$EKS_NAMESPACE/deployments/temporal-worker/status")
  ready=$(echo "$s" | jq -r '.status.readyReplicas // 0')
  updated=$(echo "$s" | jq -r '.status.updatedReplicas // 0')
  desired=$(echo "$s" | jq -r '.spec.replicas // 1')
  if [ "$ready" -ge "$desired" ] && [ "$updated" -ge "$desired" ]; then
    ok "rolled: $ready/$desired ready, $updated updated"
    exit 0
  fi
  sleep 3
done
echo "WARN: rollout did not complete within 120s" >&2
exit 1
```

```bash
chmod +x scripts/ec2-isolation/bump-worker-image.sh
```

- [ ] **Step 2: Write `probe-irsa-ssm.sh`**

This combines three checks the new pod needs to pass before a real session can succeed:
1. `aws` + `session-manager-plugin` on PATH
2. IRSA token is being projected (`aws sts get-caller-identity` returns the `platform-ark` role)
3. EC2/SSM perms work (`aws ssm describe-instance-information --instance-information-filter-list key=InstanceIds,valueSet=<test-ec2>`)

Create the file:

```bash
#!/usr/bin/env bash
# Combined probe: binaries + IRSA + SSM perms.
# Uses the same image, same ServiceAccount as the running temporal-worker --
# so any failure here would also break the real activity.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

CURRENT_IMAGE=$(k_get "/apis/apps/v1/namespaces/$EKS_NAMESPACE/deployments/temporal-worker" \
  | jq -r '.spec.template.spec.containers[0].image')
log "using image=$CURRENT_IMAGE"

POD="ark-irsa-probe-$(date +%s)"
SCRIPT="set -e
echo '--- which ---'
which aws session-manager-plugin
echo '--- aws version ---'
aws --version
echo '--- IRSA: sts caller ---'
aws sts get-caller-identity --output json
echo '--- ec2 DescribeInstances on test-ec2 ---'
aws ec2 describe-instances --region $AWS_REGION --instance-ids $EC2_INSTANCE_ID --query 'Reservations[0].Instances[0].{state:State.Name,ip:PrivateIpAddress}' --output json
echo '--- ssm DescribeInstanceInformation ---'
aws ssm describe-instance-information --region $AWS_REGION --filters 'Key=InstanceIds,Values=$EC2_INSTANCE_ID' --query 'InstanceInformationList[0].{ping:PingStatus,agent:AgentVersion}' --output json
echo '--- DONE ---'
"
POD_JSON=$(jq -nc --arg name "$POD" --arg ns "$EKS_NAMESPACE" --arg img "$CURRENT_IMAGE" --arg s "$SCRIPT" '{
  apiVersion:"v1", kind:"Pod",
  metadata:{name:$name, namespace:$ns},
  spec:{
    restartPolicy:"Never",
    serviceAccountName:"ark",
    containers:[{
      name:"probe", image:$img,
      command:["sh","-c",$s]
    }]
  }
}')
k_post_json "/api/v1/namespaces/$EKS_NAMESPACE/pods" "$POD_JSON" >/dev/null
phase=$(wait_pod_phase "$POD" Succeeded 60)
echo "phase=$phase"
echo "--- logs ---"
pod_logs "$POD"
k_delete "/api/v1/namespaces/$EKS_NAMESPACE/pods/$POD" >/dev/null 2>&1 &
[ "$phase" = "Succeeded" ]
```

```bash
chmod +x scripts/ec2-isolation/probe-irsa-ssm.sh
```

- [ ] **Step 3: Run the bump**

```bash
IMAGE_TAG=<TAG-from-Task-2> ./scripts/ec2-isolation/bump-worker-image.sh
```
Expected: ends with `✓ rolled: 1/1 ready, 1 updated`.

- [ ] **Step 4: Run the probe**

```bash
./scripts/ec2-isolation/probe-irsa-ssm.sh
```
Expected (success — all three checks pass):
```
--- which ---
/usr/local/bin/aws
/usr/local/bin/session-manager-plugin
--- aws version ---
aws-cli/2.x.x ...
--- IRSA: sts caller ---
{
  "UserId": "AROA...:botocore-session-...",
  "Account": "880170353725",
  "Arn": "arn:aws:sts::880170353725:assumed-role/platform-ark/botocore-session-..."
}
--- ec2 DescribeInstances on test-ec2 ---
{ "state": "running", "ip": "172.31.22.79" }
--- ssm DescribeInstanceInformation ---
{ "ping": "Online", "agent": "3.x.x.x" }
--- DONE ---
```

If any sub-check fails:

| Failure | Likely cause | Fix |
|---|---|---|
| `MISSING` after `which` | Image bump didn't take | Re-run Task 4 step 3 and confirm pod uses new tag |
| `sts get-caller-identity` returns node IAM role, not `platform-ark` | SA token not projected | Confirm `serviceAccountName: ark` in pod spec; recreate pod |
| `ec2 DescribeInstances` returns `AccessDeniedException` | Task 3 didn't apply | Re-run Task 3 step 3, then probe again |
| `ssm describe-instance-information` returns empty list | EC2 missing SSM IAM perms | Out of scope — fix the EC2's instance profile separately |

- [ ] **Step 5: Commit**

```bash
git add scripts/ec2-isolation/bump-worker-image.sh scripts/ec2-isolation/probe-irsa-ssm.sh
git commit -m "feature: bump-worker-image.sh + probe-irsa-ssm.sh for in-place rollout + verification"
```

---

## Task 5: Register the EC2 compute row in deployed RDS

**Files:**
- Use as-is: `scripts/ec2-isolation/register-compute.sh` (already on this branch in commit `4bd6551a`)

- [ ] **Step 1: Run it**

```bash
./scripts/ec2-isolation/register-compute.sh
```
Expected output (terminal): `compute row registered (or refreshed)`. The script's psql pod prints the inserted row to confirm.

- [ ] **Step 2: Confirm the row is now present**

```bash
./scripts/ec2-isolation/preflight.sh | grep "EC2 row"
```
Expected:
```
  ✓ 1 EC2 row(s) already registered
```

(No commit needed — script unchanged.)

---

## Task 6: Dispatch a docs-flow session against `compute=test-ec2` and verify

**Files:**
- Use as-is: `scripts/ec2-isolation/dispatch-session.sh`
- Create: `scripts/ec2-isolation/verify-session.sh`

- [ ] **Step 1: Dispatch the session**

```bash
SESSION_SUMMARY="EC2 isolation A/B: add one paragraph to architecture.md" \
SESSION_REPO="https://bitbucket.org/paytmteam/foundry-test-repo" \
EC2_COMPUTE_NAME=test-ec2 \
  ./scripts/ec2-isolation/dispatch-session.sh
```

Expected: the dispatch pod's stdout ends with `=== RESULT ===` followed by a JSON-RPC response containing `result.session_id = "s-..."`. Record that session id.

- [ ] **Step 2: Write `verify-session.sh`**

Create the file:

```bash
#!/usr/bin/env bash
# Watch a session id: poll deployed RDS for status + last 10 events.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

: "${1:?Usage: verify-session.sh <session-id>}"
SID="$1"

SQL="SELECT id, status, stage, compute_name, error FROM sessions WHERE id='$SID';
\\echo --- last 10 events ---
SELECT created_at, type, substr(data::text,1,200) FROM session_events
  WHERE session_id='$SID' ORDER BY created_at DESC LIMIT 10;"

POD="ark-session-watch-$(date +%s)"
POD_JSON=$(jq -nc --arg name "$POD" --arg ns "$EKS_NAMESPACE" --arg sql "$SQL" '{
  apiVersion:"v1", kind:"Pod",
  metadata:{name:$name, namespace:$ns},
  spec:{
    restartPolicy:"Never",
    containers:[{name:"psql", image:"postgres:16-alpine",
      command:["sh","-c", ("psql -c \"" + $sql + "\"")],
      env:[
        {name:"PGSSLMODE",value:"require"},
        {name:"PGHOST",value:"foundry.chy2qgkm0yi2.ap-south-1.rds.amazonaws.com"},
        {name:"PGPORT",value:"5432"},
        {name:"PGDATABASE",value:"ark"},
        {name:"PGUSER",valueFrom:{secretKeyRef:{name:"ark-secrets",key:"DB_USERNAME"}}},
        {name:"PGPASSWORD",valueFrom:{secretKeyRef:{name:"ark-secrets",key:"DB_PASSWORD"}}}
      ]}]
  }
}')
k_post_json "/api/v1/namespaces/$EKS_NAMESPACE/pods" "$POD_JSON" >/dev/null
wait_pod_phase "$POD" Succeeded 30 >/dev/null
pod_logs "$POD"
k_delete "/api/v1/namespaces/$EKS_NAMESPACE/pods/$POD" >/dev/null 2>&1 &
```

```bash
chmod +x scripts/ec2-isolation/verify-session.sh
```

- [ ] **Step 3: Poll the session every 30s for ≤10 min**

```bash
SID=<session-id-from-step-1>
for i in $(seq 1 20); do
  echo "=== poll $i @ $(date -u +%H:%M:%SZ) ==="
  ./scripts/ec2-isolation/verify-session.sh "$SID" | head -30
  status=$(./scripts/ec2-isolation/verify-session.sh "$SID" | grep -oE 'closed|failed|stopped' | head -1)
  [ -n "$status" ] && { echo "TERMINAL: $status"; break; }
  sleep 30
done
```

Expected terminal states + interpretation:

| Final status | Final stage | Verdict |
|---|---|---|
| `closed` | `close` | ✅ EC2 path runs end-to-end. The K8s docs-k8s hang is K8s-pod-spawn-specific. |
| `failed` | non-`setup_workspace`, with a specific error | EC2 path got past clone — failure is elsewhere; record the error. |
| `failed` or `stopped` | `setup_workspace` with `git clone` mentioned in last events | EC2 path ALSO hangs at clone → bug is in arkd or git itself, NOT k8s-specific. |
| Still `running` after 10 min | `setup_workspace` | Hang confirmed; same conclusion as above. |

- [ ] **Step 4: Also pull the temporal-worker pod log for corroboration**

```bash
source ./scripts/ec2-isolation/lib.sh
POD=$(k_get "/api/v1/namespaces/ark/pods?labelSelector=app.kubernetes.io/name=temporal-worker" \
  | jq -r '.items[] | select(.status.phase=="Running") | .metadata.name' | head -1)
K_CURL_PATH="/api/v1/namespaces/ark/pods/$POD/log?sinceSeconds=600" k_curl | tail -80
```

Expected log lines on success:
```
EC2Compute.attachExistingHandle ... instance=i-08b0a5598afefe5a5
EC2Compute.setupTransport ... start-session pid=...
ensureReachable ... GET /health 200
runGit ["clone","https://x-bitbucket-api-token-auth:***@bitbucket.org/...",...] exitCode=0
/process/spawn handle=plan-<sid> cmd=bun
```

- [ ] **Step 5: Commit verify-session.sh**

```bash
git add scripts/ec2-isolation/verify-session.sh
git commit -m "feature: verify-session.sh polls deployed RDS for session status + events"
```

---

## Task 7: Document the A/B verdict + cleanup

**Files:**
- Create: `docs/superpowers/specs/2026-05-13-ec2-vs-k8s-ab-result.md`
- Delete: `scripts/ec2-isolation/patch-worker-creds.sh` (obsolete — IRSA replaces it)

- [ ] **Step 1: Write the verdict spec**

Create `docs/superpowers/specs/2026-05-13-ec2-vs-k8s-ab-result.md` with these exact sections, filling in the values from Task 6:

```markdown
# EC2 vs K8s docs-flow A/B — verdict (2026-05-13)

## Setup
- Same docs-flow YAML, same prompt, same repo (foundry-test-repo).
- K8s session: compute=docs-k8s, image ark:276fbb07-merged, per-session pod.
- EC2 session: compute=test-ec2, instance i-08b0a5598afefe5a5, long-lived EC2 host.
- Temporal-worker: ark-temporal-worker:<sha>-ec2 (now with aws cli + smp; IRSA via platform-ark).

## Results
| run | compute | sid | final status | final stage | duration | error |
|---|---|---|---|---|---|---|
| 1 | docs-k8s | s-... | ... | ... | ... | ... |
| 2 | test-ec2 | s-... | ... | ... | ... | ... |

## Verdict
[one paragraph: which path failed where; the bug is in <K8sCompute pod-spawn / arkd RPC / git fork / claude-agent boot>]

## Next step
[exact next-action ticket: e.g. "fix K8sCompute setupSessionWorktree pod-readiness wait" or "fix arkd /exec forking under specific git clone conditions"]
```

- [ ] **Step 2: Delete the obsolete cred-injection script**

```bash
git rm scripts/ec2-isolation/patch-worker-creds.sh
```

- [ ] **Step 3: Roll the temporal-worker image back to the prior tag**

Run this **only** if the A/B is done and you don't want the modified image to keep running:

```bash
IMAGE_TAG=276fbb07-merged ./scripts/ec2-isolation/bump-worker-image.sh
```

If you want to keep the new image deployed (e.g. for further EC2 work tomorrow), skip this step and just document in the spec that the image was NOT rolled back.

- [ ] **Step 4: Stop the EC2 instance to save cost**

```bash
AWS_PROFILE=pai-risk-mlops aws ec2 stop-instances \
  --region ap-south-1 --instance-ids i-08b0a5598afefe5a5 \
  --query 'StoppingInstances[0].{id:InstanceId,state:CurrentState.Name}'
```
Expected: `{"id":"i-08b0a5598afefe5a5","state":"stopping"}`.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-05-13-ec2-vs-k8s-ab-result.md
git commit -m "chore: EC2 vs K8s A/B verdict + drop obsolete cred-injection script"
```

---

## Follow-ups (NOT in this plan's scope)

These are flagged for separate work after the A/B verdict tells us where to invest:

1. **Backfill `platform-ark` policy expansion to IaC** — Task 3 patched the role directly. Find the Terraform module that owns this role (`aws iam list-policies --query 'Policies[?PolicyName==\`platform-ark\`].Path'` to see if it's in a known path; cross-reference the chart's repo) and submit a PR. Otherwise the next Terraform `apply` will revert the perms.
2. **Add aws cli + smp to the main `Dockerfile`** — defensive, in case any CP code path resolves an EC2 compute. Same install block as Task 1.
3. **Helm values PR to pi-risk-mlops** — Task 4's `bump-worker-image.sh` is an in-place patch. If we ship the EC2-capable image as the new baseline, the image tag should land in the chart values and ArgoCD-sync, not stay as a manual patch.
4. **VPC interface endpoints for `ssm`, `ssmmessages`, `ec2messages`** — today the temporal-worker → AWS-SSM traffic goes via NAT; we proved it works but Zscaler could re-introduce MITM later. Endpoints eliminate that risk.
5. **arm64 build switch** — the install URLs in Task 1 are amd64-pinned. If we ever build arm64 worker images, parameterise with `$(uname -m)`.
6. **Pre-warm EC2 pool** — Task 5 attaches to ONE instance. For real EC2 traffic, configure `EC2Compute.pool` and provision multiple warm instances. Today a single instance is sufficient for A/B probing.
7. **Cost monitoring** — even with idle-shutdown, a permanently-running `test-ec2` accrues ~$X/day in ap-south-1 (depending on size). Tag the instance for billing visibility.
