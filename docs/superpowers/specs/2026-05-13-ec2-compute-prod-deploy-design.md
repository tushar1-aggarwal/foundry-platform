# EC2 compute in deployed prod CP (design)

**Status:** draft, ready to execute
**Date:** 2026-05-13
**Author:** debugging session for hung docs-flow E2E on `pai-risk-mlops-platform`
**Plan:** [`docs/superpowers/plans/2026-05-13-ec2-compute-prod-deploy.md`](../plans/2026-05-13-ec2-compute-prod-deploy.md)

## Goal

Make the EC2-compute code path operable in the deployed control-plane on `pai-risk-mlops-platform` EKS, end-to-end for **one** docs-flow session targeting an existing EC2 host. The session reaches a terminal state with enough telemetry to compare against the current K8s `docs-k8s` path that is hanging in prod.

If the EC2 session **succeeds end-to-end** -> the docs-k8s hang is K8s-pod-spawn-specific (kubelet, image pull, in-pod arkd boot, kubectl exec / port-forward). Next fix target: `K8sCompute.provision` and the per-session-pod readiness loop.

If the EC2 session **hangs at the same `git clone` step** -> the bug is in arkd's `/exec` fork (or git itself under specific conditions), not in the per-session-pod orchestration. Next fix target: arkd `/exec` route + how it spawns git.

Either way, this A/B converts "the docs-flow hangs" into a localized fault on one substrate.

## Why this work

The pod-isolation test (`scripts/pod-isolation/`, separate spec) already proved the **agent + claude-agent runtime + bedrock proxy + Bitbucket auth** all work in K8s. That ruled out the SDK / model / secrets / git-auth layers. The remaining suspects are:

- per-session pod provisioning (kubelet, image pull, pod-ready gate)
- arkd boot inside the per-session pod
- `kubectl exec` / `kubectl port-forward` transport
- the deployed CP's `K8sCompute.setupTransport` ordering invariants
- arkd `/exec` fork semantics (the route that runs git clone)

Switching to EC2 swaps the **first four** for SSM transport + native-binary arkd while keeping the fifth identical. That is the only single A/B that can disambiguate "the K8s-mediated environment is wrong" from "arkd/git is wrong".

A laptop-side EC2 run is happening in parallel (another agent). The deployed-side EC2 run is needed to rule out laptop-specific differences (different aws cli on PATH, different env vars, different Bun version).

## Deliverables (checked into the repo)

Under `scripts/ec2-isolation/`:

1. **`expand-iam-policy.sh`** — adds `ec2:Describe*/Start*/Stop*` and `ssm:DescribeInstanceInformation/DescribeSessions/StartSession/TerminateSession` statements to the deployed `platform-ark` IAM policy via `aws iam create-policy-version --set-as-default`. Idempotent (skips if all actions present). Self-prunes oldest non-default version at the 5-version limit. (T3 in plan)
2. **`build-push-temporal-worker.sh`** — builds `.infra/Dockerfile.temporal-worker` and pushes to ECR with tag `<short-sha>-ec2` so the prod `276fbb07-merged` tag is not clobbered. (T2 in plan)
3. **`bump-worker-image.sh`** — strategic-merge patches the deployed `temporal-worker` Deployment to a new image tag and waits for rollout. (T4 in plan)
4. **`probe-irsa-ssm.sh`** — one-shot pod that verifies, in a single shot: `aws cli` + `session-manager-plugin` on PATH, `aws sts get-caller-identity` returns the `platform-ark` role (IRSA token projected), and `aws ssm describe-instance-information` against `test-ec2` succeeds. (T4 in plan)
5. **`verify-session.sh <session-id>`** — polls the deployed RDS for a session's status + last 10 events. (T6 in plan)

Modified:

6. **`.infra/Dockerfile.temporal-worker`** — adds an `aws cli v2` + `session-manager-plugin` install block. (T1 in plan)

Already exists, reused as-is (from commit `4bd6551a`):

7. `scripts/ec2-isolation/lib.sh` — shared k_curl + pod-wait helpers
8. `scripts/ec2-isolation/preflight.sh` — pre-flight read-only checks
9. `scripts/ec2-isolation/register-compute.sh` — inserts the EC2 compute row in deployed RDS (T5 in plan)
10. `scripts/ec2-isolation/dispatch-session.sh` — Job-in-cluster fires WS `session/start` (T6 in plan)
11. `scripts/ec2-isolation/cleanup.sh` — reverts EKS-side changes

To be deleted at the end of execution:

