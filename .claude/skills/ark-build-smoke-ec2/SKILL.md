---
name: ark-build-smoke-ec2
description: >
  Full CI/CD pipeline + post-deploy smoke test for the Ark project against the
  EC2-backed pai-risk-mlops-platform EKS cluster. Builds both arm64 Docker images
  (main ark + temporal-worker), pushes to AWS ECR, updates the Bitbucket
  deployment repo with the new tags (correct git author), force-syncs ArgoCD,
  and runs an end-to-end smoke session against bitbucket.org/paytmteam/foundry-test-repo
  via docs-k8s compute. Verifies branch + PR + auto-reap and prints a structured
  two-verdict test report.

  Use this skill whenever the user says "/ark-build", "/ark-build-smoke-ec2",
  "/ark_build", "build and push", "deploy ark", "build image", "push to ECR",
  "release ark", "ship ark", "build the temporal worker", or asks to update the
  image tag in the deployment repo. When in doubt, use this skill -- it handles
  the entire pipeline end-to-end so there's no need to run steps individually.

  Project-scoped variant of the user-level ark-build skill, named to make the
  EC2-cluster target explicit. Prefer this one when both exist; the global
  version stays as a fallback for runs outside the ark workspace.
---

# Ark Build & Deploy Pipeline

Full pipeline: build -> ECR push -> Bitbucket update -> ArgoCD sync -> health check.

## 1. Determine the image tag

If the user passes an argument (e.g., `/ark_build abc123`), use it. Otherwise resolve from git:

```bash
git -C /home/ubuntu/Projects/ark rev-parse --short=8 HEAD
```

Call the result `<tag>`. The full image tag is always `<tag>-arm64`.

## 2. ECR login

```bash
aws ecr get-login-password --region ap-south-1 \
  | docker login --username AWS --password-stdin \
    880170353725.dkr.ecr.ap-south-1.amazonaws.com
```

## 3. Build BOTH arm64 images

Two separate images must always be built together -- deploying only one causes `ImagePullBackOff` on the other. Run both from `/home/ubuntu/Projects/ark`.

```bash
# Main ark server
docker buildx build --platform linux/arm64 \
  -f Dockerfile -t ark:<tag>-arm64 --load .

# Temporal worker (separate Dockerfile)
docker buildx build --platform linux/arm64 \
  -f .infra/Dockerfile.temporal-worker \
  -t ark-temporal-worker:<tag>-arm64 --load .
```

These builds are slow (~10 min each via QEMU emulation) -- run them in the background and check output periodically.

## 4. Push both images to ECR

```bash
# Main image -> pai-mlops-platform/ark
docker tag ark:<tag>-arm64 \
  880170353725.dkr.ecr.ap-south-1.amazonaws.com/pai-mlops-platform/ark:<tag>-arm64
docker push \
  880170353725.dkr.ecr.ap-south-1.amazonaws.com/pai-mlops-platform/ark:<tag>-arm64

# Temporal worker -> pai-mlops-platform/ark-temporal-worker
docker tag ark-temporal-worker:<tag>-arm64 \
  880170353725.dkr.ecr.ap-south-1.amazonaws.com/pai-mlops-platform/ark-temporal-worker:<tag>-arm64
docker push \
  880170353725.dkr.ecr.ap-south-1.amazonaws.com/pai-mlops-platform/ark-temporal-worker:<tag>-arm64
```

## 5. Update Bitbucket deployment repo

Set git identity first -- without this, commits show as "Ubuntu" / "Security Utils" in Bitbucket:

```bash
git config --global user.name "Zineng Yuan"
git config --global user.email "zineng.yuan@paytm.com"
```

Clone or pull `pi-risk-mlops`:

```bash
# Pull if already cloned, otherwise fresh clone
if [ -d /tmp/pi-risk-mlops ]; then
  git -C /tmp/pi-risk-mlops pull
else
  git clone git@bitbucket.org:paytmteam/pi-risk-mlops.git /tmp/pi-risk-mlops
fi
```

Edit `k8s/infra-applications/ark/pai-risk-mlops-platform-values.yaml` -- update **all three** image tag fields to `<tag>-arm64`:
- `controlPlane.image.tag`
- `workers.image.tag`
- `temporal.worker.image.tag` (this key uses the `ark-temporal-worker` ECR repo, already configured -- only update the tag value)

Commit and push with explicit author flags:

