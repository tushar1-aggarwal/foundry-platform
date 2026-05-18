#!/usr/bin/env bash
# Dispatch a docs-flow session against the EC2 compute target via the
# deployed CP's WebSocket conductor (port 19100).
#
# Strategy: the conductor is WebSocket-only and reachable only inside the
# cluster, so we spawn a one-shot Job pod that:
#   1. Opens a WebSocket to ws://ark-control-plane:19100
#   2. Sends a JSON-RPC `session/start` with compute_name=$EC2_COMPUTE_NAME
#   3. Logs the response (which contains the new session id)
#   4. Exits
#
# The Job uses the ark image (bun installed) so we can use Bun's native
# WebSocket -- no extra deps.
#
# Env knobs (from lib.sh):
#   EC2_COMPUTE_NAME    target compute name (default: test-ec2)
#   SESSION_FLOW        flow name (default: docs)
#   SESSION_SUMMARY     task summary
#   SESSION_REPO        repo URL
#   SESSION_BRANCH      branch (empty -> server-picked)
#   SESSION_AGENT       agent (empty -> flow-picked)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

JOB_NAME="ark-ec2-dispatch-$(date +%s)"
CM_NAME="$JOB_NAME-cm"

log "dispatching session: flow=$SESSION_FLOW compute=$EC2_COMPUTE_NAME repo=$SESSION_REPO"

# ── bun script (runs in pod) ────────────────────────────────────────────────
# Sends JSON-RPC over WS, logs response. Wrapped in a heredoc so we can ship
# it via ConfigMap without needing to source from the repo.
cat > /tmp/dispatch.ts <<'TS'
const url = process.env.WS_URL!;
const params: any = {
  flow: process.env.SESSION_FLOW,
  compute_name: process.env.COMPUTE_NAME,
  summary: process.env.SESSION_SUMMARY,
  repo: process.env.SESSION_REPO,
};
if (process.env.SESSION_BRANCH) params.branch = process.env.SESSION_BRANCH;
if (process.env.SESSION_AGENT)  params.agent  = process.env.SESSION_AGENT;

console.log(`[ws] connecting to ${url}`);
const ws = new WebSocket(url);
const id = Date.now();
const deadline = Date.now() + 30_000;

ws.onopen = () => {
  console.log(`[ws] open; sending session/start`);
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "session/start", params }));
};
ws.onmessage = (e: MessageEvent) => {
  console.log(`[ws] msg: ${e.data}`);
  try {
    const r = JSON.parse(String(e.data));
    if (r.id === id) {
      console.log("=== RESULT ===");
      console.log(JSON.stringify(r, null, 2));
      ws.close();
      process.exit(r.error ? 2 : 0);
    }
  } catch {}
};
ws.onerror = (e: Event) => {
  console.error(`[ws] error: ${(e as any).message ?? e}`);
};
ws.onclose = (e: CloseEvent) => {
  console.log(`[ws] closed code=${e.code} reason="${e.reason}"`);
  if (Date.now() < deadline) process.exit(3);
};

setTimeout(() => { console.error("[ws] timeout 30s"); process.exit(4); }, 30_000);
TS

# ── ship via ConfigMap ──────────────────────────────────────────────────────
CM_JSON=$(python3 -c "
import json
data = {'dispatch.ts': open('/tmp/dispatch.ts').read()}
print(json.dumps({
  'apiVersion': 'v1', 'kind': 'ConfigMap',
  'metadata': {'name': '$CM_NAME', 'namespace': '$EKS_NAMESPACE'},
  'data': data
}))")
k_delete "/api/v1/namespaces/$EKS_NAMESPACE/configmaps/$CM_NAME" >/dev/null 2>&1 || true
k_post_json "/api/v1/namespaces/$EKS_NAMESPACE/configmaps" "$CM_JSON" >/dev/null
ok "configmap created"

# ── Job spec ────────────────────────────────────────────────────────────────
# Image: same prod ark image. Command: bun run /opt/dispatch.ts.
# Env carries the session params + WS_URL pointing at the in-cluster CP svc.
JOB_JSON=$(jq -nc \
  --arg name "$JOB_NAME" \
  --arg ns "$EKS_NAMESPACE" \
  --arg cm "$CM_NAME" \
  --arg img "880170353725.dkr.ecr.ap-south-1.amazonaws.com/pai-mlops-platform/ark:276fbb07-merged" \
  --arg ws "ws://ark-control-plane:19100" \
  --arg flow "$SESSION_FLOW" \
  --arg compute "$EC2_COMPUTE_NAME" \
  --arg summary "$SESSION_SUMMARY" \
  --arg repo "$SESSION_REPO" \
  --arg branch "$SESSION_BRANCH" \
  --arg agent "$SESSION_AGENT" '{
  apiVersion:"batch/v1", kind:"Job",
  metadata:{name:$name, namespace:$ns},
  spec:{
    ttlSecondsAfterFinished: 600,
    backoffLimit: 0,
    activeDeadlineSeconds: 90,
    template:{
      spec:{
        restartPolicy:"Never",
        containers:[{
          name:"dispatch", image:$img,
          command:["bun","run","/opt/iso/dispatch.ts"],
          env:[
            {name:"WS_URL",          value:$ws},
            {name:"SESSION_FLOW",    value:$flow},
            {name:"COMPUTE_NAME",    value:$compute},
            {name:"SESSION_SUMMARY", value:$summary},
            {name:"SESSION_REPO",    value:$repo},
            {name:"SESSION_BRANCH",  value:$branch},
            {name:"SESSION_AGENT",   value:$agent}
          ],
          volumeMounts:[{name:"iso", mountPath:"/opt/iso"}]
        }],
        volumes:[{name:"iso", configMap:{name:$cm}}]
      }
    }
  }
}')

k_post_json "/apis/batch/v1/namespaces/$EKS_NAMESPACE/jobs" "$JOB_JSON" | jq -r '"job=" + (.metadata.name // "(error: " + .message + ")")'

# ── poll Job pod for completion ────────────────────────────────────────────
log "waiting for dispatch pod (max 60s)"
deadline=$(( $(date +%s) + 60 ))
POD=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  POD=$(k_get "/api/v1/namespaces/$EKS_NAMESPACE/pods?labelSelector=job-name=$JOB_NAME" 2>/dev/null \
    | jq -r '.items[0].metadata.name // ""')
  [ -n "$POD" ] && break
  sleep 2
done
if [ -z "$POD" ]; then
  echo "FATAL: dispatch Pod never appeared" >&2
  exit 1
fi

phase=$(wait_pod_phase "$POD" Succeeded 60)
echo "phase=$phase"
echo "--- dispatch pod logs ---"
pod_logs "$POD"

echo
log "leftover: ConfigMap $CM_NAME + Job $JOB_NAME (TTL 10min). Run cleanup.sh to remove sooner."