12. `scripts/ec2-isolation/patch-worker-creds.sh` — env-var credential injection. Obsolete: IRSA replaces it. (T7 in plan)

## Scope

In scope:

- One image rebuild of `ark-temporal-worker` with `aws cli v2 + session-manager-plugin` baked in.
- ECR push under a probe-distinct tag (`<sha>-ec2`).
- Direct expansion of the `platform-ark` IAM policy via `aws iam create-policy-version` (not Terraform).
- In-place `kubectl patch` of the `temporal-worker` Deployment image (not Helm values PR).
- One EC2 compute row inserted into the deployed RDS, pointing at the already-running `test-ec2` (`i-08b0a5598afefe5a5`, ap-south-1).
- One probe session dispatched against `compute_name=test-ec2`.
- An A/B verdict doc.

Out of scope (explicit, documented as follow-ups):

- IaC backfill of the IAM policy expansion. Drift is accepted; the plan documents the follow-up.
- Helm values PR for the new temporal-worker image tag.
- Adding `aws cli + smp` to the main `Dockerfile` (CP image). Defensive only; CP doesn't initiate SSM today.
- Pre-warm EC2 pool. One instance is sufficient for an A/B probe.
- VPC interface endpoints for `ssm`/`ssmmessages`/`ec2messages`. NAT path already works (audit confirmed); endpoints are a nice-to-have for Zscaler-MITM resilience.
- arm64 image variant. The aws cli + smp install URLs in the Dockerfile are amd64-pinned.
- Cost / billing tagging on the EC2.
- Production migration of docs-flow from `docs-k8s` to EC2 compute. This is a probe, not a production cutover.

## Audit results that shaped the design (2026-05-13)

Read-only audit of `pai-risk-mlops-platform` (account 880170353725, region ap-south-1) found:

| Capability | State | Implication |
|---|---|---|
| EKS OIDC provider | ✅ live (`FE31813B454D7EB0B1F97A842603B163`) | IRSA usable |
| `ark` ServiceAccount IRSA annotation | ✅ → `arn:aws:iam::880170353725:role/platform-ark` | No new role needed |
| All 3 ark Deployments (CP, ark-worker, temporal-worker) use SA `ark` | ✅ | Policy expansion grants perms to all of them at once |
| NAT egress to `ssm.ap-south-1.amazonaws.com` | ✅ (got `AccessDeniedException`, not network error) | SSM control plane reachable; Zscaler not MITM'ing this regional endpoint |
| `aws` cli + `session-manager-plugin` in images | ❌ both missing | Image rebuild required |
| `platform-ark` policy contents | S3 + Parameter Store + KMS only — no EC2 or SSM-Session-Manager | Policy expansion required |
| VPC endpoints for SSM | ❌ none (only S3 endpoint) | NAT path used; not a blocker |
| EC2 `test-ec2` reachability | ✅ running, SSM Online, private IP 172.31.22.79 | Reusable target — no fresh provision needed |

## Key design decisions

### 1. IRSA over env-var credential injection

**Decision:** Grant the temporal-worker pod AWS perms by expanding the IAM role already bound to its ServiceAccount via IRSA, rather than injecting `AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN` env vars from the operator's SSO session into a Secret.

**Alternative considered:** Operator's-SSO env-var injection (`patch-worker-creds.sh`, written and then dropped).

**Why IRSA wins:**
- 8h expiry of SSO tokens vs. auto-rotating IRSA tokens. After expiry, AWS SDK calls fail with `ExpiredToken` and the worker pod silently breaks.
- IRSA tokens are scoped to `platform-ark`'s specific perms, not the operator's full `PaiRiskSRE` role.
- CloudTrail attribution: IAM role identity vs. operator's identity. Cleaner audit.
- No per-Deployment patch required (originally `patch-worker-creds.sh` had a bug — targeted `ark-worker` instead of `temporal-worker`; IRSA bypasses the whole issue because both Deployments use SA `ark`).
- One-shot AWS call vs. ongoing maintenance (re-injecting every 8h).

**Cost:** Modifies the shared `platform-ark` IAM policy directly (not via Terraform), creating drift. Mitigation: documented as a follow-up to backfill into IaC.

### 2. Direct `aws iam create-policy-version` vs. Terraform PR

**Decision:** Apply the IAM expansion via `aws iam create-policy-version --set-as-default` directly.

**Alternative:** Find the Terraform module that owns `platform-ark`, open a PR, wait for review + apply.

**Why direct call wins for this probe:**
- Probe-grade work — minutes vs. hours/days.
- Reversible: delete the new version, reset old as default. Zero-impact rollback.
- The session-mutation surface this probe exercises is small enough that the perm grant is narrow.
- Backfilling to IaC is straightforward once the AWS-side change is known to work.