```bash
git -C /tmp/pi-risk-mlops add \
  k8s/infra-applications/ark/pai-risk-mlops-platform-values.yaml
git -C /tmp/pi-risk-mlops \
  -c user.name="Zineng Yuan" \
  -c user.email="zineng.yuan@paytm.com" \
  commit -m "chore: update ark image tag to <tag>-arm64"
git -C /tmp/pi-risk-mlops push origin main
```

## 6. ArgoCD force sync

ArgoCD caches the rendered chart per source revision. A normal sync can run
against a stale render and silently no-op the image-tag bump. ALWAYS hard-
refresh first, otherwise the sync may report success but the cluster keeps
running the previous tag.

```bash
argocd login argocd.internal.ap-south-1.platform.mlops.pai.mypaytm.com \
  --insecure --username admin --password '1FjisR32ZaVRTss9' --grpc-web

# Bust the cache: re-render the chart at HEAD before syncing.
argocd app get pai-risk-mlops-platform-ark --hard-refresh --grpc-web

argocd app sync pai-risk-mlops-platform-ark --force --grpc-web
```

If `app sync` reports `another operation is already in progress`, the
hard-refresh's implicit auto-sync is still running -- wait a few seconds
and the sync will be a no-op (or re-issue if needed).

## 7. Verify pod health

Check all 6 pods are Running using kubectl directly:

```bash
kubectl get pods -n ark
```

Expected healthy final state -- all pods must show Running:
```
ark-control-plane-*   2/2 Running
ark-worker-*          2/2 Running
ark-redis-*           1/1 Running
temporal-server-*     1/1 Running
temporal-ui-*         1/1 Running
temporal-worker-*     1/1 Running
```

Confirm temporal-worker is fully operational:
```bash
kubectl logs -n ark -l app.kubernetes.io/component=temporal-worker --tail=20 | grep -i "worker state"
# Should show: Worker state: RUNNING
```

## 8. Smoke test: dispatch a session on docs-k8s

Only run this AFTER step 7 shows all 6 pods Running. This proves the
dispatch chain (RPC -> conductor -> Temporal -> K8sCompute) actually
works end-to-end on the freshly-deployed tag.

Gotchas baked in from prior incidents -- do not deviate:
- The RPC param key is `compute_name`, NOT `compute`. Using `compute`
  silently falls back to `"local"`, which does not exist in this cluster
  and the session dies at provision.
- The endpoint requires the full JSON-RPC 2.0 envelope
  (`jsonrpc`, `id`, `method`, `params`). A bare `{"method": ...}` body
  returns `Invalid JSON-RPC request`.
- Do NOT `kubectl exec -- ark session list` from inside the control-plane
  pod. The in-pod CLI tries to spawn its own daemon on :19400 and fails.
  Always drive the cluster via the ingress RPC.
- `docs-k8s` is a compute-target template. The session call clones it
  into a per-session target automatically -- nothing to pre-create.
- The RPC handler reads `remoteRepo` from `config.remoteRepo` (nested), NOT from the top-level params. A top-level `"remoteRepo": "..."` is silently dropped -- `session.config.remoteRepo` ends up null, the executor falls back to `session.repo` (often a bare basename), and `git clone` runs against the bare name instead of the URL. Always send `"config": {"remoteRepo": "..."}` in the params object. Verified live on 2026-05-15 (s-mg7o4pbzkb).

### 8a. Dispatch the session via ingress RPC

```bash
curl -sk -m 15 -X POST https://ark.internal.ap-south-1.platform.mlops.pai.mypaytm.com/api/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"session/start","params":{
    "flow":"docs",
    "compute_name":"docs-k8s",
    "config":{"remoteRepo":"https://bitbucket.org/paytmteam/foundry-test-repo"},
    "summary":"add a smoke test for caculator cli"
  }}'
```

Extract the session id from `result.session.id` (format `s-<10chars>`):

```bash
SID=$(curl -sk -m 15 -X POST https://ark.internal.ap-south-1.platform.mlops.pai.mypaytm.com/api/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"session/start","params":{
    "flow":"docs",
    "compute_name":"docs-k8s",
    "config":{"remoteRepo":"https://bitbucket.org/paytmteam/foundry-test-repo"},
    "summary":"add a smoke test for caculator cli"
  }}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["session"]["id"])')
echo "SID=$SID"
```

### 8b. Poll session state every 30s with auto-leak-kill + 3-min hard cap

