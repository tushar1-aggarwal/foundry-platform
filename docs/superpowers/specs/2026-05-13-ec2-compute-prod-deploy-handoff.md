# EC2-compute prod deploy — session handoff (2026-05-13 8:50pm EDT)

Use this doc to resume work in a fresh session. The plan + spec are durable; this is just the wave-state.

## Where we stopped

Mid-execution of [plan T1](../plans/2026-05-13-ec2-compute-prod-deploy.md#task-1-add-aws-cli-v2--session-manager-plugin-to-temporal-worker-dockerfile). T3 (IAM policy) is committed. T1 (Dockerfile) has the edit on disk but is **uncommitted**. T2 has not started.

## Quick status

| What | State | Where |
|---|---|---|
| Spec | ✅ committed | `docs/superpowers/specs/2026-05-13-ec2-compute-prod-deploy-design.md` (`2ab0b8a1`) |
| Plan | ✅ committed | `docs/superpowers/plans/2026-05-13-ec2-compute-prod-deploy.md` (`e69fef2d`) |
| T1 — Dockerfile edit | ⚠ on disk, NOT committed | `.infra/Dockerfile.temporal-worker` (working tree only) |
| T1 — `docker build` smoke test | ❌ not run | — |
| T2 — `build-push-temporal-worker.sh` + ECR push | ❌ not started | — |
| T3 — IAM policy expansion | ✅ done in AWS + script committed | `scripts/ec2-isolation/expand-iam-policy.sh` (`7353e24c`); `platform-ark` policy is now **version v3 (default)** with 6 SIDs |
| T4 — `bump-worker-image.sh` + `probe-irsa-ssm.sh` | ❌ not started | — |
| T5 — register-compute (deployed RDS row) | ❌ not started (script exists from `4bd6551a`) | — |
| T6 — dispatch session + verify | ❌ not started | — |
| T7 — verdict spec + cleanup | ❌ not started | — |

## What the AWS side looks like now

- `platform-ark` IAM policy: **6 SIDs** including new `Ec2InstancesForEC2Compute` + `SsmSessionManagerForEC2Compute`. Default version is `v3`. Reversible: delete `v3`, reset `v2` as default.
- `test-ec2` EC2 instance: **running**, IP 172.31.22.79, SSM PingStatus=Online. Region ap-south-1.
- No image change pushed to ECR yet.
- No deployed Deployment patched yet.
- No EC2 compute row in deployed RDS yet.

## The uncommitted Dockerfile edit

`.infra/Dockerfile.temporal-worker` working-tree change: adds the AWS CLI v2 + session-manager-plugin install block. **Subagent enhancement**: added `uname -m` switching to support both amd64 (EKS nodes) and arm64 (Apple Silicon local builds). This exceeds the plan's "amd64 only" scope but addresses follow-up #5 in the spec. Recommend keeping.

```bash
git diff .infra/Dockerfile.temporal-worker
```
shows the proposed change.

## How to resume

```bash
cd /Users/zineng/featureScala/ark/.claude/worktrees/temporal-helm-gap-plan
git status                                          # confirm Dockerfile edit still present
git diff .infra/Dockerfile.temporal-worker          # eyeball the change
docker build -f .infra/Dockerfile.temporal-worker -t ark-temporal-worker:probe-aws .  # T1 verify
docker run --rm ark-temporal-worker:probe-aws sh -c 'which aws session-manager-plugin && aws --version'  # verify binaries
git add .infra/Dockerfile.temporal-worker
git commit -m "feature: install aws cli + session-manager-plugin in temporal-worker image for EC2Compute"

# Then T2:
./scripts/ec2-isolation/build-push-temporal-worker.sh    # NOT YET WRITTEN -- T2 step 1 creates it
```

If skipping the local docker build:
```bash
git add .infra/Dockerfile.temporal-worker
git commit -m "feature: install aws cli + session-manager-plugin in temporal-worker image for EC2Compute"
```
T2's `docker build` will validate it anyway when it builds for ECR push.

## Pending design choices (carried over from interactive session)

The user was offered four T1-closure options when the session was compacted:
- (a) Verify docker build locally + commit T1
- (b) Skip local build (T2 builds anyway), commit T1 as-is, proceed to T2
- (c) Revert Dockerfile edit + re-dispatch T1
- (d) Hold

**No decision recorded.** Fresh session should re-offer if relevant.

## Critical files in this work

| File | Purpose |
|---|---|
| `docs/superpowers/specs/2026-05-13-ec2-compute-prod-deploy-design.md` | Why + what + decisions |
| `docs/superpowers/plans/2026-05-13-ec2-compute-prod-deploy.md` | 7 task implementation plan |
| `scripts/ec2-isolation/lib.sh` | Shared k_curl + helpers |
| `scripts/ec2-isolation/preflight.sh` | Read-only sanity checks |
| `scripts/ec2-isolation/register-compute.sh` | T5 |
| `scripts/ec2-isolation/expand-iam-policy.sh` | T3 (committed) |
| `scripts/ec2-isolation/dispatch-session.sh` | T6 |
| `scripts/ec2-isolation/cleanup.sh` | Revert side-effects |
| `scripts/ec2-isolation/patch-worker-creds.sh` | OBSOLETE (IRSA replaced it) — scheduled for delete in T7 |
| `.infra/Dockerfile.temporal-worker` | Edited but uncommitted |

## Branch state

- Branch: `feature/temporal-helm-chart`
- Last pushed commit: `2ab0b8a1` (origin in sync)
- Last 4 commits: spec → IAM policy → plan → ec2-isolation suite
- Working tree: 1 uncommitted file (Dockerfile)

## Environment prereqs verified this session

- `AWS_PROFILE=pai-risk-mlops` fresh until next 8h cycle
- EKS API reachable via `/etc/hosts` ENI pin `10.72.217.51` for `FE31813B454D7EB0B1F97A842603B163.gr7.ap-south-1.eks.amazonaws.com`
- Cluster audit done; results in spec under "Audit results that shaped the design"

## Decision shortcuts (from spec)

- IRSA wins over env-var cred injection (8h expiry, attribution, scope)
- Direct `aws iam create-policy-version` over Terraform PR (probe speed; drift documented as follow-up)
- In-place `kubectl patch` over Helm PR (probe speed; ArgoCD reconciliation = automatic cleanup)
- Tag suffix `<sha>-ec2` over overwriting prod tag

## Reversibility (full chain)

1. `aws iam delete-policy-version --policy-arn arn:aws:iam::880170353725:policy/platform-ark --version-id v3` then `set-default-policy-version v2`
2. `IMAGE_TAG=276fbb07-merged ./scripts/ec2-isolation/bump-worker-image.sh` (once that script exists, T4)
3. `./scripts/ec2-isolation/cleanup.sh --delete-row`
4. `aws ec2 stop-instances --instance-ids i-08b0a5598afefe5a5 --region ap-south-1 --profile pai-risk-mlops`
5. ArgoCD next sync reverts any leftover in-place Deployment patches
