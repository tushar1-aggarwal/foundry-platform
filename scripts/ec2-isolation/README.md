# scripts/ec2-isolation — remote EC2 A/B for docs-flow

Companion to `scripts/pod-isolation/`. Where pod-isolation tests "agent
inside a Job pod with no arkd", this suite tests "real docs-flow session
**dispatched by the deployed control-plane** against an EC2 compute target
instead of K8s". The goal is to A/B the K8s hang we see today: same prod
ark-worker, same arkd RPC path (because EC2's `supportsWorktree:false`),
different host substrate. If the EC2 session runs to completion and the K8s
one hangs, the bug is in the K8s compute path; if both hang, the bug is in
arkd or the agent code itself.

## What this changes in the deployed control-plane

| Resource | Change | Reversible |
|---|---|---|
| RDS `compute` table | Insert row `name='test-ec2', compute_kind='ec2'` attached to instance `i-08b0a5598afefe5a5` | yes, `cleanup.sh --delete-row` |
| K8s Secret `ark/ark-aws-creds-probe` | Created with `AWS_*` env from operator's SSO | yes, `cleanup.sh` |
| K8s Deployment `ark/ark-worker` | Patched: `envFrom: [secretRef: ark-aws-creds-probe]` triggers rollout | yes, `cleanup.sh` |
| One-shot Pods/Jobs | dispatch ConfigMaps + Jobs in `ark` ns | TTL 10min auto-clean |

The credential injection is a **probe shortcut**. Production should use IRSA
(IAM Roles for Service Accounts) -- SSO creds expire in ~8h.

## Scripts

| File | Purpose |
|---|---|
| `lib.sh` | Shared helpers: EKS curl+bearer (`k_get`/`k_post_json`/`k_patch_json`/`k_delete`), pod waiters, log fetchers, env defaults |
| `preflight.sh` | Verifies AWS creds, EC2 alive + SSM-online, EKS reachable, **session-manager-plugin in ark-worker image** (BLOCKER if missing), and reports existing EC2 compute rows |
| `register-compute.sh` | Spawns a one-shot psql pod that `INSERT … ON CONFLICT DO UPDATE` on the EC2 compute row |
| `patch-worker-creds.sh` | Creates `ark-aws-creds-probe` Secret from local SSO creds, patches the ark-worker Deployment to envFrom it, waits for rollout |
| `dispatch-session.sh` | Spawns a Job pod that opens a WebSocket to `ark-control-plane:19100`, fires `session/start` JSON-RPC with `compute_name=test-ec2`, logs the session id |
| `cleanup.sh` | Reverts patch + deletes secret + cleans up dispatch ConfigMaps/Jobs (`--delete-row` also wipes the compute row) |
| `run.sh` | Orchestrator: chains all 4 above. `--skip-*` flags + `--dry-run` |

## Quick start

```bash
# 1. SSO login if expired
! aws sso login --profile pai-risk-mlops

# 2. (optional) sanity check on /etc/hosts ENI pin
dig FE31813B454D7EB0B1F97A842603B163.gr7.ap-south-1.eks.amazonaws.com +short
# if it returns 100.64.x.x, refresh per eks-vpn-dns-hijack-fix skill

# 3. fire the full chain
./scripts/ec2-isolation/run.sh
```

Or step-by-step:

```bash
./scripts/ec2-isolation/preflight.sh        # confirms blockers up-front
./scripts/ec2-isolation/register-compute.sh # adds 'test-ec2' compute row
./scripts/ec2-isolation/patch-worker-creds.sh
./scripts/ec2-isolation/dispatch-session.sh # prints new session id
# inspect events, then:
./scripts/ec2-isolation/cleanup.sh           # revert (keeps compute row)
```

## Known blocker the preflight surfaces

**`session-manager-plugin` is almost certainly NOT in the ark image today.**
`EC2Compute.setupTransport` shells out to `aws ssm start-session
--document AWS-StartPortForwardingSession`, which depends on that plugin.
If preflight reports it missing, you have three options:

1. Bake it in (modify `Dockerfile`, rebuild + push) — slowest.
2. Sidecar a thin image with the plugin onto the ark-worker pod — moderate.
3. Run a one-off Pod (own image with `aws cli` + plugin) that itself does the
   SSM forward and exposes it as a Service that arkd-client targets — fastest.

The "right" fix is #1 in prod. For an A/B probe, #3 is enough.

## Env knobs (set before running)

```bash
export AWS_PROFILE=pai-risk-mlops
export AWS_REGION=ap-south-1
export EC2_COMPUTE_NAME=test-ec2
export EC2_INSTANCE_ID=i-08b0a5598afefe5a5
export SESSION_FLOW=docs
export SESSION_SUMMARY="Add one paragraph to architecture.md (EC2 A/B)"
export SESSION_REPO=https://bitbucket.org/paytmteam/foundry-test-repo
```

## After dispatch — where to look

The dispatch script prints the new session id. The deployed CP's session
events are queryable via the RDS:

```bash
# Crib the psql-pod recipe from register-compute.sh or preflight.sh and run:
SELECT id, status, stage, compute_name, error FROM sessions
  WHERE id = '<new-session-id>';
SELECT created_at, type, data FROM session_events
  WHERE session_id = '<new-session-id>' ORDER BY created_at;
```

`ark-worker` logs:

```bash
WORKER=$(./scripts/ec2-isolation/lib.sh; ... )  # or inline:
TOKEN=$(aws eks get-token --cluster-name pai-risk-mlops-platform --region ap-south-1 --profile pai-risk-mlops | jq -r .status.token)
HOST=FE31813B454D7EB0B1F97A842603B163.gr7.ap-south-1.eks.amazonaws.com
WORKER=$(curl -sk -H "Authorization: Bearer $TOKEN" \
  "https://$HOST/api/v1/namespaces/ark/pods?labelSelector=app=ark-worker" \
  | jq -r '.items[0].metadata.name')
curl -sk -H "Authorization: Bearer $TOKEN" \
  "https://$HOST/api/v1/namespaces/ark/pods/$WORKER/log?sinceSeconds=300"
```

## Architectural diagram

```
┌───────────────────────── Deployed CP (EKS) ──────────────────────────┐
│                                                                       │
│  dispatch-session.sh Job ────WS:19100──▶ ark-control-plane            │
│                                              ↓                        │
│                                          conductor                    │
│                                              ↓                        │
│                                       Temporal start                  │
│                                              ↓                        │
│  ★ ark-worker (Deployment)                                            │
│   │                                                                   │
│   │  envFrom: ark-aws-creds-probe (AWS_ACCESS_KEY_ID/SECRET/SESSION)  │
│   │                                                                   │
│   ├─ resolveComputeTarget → kind=ec2, instance_id=i-08b0a5...         │
│   ├─ EC2Compute.attachExistingHandle                                  │
│   ├─ EC2Compute.setupTransport                                        │
│   │     spawn `aws ssm start-session ...` (NEEDS session-manager-plugin)
│   │     → localhost:<rnd> → SSM → EC2:19300                            │
│   ├─ ensureReachable → curl localhost:<rnd>/health                    │
│   ├─ runGit("clone authed_url …")  via ArkdClient.run → /exec         │
│   ├─ stage plan  → claude-agent on EC2                                │
│   ├─ stage impl  → claude-agent on EC2                                │
│   └─ stage pr    → createWorktreePR                                   │
└───────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ SSM
                                  ▼
                ┌──── EC2 (test-ec2, ap-south-1) ────┐
                │   i-08b0a5598afefe5a5  172.31.22.79│
                │   arkd :19300 (from cloud-init)    │
                │   git, bun, claude-agent           │
                └────────────────────────────────────┘
```
