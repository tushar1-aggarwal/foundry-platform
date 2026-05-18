# Pod-isolation E2E test — handoff (2026-05-13)

Context exhausted mid-session. This doc lets a fresh session resume.

## Where we stopped

Per-session pod isolation test (`scripts/pod-isolation/`) is **working for the two agent stages**. The PR creation block is still a bash-curl-to-Bitbucket-API hack — needs to be swapped for the **production code path** (`createWorktreePR` from `packages/core/services/worktree/pr.ts`).

## What works

- **plan stage** — `bun launch.ts` runs in pod, agent commits PLAN.md, exit=0, terminal=`completed`, ~1 commit added
- **implement stage** — same shape, ~1 commit added
- **Driver/scripts/CM/Job mount/log-retrieval** — all proven
- **harinder-key JWT + haiku tf-bedrock slug + bedrock-compat proxy** — proven end-to-end via TF gateway
- **Authed git clone + push** — proven (bitbucket via `x-bitbucket-api-token-auth:<token>@`)

## What's broken / unfinished

- **`pr` stage**: driver.sh uses raw curl to bitbucket API → HTTP 400. We need to invoke the real production logic.
- **Production path** is `executeAction('create_pr')` → `createPrAction.execute()` → `createWorktreePR(app, sid, opts)` from `packages/core/services/worktree/pr.ts:322`.
- For bitbucket the production path is **push-only** + parse "Create-PR URL" from push stderr (see `parseCreatePrUrl` at `pr.ts:238` and `fallbackBranchUrl` at `pr.ts:255-276`). It does NOT create a real PR via REST API for BB — only for GitHub.

## Immediate next task

Write `scripts/pod-isolation/do-pr-stage.ts` that:

1. Imports leaf functions from `packages/core/services/worktree/pr.ts`:
   - `detectGitHost(url)` — pure, returns "github"|"bitbucket"|"gitlab"|"unknown"
   - `parseCreatePrUrl(stderr)` — pure, extracts Create-PR URL from push stderr
   - `fallbackBranchUrl(host, url, branch)` — pure, builds a branch URL fallback
2. Does `git remote set-url origin <authed>` + `git push -u origin <branch>` via `execFileSync` (NOT shell exec)
3. Captures push stderr
4. For bitbucket: applies `parseCreatePrUrl` → falls back to `fallbackBranchUrl`
5. Outputs `{pr_url, host, branch, push_exit, terminal_reason}` JSON to stdout

Then swap driver.sh's PR block to:

    bun /opt/iso/do-pr-stage.ts > "$stage_dir/outputs.json" 2> "$stage_dir/stderr.log"

(No need to construct a fake AppContext — we're using only the pure helpers, not `createWorktreePR` directly. This is faithful to production logic.)

## File pointers

| File | What |
|---|---|
| `scripts/pod-isolation/driver.sh` | runs in Job pod; setup → plan → impl → pr → finalize |
| `scripts/pod-isolation/render-prompt.ts` | bun: agent yaml → system_prompt + task prompt JSON envelope; NOTE: has uncommitted local mods (fix for dynamic import path) |
| `scripts/pod-isolation/run.sh` | laptop: builds Job + ConfigMap, posts, polls, pulls log into `out/<run-id>/contract/` |
| `scripts/pod-isolation/fixtures/env.example` | env contract |
| `scripts/pod-isolation/fixtures/expected/CONTRACT.md.tmpl` | per-run output template |
| `scripts/pod-isolation/README.md` | how to run |
| `docs/superpowers/specs/2026-05-13-docs-flow-pod-isolation-design.md` | design doc with full spec |
| `packages/core/services/worktree/pr.ts:54,238,255,322` | production PR-creation logic to import |

## Uncommitted local edits

```
M scripts/pod-isolation/driver.sh
M scripts/pod-isolation/render-prompt.ts
```

The `render-prompt.ts` mod is the fix for the dynamic import path bug found in run 1 — uses `ARK_TEMPLATE_MODULE` env override → defaults to `/app/packages/core/template.ts` (absolute path in pod). Verified working in run 2 (both stages succeeded).

The `driver.sh` mod is the latest version that was running successfully (combined user + assistant edits).

**Commit these before the next run.**

## Cluster state

- Image: `ark:276fbb07-merged` (deployed to CP, worker, temporal-worker, and docs-k8s template)
- DB `resource_definitions` for planner/worker: `runtime: claude-agent`, no model field (uses catalog default which routes through bedrock-compat proxy → haiku slug works)
- SSM: `/ark/default/ANTHROPIC_*` and `/ark/default/BITBUCKET_*` populated with harinder-key JWT + foundry BB token
- Branch `feature/temporal-helm-chart` synced with origin (subagent merge confirmed Already up to date)

## How to resume

    cd /Users/zineng/featureScala/ark/.claude/worktrees/temporal-helm-gap-plan
    git status                # commit the M files first if needed
    ./scripts/pod-isolation/run.sh \
      --summary "Add one paragraph to architecture.md" \
      --repo "https://bitbucket.org/paytmteam/foundry-test-repo"
    # inspect out/iso-<ts>/contract/

After writing `do-pr-stage.ts`, re-run and verify `pr/outputs.json` has a non-empty `pr_url`.

## Success criteria (from spec)

- ✅ plan stage exit=0, commits ≥1
- ✅ implement stage exit=0, commits ≥1
- ❌ pr stage exit=0, pr_url populated  ← **this is what's left**
- ✅ CONTRACT.md generated

When all 3 stages green, the contract dir `out/<run-id>/contract/` is the spec for upstream Temporal/CP debugging.