**Cost:** Drift between AWS console state and Terraform state. Until backfilled, the next `terraform apply` reverts the change. Mitigation: explicit follow-up in the plan + this spec.

### 3. In-place `kubectl patch` vs. Helm values PR for the image bump

**Decision:** Patch the `temporal-worker` Deployment's image directly via the K8s API.

**Alternative:** Open a PR to pi-risk-mlops Helm values, merge, wait for ArgoCD to sync.

**Why direct patch wins for this probe:**
- Helm PR + ArgoCD sync round-trip is ~15-20 min minimum.
- ArgoCD will revert the in-place patch on next reconcile, which is exactly what we want for cleanup — automatic.
- Same risk profile as bumping for production (one Deployment, one image tag, rollout-monitored).

**Cost:** None significant. ArgoCD reverting the patch is the cleanup mechanism, not a problem.

### 4. Probe tag `<sha>-ec2` vs. overwriting `<sha>-merged`

**Decision:** Push the new image to ECR under a distinct tag suffix.

**Why:**
- Avoids any chance of K8s pulling our debug image for a session that doesn't want it.
- Distinguishes "with aws+smp" from "stock prod" in audit and rollback paths.
- Cheap (ECR storage is trivial for the image's size).

### 5. Reuse `test-ec2` vs. fresh provision

**Decision:** Attach to the existing running `i-08b0a5598afefe5a5` via `EC2Compute.attachExistingHandle`.

**Why:**
- Already cloud-init-installed with `arkd`, `bun`, git, claude — no setup cost.
- Already SSM-registered (`PingStatus: Online`).
- Already configured (matches local laptop `test-ec2` row, so behavior parity with the laptop A/B).
- Cold-provision via `EC2Compute.provision` is minutes; reuse is zero.

### 6. Bail-out: Path C (route at ark-worker arkd) if SSM egress is blocked

**Decision:** If the audit's `aws ssm describe-instance-information` probe had returned a TLS error or connection reset (vs. the `AccessDeniedException` it actually did), we would have abandoned this plan and pivoted to Path C — change the docs-flow's `compute_name` from `docs-k8s` to a new `local-pool` compute that routes at the in-cluster `ark-worker` arkd Deployment. No AWS, no SSM, no image rebuild.

The audit confirmed SSM egress works, so this bail-out is NOT triggered. But Path C remains documented as the fallback if any downstream task discovers a blocker.

## Architecture / control flow

```
┌──────────────────────────── EKS cluster (deployed) ───────────────────────────┐
│                                                                               │
│  laptop ─WS:19100─► ark-control-plane (image ark:276fbb07-merged)             │
│                       │ schedule wf                                           │
│                       ▼                                                       │
│  ★ temporal-worker (NEW image ark-temporal-worker:<sha>-ec2)                  │
│   │   ▸ aws cli v2 + session-manager-plugin baked in                          │
│   │   ▸ SA=ark → IRSA → platform-ark (NEW perms: ec2:* + ssm:*Session*)       │
│   │                                                                           │
│   │  Activity per session:                                                    │
│   │   ├─ resolveComputeTarget → EC2Compute (lookup compute_name=test-ec2)     │
│   │   ├─ attachExistingHandle → reads instance_id from compute.config          │
│   │   ├─ setupTransport ────spawn("aws ssm start-session                      │
│   │   │                          --document AWS-StartPortForwardingSession")  │
│   │   │                          on localhost:<rnd>                           │
│   │   ├─ ensureReachable curl localhost:<rnd>/health → 200                    │
│   │   ├─ runGit clone authed_url … (via ArkdClient.run /exec → EC2's arkd)    │
│   │   ├─ /process/spawn bun launch.ts (claude-agent on EC2)                   │
│   │   └─ createWorktreePR → push + parse                                      │
│   │                                                                           │
│   └─ ark-worker Deployment (untouched; long-lived local-arkd pool;            │
│      not used by EC2 path)                                                    │
└───────────────────────────────────────────┬───────────────────────────────────┘
                                            │ SSM tunnel via session-manager-plugin
                                            ▼
                ┌──── EC2 test-ec2 (ap-south-1, i-08b05598afefe5a5) ────┐
                │   cloud-init pre-installed: aws-cli, bun, git, arkd   │
                │   systemd unit running: arkd :19300                   │
                │   IAM: AmazonSSMManagedInstanceCore (SSM agent online)│
                │   Receives /exec → fork(git clone …) and /process/spawn │
                └────────────────────────────────────────────────────────┘
```

## Success criteria

A docs-flow session dispatched with `compute_name=test-ec2` from the deployed CP:

1. Persists in the deployed `sessions` table with `compute_name=test-ec2`.
2. Reaches a terminal state (`closed`, `failed`, or remains in `running` past a 10-minute hang window).
3. Produces `session_events` rows that show which stage was reached and where time was spent.
4. The temporal-worker pod log corroborates the events (no silent failures).

Pass states for the A/B:

- **EC2 path runs end-to-end** (`status=closed`, all stages complete) → bug is K8s-specific. Document and unblock K8s investigation.
- **EC2 path hangs at the same place** (`stage=setup_workspace` with `git clone` last event) → bug is arkd/git layer. Document and unblock arkd investigation.
- **EC2 path fails differently** (e.g., `SSM agent timeout`, `permission denied` on EC2-side) → not informative for the K8s hang; investigate the EC2-side error separately.

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `aws iam create-policy-version` racing with a Terraform apply | low | High (lost perms mid-probe) | Time-bounded probe window; document drift; tell platform team if they're about to run Terraform |
| `temporal-worker` image rollout breaks something else (other activities) | low | Medium (other deployed flows fail) | Same image with strictly MORE packages installed; nothing removed; should be a pure superset |
| ECR image push fails due to Zscaler MITM | low | Medium (probe can't proceed) | We've pushed images to this ECR before in this branch; pattern is known to work |
| `test-ec2` instance is stopped at probe time | medium | Low (just start it) | `preflight.sh` checks; restart is ~30s |
| `test-ec2` instance arkd is dead (cloud-init failed long ago) | medium | Medium (no health response) | `probe-irsa-ssm.sh` step 5 catches; SSH in + `systemctl status arkd` |
| SSM port-forward latency > arkd-probe budget (default ~30s) | low | Medium (false-positive failure) | EC2Compute has a 60s arkd-probe budget; should be enough |
| Tokens for Bitbucket auth expire mid-session | low | High (clone fails) | Ark SSM parameters are populated; `BITBUCKET_TOKEN` is a foundry token (not user SSO) |
| Multiple subagents racing on git index | medium | Low (one task fails, retry) | We do NOT dispatch implementer subagents in parallel for tasks that commit (T1 + T3 are file-disjoint and safe; T2 sequenced after T1) |
| AWS SSO creds expire mid-execution (operator's session) | medium | Medium (mid-script AWS call fails) | All scripts cache the token, but `aws sso login` needed if 8h crosses; we're well within window |

## Reversibility

Every change is reversible. The cleanup chain:

1. `aws iam delete-policy-version --policy-arn arn:aws:iam::880170353725:policy/platform-ark --version-id v3` then `set-default-policy-version v2` → IAM back to original 4 SIDs.
2. `bump-worker-image.sh` with `IMAGE_TAG=276fbb07-merged` → temporal-worker back to prod tag.
3. `cleanup.sh --delete-row` → EC2 compute row deleted from RDS.
4. `aws ec2 stop-instances --instance-ids i-08b0a5598afefe5a5` → EC2 host idle (free).
5. ArgoCD next sync → reverts any remaining in-place Deployment patches.

## How to run

See the plan: [`docs/superpowers/plans/2026-05-13-ec2-compute-prod-deploy.md`](../plans/2026-05-13-ec2-compute-prod-deploy.md).

Critical path: T1 (Dockerfile) → T2 (build+push) → T4 (bump+probe). T3 (IAM) is parallel with T1. T5 (compute row) is parallel with T4 once T4's image is verified. T6 (dispatch session) is the verdict gate.

## Open questions

None — every blocker identified by the cluster audit has been resolved by a task in the plan. The first question the probe itself will answer is "does the EC2 path reach a terminal state and where".

## Follow-ups (out of scope of this spec; tracked separately if the A/B is conclusive)

1. Backfill the `platform-ark` policy expansion into the Terraform module that owns the role.
2. Open a Helm values PR to pi-risk-mlops if the temporal-worker image with `aws cli + smp` becomes the new baseline.
3. Add `aws cli + smp` to the main `Dockerfile` (CP image) for defense-in-depth.
4. Add VPC interface endpoints for `ssm`, `ssmmessages`, `ec2messages` to remove the NAT-path Zscaler dependency.
5. Productionise the EC2 pool — multiple warm instances, billing tags, per-tenant isolation knobs.
6. arm64 image variants if/when the worker image moves off amd64.