Terminal statuses: `failed`, `completed`, `done`. The poller also:
1. Detects "stuck" state (same `(pod, status)` for 2+ ticks ≈ 60s) and dumps
   `kubectl get events` + `kubectl logs` for the sandbox pod so you can
   diagnose without re-running.
2. **Auto-kills leaked sandbox pods** when stuck AND the session's pod is
   `Pending`. A pod is a leak when:
   - name matches `ark-mp*`, AND
   - `creationTimestamp` is BEFORE the session's `created_at`, AND
   - phase is `Running`, AND
   - it is NOT the session's own pod (`session.config.compute_handle.name`).
   Each deletion is logged. As of commit 34226740 (deployed 2026-05-15)
   the workflow's `session-workflow.ts` wraps the run in
   `try { ... } finally { CancellationScope.nonCancellable(() => destroyComputeActivity(...)) }`,
   so successful sessions now auto-reap their sandbox pods (verified live:
   4 back-to-back sessions, terminal-to-pod-gone in 18-54s). The
   auto-leak-killer stays in the poller as a safety net for the
   REMAINING gap: provision-time leaks. When `K8sCompute.provision`
   throws during port-forward setup, the handle was never persisted to
   `session.config.compute_handle`, so the `finally` has nothing to
   destroy and the pod leaks. The auto-leak-killer continues to handle
   that case (see project memory `project-k8s-port-forward-timeout`).
3. **Hard 3-minute cap.** When the cap fires the loop exits with status
   `TIMEOUT` and you MUST dump pod logs + temporal-worker logs immediately
   to diagnose -- do not silently keep waiting. Most healthy sessions reach
   terminal within 3 minutes; longer than that means something is wrong
   (port-forward retry loop, CPU saturation, model API hang).

```bash
SID="${SID:-$SID}"
LOG=/tmp/monitor.log
URL="https://ark.internal.ap-south-1.platform.mlops.pai.mypaytm.com/api/rpc"
> "$LOG"
SESSION_CREATED=$(curl -sk -m 5 -X POST "$URL" -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/read\",\"params\":{\"sessionId\":\"$SID\"}}" \
  | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["result"]["session"]["created_at"])
except: print("")')
echo "[$(date +%H:%M:%S)] monitoring $SID created_at=$SESSION_CREATED" | tee -a "$LOG"

LAST_POD=""; LAST_STATUS=""; STUCK_TICKS=0
DEADLINE=$(( $(date +%s) + 180 ))   # 3-minute hard cap

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  RAW=$(curl -sk -m 5 -X POST "$URL" -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/read\",\"params\":{\"sessionId\":\"$SID\"}}")
  POD=$(RAW="$RAW" python3 -c 'import os,json
try: print((json.loads(os.environ["RAW"])["result"]["session"].get("config") or {}).get("compute_handle",{}).get("name") or "")
except: print("")')
  STATUS=$(RAW="$RAW" python3 -c 'import os,json
try: print(json.loads(os.environ["RAW"])["result"]["session"].get("status") or "")
except: print("")')
  RAW="$RAW" python3 - <<'PY' | tee -a "$LOG"
import os,json,datetime
s = json.loads(os.environ["RAW"])["result"]["session"]
ts = datetime.datetime.now().strftime("%H:%M:%S")
pod = (s.get("config") or {}).get("compute_handle",{}).get("name")
line = f"[{ts}] {s.get('id')} stage={s.get('stage')} status={s.get('status')} agent={s.get('agent')} branch={s.get('branch')} wd={s.get('workdir')} pod={pod}"
err = s.get("error")
if err: line += f" err={err}"
print(line, flush=True)
PY

  if [ "$POD" = "$LAST_POD" ] && [ "$STATUS" = "$LAST_STATUS" ]; then
    STUCK_TICKS=$((STUCK_TICKS + 1))
  else
    STUCK_TICKS=0
  fi
  LAST_POD="$POD"; LAST_STATUS="$STATUS"

  # Stuck: dump pod events + arkd logs for diagnosis.
  if [ "$STUCK_TICKS" -ge 2 ] && [ -n "$POD" ]; then
    PHASE=$(kubectl get pod -n ark "$POD" -o jsonpath='{.status.phase}' 2>/dev/null || echo "GONE")
    echo "  [pod] $POD phase=$PHASE" | tee -a "$LOG"
    kubectl get events -n ark --field-selector involvedObject.name="$POD" --sort-by=.lastTimestamp 2>/dev/null | tail -3 | sed 's/^/    /' | tee -a "$LOG"
    kubectl logs -n ark "$POD" --tail=3 2>/dev/null | sed 's/^/    arkd: /' | tee -a "$LOG"

    # Auto-leak-kill: session pod Pending + older ark-mp* pods Running.
    if [ "$PHASE" = "Pending" ] && [ -n "$SESSION_CREATED" ]; then
      echo "  [leak-scan] session pod Pending; scanning for older Running ark-mp* pods" | tee -a "$LOG"
      kubectl get pods -n ark -o json 2>/dev/null \
        | python3 - "$SESSION_CREATED" "$POD" <<'PY' | tee -a "$LOG"
import sys, json, subprocess
created, mypod = sys.argv[1], sys.argv[2]
for it in json.load(sys.stdin).get("items", []):
    n = it["metadata"]["name"]
    if not n.startswith("ark-mp") or n == mypod: continue
    if it["status"].get("phase") != "Running": continue
    ts = it["metadata"].get("creationTimestamp", "")
    if ts and ts < created:
        print(f"  [leak-kill] {n} (created {ts}, before session {created})")
        subprocess.run(["kubectl","delete","pod","-n","ark",n,"--wait=false"], capture_output=True)
PY
      STUCK_TICKS=0   # reset so we don't re-scan immediately
    fi
  fi

  case "$STATUS" in failed|completed|done) echo "TERMINAL" | tee -a "$LOG"; break;; esac
  sleep 30
done

# 3-min cap hit. MUST dump diagnostics; do not silently continue waiting.
if [ "$(date +%s)" -ge "$DEADLINE" ]; then
  echo "TIMEOUT after 180s -- dumping diagnostics" | tee -a "$LOG"
  echo "--- session/read ---" | tee -a "$LOG"
  curl -sk -m 5 -X POST "$URL" -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/read\",\"params\":{\"sessionId\":\"$SID\"}}" \
    | python3 -m json.tool | tee -a "$LOG"
  echo "--- sandbox pods ---" | tee -a "$LOG"
  kubectl get pods -n ark | grep '^ark-mp' | tee -a "$LOG"
  if [ -n "$POD" ]; then
    echo "--- arkd logs ($POD) ---" | tee -a "$LOG"
    kubectl logs -n ark "$POD" --tail=20 2>/dev/null | tee -a "$LOG"
  fi
  echo "--- temporal-worker recent errors ---" | tee -a "$LOG"
  kubectl logs -n ark -l app.kubernetes.io/component=temporal-worker --tail=60 2>&1 \
    | grep -B1 -A6 "$SID" | tail -40 | tee -a "$LOG"
fi
```

