# docs-flow pod-isolation test (design)

**Status:** draft, awaiting review
**Date:** 2026-05-13
**Author:** debugging session for hung docs-flow E2E on `pai-risk-mlops-platform`
**Goal:** Prove (or disprove) that the per-session pod environment can complete a full docs-flow end-to-end -- clone, plan, implement, push, PR -- with **no Temporal, no control-plane RPC, no arkd**. The driver replicates the exact inputs CP would feed to the SDK launcher so the captured contract is reusable when fixing the upstream orchestration path.

## Why this test

Days of E2E iteration have been chasing a hang in dispatch. Symptoms point at one of several layers (Temporal activity timeout, CP `setupSessionWorktree`, arkd `/exec` for git clone, claude-agent SDK, the LLM call). Each rebuild + ArgoCD cycle is ~10 min. We need to isolate "the pod can run the work" from "orchestration is busted" so the next fix has a clear target.

If this test **succeeds** -> pod environment is sound; the bug is upstream (Temporal / CP / arkd). Focus there.

If this test **fails** -> bug is in the SDK / git / model / secrets path; orchestration was a red herring.

Either way we end with a written I/O contract per stage that the Temporal-side fix can target.

## Scope

In scope:
- Replicate the exact env-var and prompt-file inputs that `claudeAgentExecutor.launch()` produces (`packages/core/executors/claude-agent.ts:152-209`).
- Run the SDK launcher (`packages/core/runtimes/claude-agent/launch.ts`) twice in sequence -- once per stage (plan, implement) -- against a real cloned working tree.
- Push the resulting branch to Bitbucket, create a real PR via Bitbucket REST API.
- Capture inputs and outputs per stage in a structured directory.

