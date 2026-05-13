# docs-flow pod isolation test

Runs the docs flow end-to-end inside a single Kubernetes Job pod, with **no
Temporal, no control-plane RPC, no arkd**. The pod replicates the exact inputs
CP would feed to the claude-agent SDK launcher, captures inputs/outputs per
stage, and produces a real Bitbucket PR as proof.

Useful for two things:

1. **Isolation debugging.** When the production E2E hangs, run this. If it
   succeeds, the per-session pod environment is fine and the bug is upstream
   (Temporal / CP / arkd). If it fails, the captured stage logs tell you
   exactly which step (clone / launch / SDK / git push / PR) broke.
2. **Reproducer.** Same scripts, same image, same contract every time. Diff
   `out/<run-id>/contract/` across runs to spot regressions.

## How it works

```
laptop run.sh:                              cluster Job pod:
  build Job manifest                ─POST─▶ driver.sh
  poll until pod terminal                     setup: git clone + identity
  pull pod log -> out/<run-id>/             stage[plan]:     render + launch.ts
                                            stage[implement]: render + launch.ts
                                            stage[pr]:       push + BB API
                                            finalize: write CONTRACT.md
```

The driver invokes `bun /app/packages/core/runtimes/claude-agent/launch.ts`
directly per stage (same code production uses). It does NOT use arkd. Hook
forwarding is disabled (`ARK_ARKD_URL` and `ARK_CONDUCTOR_URL` unset), the
launcher just logs a warning and continues.

## Prerequisites

- `aws` CLI configured with profile that can reach the cluster (default:
  `pai-risk-mlops`).
- `kubectl` not required (we go via curl+bearer to bypass Zscaler).
- SSM has all `/ark/default/*` keys populated (BITBUCKET_TOKEN, BITBUCKET_USERNAME,
  ANTHROPIC_API_KEY=dummy, ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS).
- ECR has `ark:<TAG>` (default tag `276fbb07-merged` -- override via `--image-tag`).

## Run

```bash
# one-time setup
cp scripts/pod-isolation/fixtures/env.example .env.iso
# edit .env.iso if your cluster / repo differs from the defaults

# every run
./scripts/pod-isolation/run.sh \
  --summary "Add one paragraph to architecture.md" \
  --repo "https://bitbucket.org/paytmteam/foundry-test-repo"
```

On success you get:

```
out/iso-<timestamp>/contract/
├── plan/
│   ├── inputs.json       # exact env + prompt content fed to SDK
│   ├── outputs.json      # exit code, terminal_reason, new commits, cost
│   ├── stdout.log        # SDK launcher stdout
│   ├── stderr.log        # SDK launcher stderr
│   └── transcript.jsonl  # full SDKMessage stream
├── implement/
│   └── (same shape)
├── pr/
│   └── outputs.json      # PR URL or error
└── CONTRACT.md           # human-readable summary
```

The final stdout line prints the PR URL on success.

## Artifacts to commit upstream

A successful contract dir is the spec for what the Temporal/CP path must
produce. Copy `out/<run-id>/contract/` to `docs/contracts/<date>-<topic>/` if
the run is canonical.