### 8c. Report final outcome

```bash
curl -sk -m 15 -X POST https://ark.internal.ap-south-1.platform.mlops.pai.mypaytm.com/api/rpc \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/read\",\"params\":{\"sessionId\":\"$SID\"}}" \
  | python3 -c '
import sys, json
r = json.load(sys.stdin)
s = r.get("result", {}).get("session", {})
pod = s.get("config", {}).get("compute_handle", {}).get("name")
print("Final session state:", json.dumps(s, indent=2))
print("compute_handle pod:", pod)
status = s.get("status")
if status in ("completed", "done"):
    print(f"VERDICT: SUCCESS -- session {s.get(\"id\")} reached status={status}")
else:
    print(f"VERDICT: FAILURE -- session {s.get(\"id\")} ended status={status} error={s.get(\"error\")}")
'
```

### 8d. Verify PR branch + author

The `pr_url` field on a session is a Bitbucket "create-pr" deeplink: it
indicates the branch was pushed but does NOT mean an actual PR object
exists via the Bitbucket REST API. Verify TWO things directly against
the remote:

1. The remote branch exists on Bitbucket (via `git ls-remote` using the
   auth token already embedded in `pr_url`).
2. The latest commit on that branch has a real human-style author --
   NOT `Ubuntu`, `root`, or `Security Utils`.