Out of scope:
- arkd in the pod (we invoke `bun launch.ts` directly).
- CP HTTP / RPC plane (no `session/start`, no hook forwarding back to a conductor URL).
- Temporal workflow.
- Stage gate logic (`gate: auto` is implicit; we drive stages in fixed sequence).
- Failure-retry policy (a stage's non-zero exit is recorded, never retried).

## Architecture

```
single Job pod, image=ark:276fbb07-merged
[driver.sh]
  setup:
    git clone $AUTHED_URL /root/.ark/worktrees/$SID/foundry-test-repo
    git -C ... config user.{name,email}
    pre-approve ~/.claude.json (jq UX flags)
  stage[plan]:
    build inputs (env + task.txt + system-append) ──> /tmp/contract/plan/inputs.json
    bun /app/packages/core/runtimes/claude-agent/launch.ts
        stdout ──> /tmp/contract/plan/stdout.log
        stderr ──> /tmp/contract/plan/stderr.log
        /tmp/ark-$SID/transcript.jsonl ──> /tmp/contract/plan/transcript.jsonl
    capture outputs (exit_code, final_msg, commits) ──> /tmp/contract/plan/outputs.json
  stage[implement]:
    same shape, different prompt + ARK_STAGE
  stage[pr]:
    git push origin HEAD
    curl Bitbucket REST API ──> /tmp/contract/pr/outputs.json
  document:
    write /tmp/contract/CONTRACT.md describing the captured surface
    cat all outputs.json + tree /tmp/contract to stdout for log retrieval
```

No external services beyond:
- Bitbucket (clone + push + PR API)
- TF gateway (the SDK calls it via the bedrock-compat in-process proxy in `launch.ts`)
- AWS SSM (env vars sourced from already-configured secrets)

## Per-stage I/O contract

For each stage (`plan`, `implement`, `pr`), the driver writes the following files under `/tmp/contract/<stage>/`:

| File | Source | Purpose |
|---|---|---|
| `inputs.json` | written by driver before invoking SDK | exact env vars passed, full prompt content, full system_prompt content, workdir state (head sha, branch, file count) |
| `stdout.log` | SDK launcher stdout | proxy startup messages, query lifecycle ("query finished attempt=1 outcome=completed") |
| `stderr.log` | SDK launcher stderr | warnings ("no hook URL"), errors, fatal stack traces |
| `transcript.jsonl` | copied from `$ARK_SESSION_DIR/transcript.jsonl` | full SDKMessage stream (system init, assistant messages, tool calls, result) |
| `outputs.json` | written by driver after SDK exit | `{exit_code, terminal_reason, final_assistant_msg, new_commits: [{sha, message}], total_cost_usd, duration_ms, workdir_after: {head, branch, dirty}}` |

`inputs.json` schema (the contract we hand to the Temporal-fix author):

```json
{
  "stage": "plan",
  "env": {
    "ARK_SESSION_ID": "iso-...",
    "ARK_SESSION_HANDLE": "ark-iso-...",
    "ARK_SESSION_DIR": "/tmp/ark-iso-...",
    "ARK_WORKTREE": "/root/.ark/worktrees/iso-.../foundry-test-repo",
    "ARK_PROMPT_FILE": "/tmp/ark-iso-.../task.txt",
    "ARK_ARKD_URL": "",
    "ARK_STAGE": "plan",
    "ARK_MAX_TURNS": "200",
    "ARK_COMPAT": "bedrock",
    "ARK_TENANT_ID": "default",
    "ANTHROPIC_API_KEY": "dummy",
    "ANTHROPIC_BASE_URL": "https://tfy.../api/llm",
    "ANTHROPIC_CUSTOM_HEADERS": "Authorization: Bearer ..."
  },
  "task_file_content": "...rendered task prompt (matches what CP writes to task.txt)...",
  "system_prompt_append": "...the agent YAML's `system_prompt` field, post-Nunjucks render...",
  "workdir_before": {
    "head": "abc1234",
    "branch": "feat/iso-test-...",
    "file_count": 47,
    "dirty": false
  }
}
```

**Contract fidelity:** task_file_content and system_prompt_append are the two surfaces the SDK actually reads. We render both with the same template helpers CP uses (`buildSessionVars`, `template.render`) so the bytes match what production would produce. Env-var values are the simplified ones we choose for this harness (e.g. ARK_ARKD_URL is empty here because we have no arkd to talk to -- production sets it to localhost:19300 but the SDK only uses it for hook forwarding which we have disabled).

## Driver structure

`driver.sh`, ~200 lines bash, base64-embedded into a Kubernetes Job manifest. Sections:

1. **setup** -- env summary, clone (with auth from SSM secret), git identity, jq pre-approve ~/.claude.json
2. **run_stage(name, agent_yaml_path)** -- function that:
   - resolves agent's `system_prompt` via a small bun one-liner that runs nunjucks against the planner/worker YAMLs in `/app/agents/`
   - builds the task prompt deterministically from the test session vars
   - writes inputs.json
   - exports env vars
   - invokes `bun /app/packages/core/runtimes/claude-agent/launch.ts`
   - copies transcript.jsonl
   - parses outputs (exit code, last assistant message, new commits via `git log` diff) into outputs.json
3. **stage plan** -- `run_stage plan /app/agents/planner.yaml`
4. **stage implement** -- `run_stage implement /app/agents/worker.yaml`
5. **stage pr** -- `git push` + Bitbucket REST API call; captures PR URL into outputs.json
6. **finalize** -- write CONTRACT.md describing the contract, print tree + cat all outputs.json to stdout

## Failure handling

- Each stage's non-zero exit is recorded in `outputs.json` but the driver continues to the next stage (we want a full snapshot, not bail-on-first).
- If a stage produces zero new commits when commits were expected, that is recorded as a flag but is not itself a stop condition.
- The final summary prints a one-line-per-stage table:

  ```
  plan       exit=0  commits=1  terminal=completed  cost=$0.035
  implement  exit=0  commits=1  terminal=completed  cost=$0.142
  pr         exit=0  url=https://bitbucket.org/.../pull-requests/N
  ```

- Pod exits with code = number of stages whose `exit_code != 0`, so a green run is exit 0.

## Test session identity

Deterministic per run:

- session_id `iso-<short-timestamp>` (e.g. `iso-20260513t1630`)
- branch `feat/iso-test-<timestamp>` (avoid collisions with prior runs)
- summary `Add one paragraph to architecture.md`
- ticket `null` (the docs flow does not require one)
- repo `https://bitbucket.org/paytmteam/foundry-test-repo`

These map onto the Nunjucks template variables (`{{workdir}}`, `{{repo}}`, `{{branch}}`, `{{summary}}`, `{{ticket}}`) which both agent YAMLs reference.

## Iteration speed budget

- One run = `clone + 2 SDK invocations + push + PR call` -> ~3-5 minutes total.
- No image rebuild required. Same `ark:276fbb07-merged` already in cluster.
- Driver edits are local -> re-base64 -> POST a new Job. ~30 seconds per iteration.

## Open questions

1. **Branch naming when push fails.** If a previous run left `feat/iso-test-...` on origin, the second push could fail with "non-fast-forward". Mitigation: include the per-run timestamp in the branch name. (Decided.)
2. **PR title and body.** The flow's `pr` action stage normally derives these from the planner output. For the isolation test, the driver picks a deterministic title -- e.g. `Isolation test: add one paragraph to architecture.md`.
3. **Concurrent runs.** Only one isolation Job at a time; the script names the Job with the timestamp suffix so concurrent runs do not collide on the pod name.

## Success criteria

- All three stages reach exit_code 0.
- After implement stage, `git log --oneline -2` on the working branch shows two new commits (one from planner, one from worker).
- After pr stage, outputs.json contains a real Bitbucket PR URL accessible via `curl`.
- /tmp/contract/CONTRACT.md exists and documents inputs+outputs for each stage.

## Follow-on work after this test

(out of scope for the isolation test itself, but recorded so the contract is useful):

1. If isolation passes -> next investigation focuses on Temporal/CP. Use the captured inputs as the expected payload Temporal should feed to the per-session pod.
2. If isolation fails -> the per-stage logs identify exactly which step (clone / launch / SDK / git push / PR) broke, and we fix that in-pod without touching Temporal.