```bash
URL="https://ark.internal.ap-south-1.platform.mlops.pai.mypaytm.com/api/rpc"
RAW=$(curl -sk -m 10 -X POST "$URL" -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/read\",\"params\":{\"sessionId\":\"$SID\"}}")

# Parse branch + pr_url from the session.
read BRANCH PR_URL < <(RAW="$RAW" python3 -c '
import os, json
s = json.loads(os.environ["RAW"])["result"]["session"]
print((s.get("branch") or ""), (s.get("pr_url") or ""))
')
echo "branch=$BRANCH pr_url=$PR_URL"

if [ -z "$BRANCH" ] || [ -z "$PR_URL" ]; then
  echo "FAIL: session has no branch or pr_url -- nothing to verify"
  exit 1
fi

# Extract the bitbucket auth token from the pr_url (it is embedded as
# x-bitbucket-api-token-auth:<token>@bitbucket.org/...). Then build an
# auth'd clone URL for the foundry-test-repo.
TOKEN=$(PR_URL="$PR_URL" python3 -c '
import os, re
m = re.search(r"x-bitbucket-api-token-auth:([^@]+)@", os.environ["PR_URL"])
print(m.group(1) if m else "")
')
if [ -z "$TOKEN" ]; then
  echo "FAIL: could not parse bitbucket auth token from pr_url"
  exit 1
fi
REPO_URL="https://x-bitbucket-api-token-auth:${TOKEN}@bitbucket.org/paytmteam/foundry-test-repo.git"

# (a) Branch must exist on the remote.
if ! git ls-remote "$REPO_URL" "refs/heads/$BRANCH" | grep -q "refs/heads/$BRANCH"; then
  echo "FAIL: branch $BRANCH does not exist on remote"
  exit 1
fi
echo "PASS: branch $BRANCH present on remote"

# (b) Latest commit author must be a real human (not bot generic).
rm -rf /tmp/pr-verify
git clone --depth 1 -b "$BRANCH" "$REPO_URL" /tmp/pr-verify >/dev/null 2>&1
AUTHOR=$(git -C /tmp/pr-verify log -1 --pretty='%an <%ae>')
echo "latest commit author: $AUTHOR"

if [ -z "$AUTHOR" ]; then
  echo "FAIL: could not read author of latest commit on $BRANCH"
  exit 1
fi
if echo "$AUTHOR" | grep -Eq '^(Ubuntu|root|Security Utils)\b'; then
  echo "FAIL: latest commit author '$AUTHOR' is a bot/generic identity, not a real human"
  exit 1
fi
echo "PASS: latest commit author '$AUTHOR' passes non-bot check"
rm -rf /tmp/pr-verify
```

### 8e. Verify auto-reap (the whole point)

```bash
# The workflow's finally hook should have destroyed the sandbox pod
# automatically -- session.config.compute_handle.name should no longer
# exist in the namespace.
POD=$(curl -sk -m 5 -X POST https://ark.internal.ap-south-1.platform.mlops.pai.mypaytm.com/api/rpc \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/read\",\"params\":{\"sessionId\":\"$SID\"}}" \
  | python3 -c 'import sys,json;print((json.load(sys.stdin)["result"]["session"].get("config") or {}).get("compute_handle",{}).get("name") or "")')

# Wait up to 90s for the pod to disappear (graceful terminate window).
DEADLINE=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if ! kubectl get pod -n ark "$POD" >/dev/null 2>&1; then
    echo "PASS: sandbox pod $POD was auto-reaped by workflow finally"
    break
  fi
  sleep 5
done

if kubectl get pod -n ark "$POD" >/dev/null 2>&1; then
  echo "FAIL: sandbox pod $POD still exists 90s after terminal; destroyCompute did not run"
  kubectl get pod -n ark "$POD"
  exit 1
fi
```

## Gotchas and fixes

### Stale replicasets

After ArgoCD sync, old replicasets with wrong images can keep spinning up failing pods. If you see pods not in Running state:

```bash
# Identify pods not Running or Completed
kubectl get pods -n ark | grep -v Running | grep -v Completed

# Find and delete the bad replicaset (look for one with 0/0 desired but still creating pods)
kubectl get replicasets -n ark
kubectl delete replicaset <stale-replicaset-name> -n ark
```

### Extra injected container in temporal-worker

The temporal-worker deployment may have an extra container injected (e.g., pulling from `ghcr.io/paytm-labs-inc/ark-temporal-worker:...`). Symptom: pod shows `1/2` ready or has `ImagePullBackOff` from a non-ECR registry.

```bash
# Inspect containers in the deployment
kubectl get deployment temporal-worker -n ark \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}: {.image}{"\n"}{end}'

# If there's a non-ECR container at index 0, remove it
kubectl patch deployment temporal-worker -n ark --type=json \
  -p='[{"op": "remove", "path": "/spec/template/spec/containers/0"}]'
```

### Temporal DB auth crash after sync

If temporal-worker crashes with `password authentication failed for user "temporal"`, the ArgoCD PreSync hook recreated the DB credentials secret. The temporal-server must be restarted to pick up the new secret:

```bash
kubectl rollout restart deployment/temporal-server -n ark

# Wait for temporal-worker to recover (usually 2-3 minutes)
until kubectl get pod -n ark -l app.kubernetes.io/component=temporal-worker \
  -o jsonpath='{.items[0].status.containerStatuses[0].ready}' | grep -q true; do
  sleep 10
done
echo "temporal-worker is ready"
```

### kubectl pre-requisite (already done on this machine)

If kubectl is not configured, run once:
```bash
aws eks update-kubeconfig --name pai-risk-mlops-platform --region ap-south-1
```

## Infrastructure reference

| Resource | Value |
|---|---|
| ECR registry | `880170353725.dkr.ecr.ap-south-1.amazonaws.com` |
| ECR repo (main) | `pai-mlops-platform/ark` |
| ECR repo (worker) | `pai-mlops-platform/ark-temporal-worker` |
| Bitbucket repo | `git@bitbucket.org:paytmteam/pi-risk-mlops.git` |
| Bitbucket local path | `/tmp/pi-risk-mlops` |
| Values file | `k8s/infra-applications/ark/pai-risk-mlops-platform-values.yaml` |
| ArgoCD host | `argocd.internal.ap-south-1.platform.mlops.pai.mypaytm.com` |
| ArgoCD app | `pai-risk-mlops-platform-ark` |
| k8s namespace | `ark` |
| k8s cluster | `pai-risk-mlops-platform` |
| AWS region | `ap-south-1` |
| Git identity | `Zineng Yuan <zineng.yuan@paytm.com>` |

### 8f. Final test report

After the smoke session has reached terminal and 8c-8e have run, print a
structured two-verdict report. Both must read PASS for the build to be
considered green:

**Verdict 1: All stages pass AND a PR object was created.**
- session.status == "completed" (from 8c)
- session.pr_url is set
- `GET /pullrequests/<id>` against api.bitbucket.org/2.0 returns 200 with
  state=OPEN -- proves the URL points at a REAL pull-request object, not
  a deeplink to the create-pr form. Bitbucket Cloud's PR URLs are of the
  form `https://bitbucket.org/<ws>/<repo>/pull-requests/<id>`; parse the
  numeric id from the URL and verify it via REST.

**Verdict 2: Branch is created AND PR is created with the right author name.**
- Branch verified present on remote (from 8d)
- Latest commit author on the branch is NOT a bot identity (from 8d:
  `^(Ubuntu|root|Security Utils|Planner|Implementer|.*@foundry.local|ark)\b`
  is the deny-list; the configured `Zineng Yuan <zineng.yuan@paytm.com>`
  resolved from the SSM tenant secrets ARK_GIT_AUTHOR_NAME / _EMAIL must
  pass)

Print the report verbatim, in this shape:

```bash
echo "=========================================="
echo "  ARK SMOKE TEST REPORT  (tag=<tag>-arm64)"
echo "=========================================="
echo "  session: $SID"
echo "  branch:  $BRANCH"
echo "  pr_url:  $PR_URL"
echo "  author:  $AUTHOR"
echo "  pod:     $POD (auto-reaped: yes/no)"
echo "------------------------------------------"
echo "  VERDICT 1 (stages-pass + PR-created): PASS/FAIL"
echo "  VERDICT 2 (branch + correct-author):  PASS/FAIL"
echo "=========================================="
```

Construct the verdicts from the prior step outputs and capture both into
the build summary so the operator sees a single line per concern. A FAIL
on either verdict means the build is not shippable -- the prior section
that produced the FAIL should already have logged the underlying error.

## Summary to report

- Image tag used (`<tag>-arm64`)
- Both ECR pushes confirmed (main ark + temporal-worker)
- Bitbucket commit SHA
- Pod health table -- all 6 pods Running with correct ready counts
- temporal-worker log confirmation: "Worker state: RUNNING"
- Smoke session id (`s-<10chars>`) and final state (status + stage + compute_handle pod), with SUCCESS / FAILURE verdict
- PR branch verification: branch present on remote + commit author name passes the non-bot check
- Pod reap verification: sandbox pod auto-removed within 90s of terminal
- **Final two-verdict test report:**
  - Verdict 1 (all stages pass AND a PR object was created): PASS / FAIL
  - Verdict 2 (branch created AND PR has the right human author): PASS / FAIL
