#!/bin/bash
# pod-isolation driver -- runs INSIDE a Kubernetes Job pod on the ark image.
#
# Replicates the production docs-flow in-process: clone -> plan stage -> impl
# stage -> push -> create PR -> write contract artifacts to /tmp/contract/.
# No arkd, no CP, no Temporal. Inputs match `claudeAgentExecutor.launch()` so
# the captured contract is reusable for fixing the upstream orchestration path.
#
# Env in (pod-injected by run.sh via the Job spec):
#   ARK_IMAGE_TAG              (informational; image is already set on the pod)
#   ISO_SESSION_ID             e.g. iso-20260513t1635
#   ISO_BRANCH                 deterministic feature branch name
#   ISO_REPO                   bitbucket https URL (no auth in URL; we add it)
#   ISO_SUMMARY                e.g. "Add one paragraph to architecture.md"
#   ISO_TICKET                 optional, may be empty
#   ISO_MODEL                  provider-qualified slug, e.g. pi-agentic/global....haiku
#   BITBUCKET_TOKEN            from SSM via secretKeyRef
#   BITBUCKET_USERNAME         from SSM
#   ANTHROPIC_API_KEY          "dummy"
#   ANTHROPIC_BASE_URL         TF gateway base
#   ANTHROPIC_CUSTOM_HEADERS   "Authorization: Bearer <jwt>"
#
# Layout produced in pod:
#   /tmp/contract/<stage>/{inputs.json,outputs.json,stdout.log,stderr.log,transcript.jsonl}
#   /tmp/contract/CONTRACT.md
#
# Stage exit codes are recorded but never abort the driver -- we want a full
# snapshot even when stages fail. Final driver exit code = number of failed
# stages (0 == all green).

set -uo pipefail

# ── helpers ─────────────────────────────────────────────────────────────────
log() { echo "[$(date -u +%H:%M:%SZ)] $*" >&2; }
require() { for v in "$@"; do [ -n "${!v:-}" ] || { log "MISSING ENV: $v"; exit 2; }; done; }

require ISO_SESSION_ID ISO_BRANCH ISO_REPO ISO_SUMMARY ISO_MODEL \
        BITBUCKET_TOKEN BITBUCKET_USERNAME \
        ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS

CONTRACT_DIR="/tmp/contract"
WORKTREES_DIR="/root/.ark/worktrees"
WORKDIR="${WORKTREES_DIR}/${ISO_SESSION_ID}/foundry-test-repo"
mkdir -p "$CONTRACT_DIR" "$WORKTREES_DIR"

# Inject BB auth into clone URL. URL-encode trivially -- the token is opaque
# and `x-bitbucket-api-token-auth` is the literal Atlassian REST username for
# scoped API tokens.
HOST="${ISO_REPO#https://}"
AUTHED_URL="https://x-bitbucket-api-token-auth:${BITBUCKET_TOKEN}@${HOST}"

# ── setup ───────────────────────────────────────────────────────────────────
log "=== setup ==="
log "session_id=$ISO_SESSION_ID branch=$ISO_BRANCH"
log "workdir=$WORKDIR"
log "repo=$ISO_REPO summary=$ISO_SUMMARY"
log "model=$ISO_MODEL"
log "image tag=${ARK_IMAGE_TAG:-(unknown)}"

# Pre-approve Claude UX state so SDK skips the first-run dialogs (we don't have
# a TTY here). Mirrors packages/core/claude/launcher.ts preAcceptBlock.
KH=""
if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${#ANTHROPIC_API_KEY}" -ge 20 ]; then
  KH="${ANTHROPIC_API_KEY: -20}"
fi
echo '{}' | jq --arg dir "$WORKDIR" --arg keyHash "$KH" '
  .hasCompletedOnboarding=true
  | .bypassPermissionsModeAccepted=true
  | .projects = ((.projects // {}) | .[$dir] = ((.[$dir] // {}) | .hasTrustDialogAccepted=true | .enableAllProjectMcpServers=true))
  | (if $keyHash == "" then . else
       .customApiKeyResponses = ((.customApiKeyResponses // {approved:[],rejected:[]})
         | .approved = (((.approved // []) - [$keyHash]) + [$keyHash]))
     end)
' > "$HOME/.claude.json"

# Clone (authed URL). git terminal prompt off so any auth failure surfaces
# fast instead of hanging.
log "cloning $ISO_REPO into $WORKDIR"
GIT_TERMINAL_PROMPT=0 git clone "$AUTHED_URL" "$WORKDIR" 2>&1 | sed 's/^/[git clone] /'
if [ ! -d "$WORKDIR/.git" ]; then
  log "FATAL: clone produced no .git dir; aborting"
  exit 3
fi

# Identity (commits need an author)
git -C "$WORKDIR" config user.name "ark-isolation"
git -C "$WORKDIR" config user.email "ark-isolation@paytm.com"

# Cut feature branch deterministically
DEFAULT_BRANCH=$(git -C "$WORKDIR" symbolic-ref --short HEAD)
log "default branch=$DEFAULT_BRANCH"
git -C "$WORKDIR" checkout -b "$ISO_BRANCH" 2>&1 | sed 's/^/[git branch] /'

INITIAL_HEAD=$(git -C "$WORKDIR" rev-parse HEAD)
log "initial head=$INITIAL_HEAD"

# ── stage runner ────────────────────────────────────────────────────────────
# run_stage <stage-name> <agent-yaml-path>
# Writes:
#   $CONTRACT_DIR/<stage>/inputs.json
#   $CONTRACT_DIR/<stage>/stdout.log
#   $CONTRACT_DIR/<stage>/stderr.log
#   $CONTRACT_DIR/<stage>/transcript.jsonl
#   $CONTRACT_DIR/<stage>/outputs.json
run_stage() {
  local stage="$1" agent_yaml="$2"
  local stage_dir="$CONTRACT_DIR/$stage"
  mkdir -p "$stage_dir"
  log "=== stage[$stage] ==="

  # Render the agent's system_prompt + the task prompt via the same code path
  # CP uses. render-prompt.ts is shipped alongside driver.sh by run.sh.
  local rendered
  rendered=$(bun /opt/iso/render-prompt.ts \
    "$agent_yaml" "$stage" \
    --session-id "$ISO_SESSION_ID" \
    --workdir "$WORKDIR" \
    --repo "$ISO_REPO" \
    --branch "$ISO_BRANCH" \
    --summary "$ISO_SUMMARY" \
    --ticket "${ISO_TICKET:-}" \
    --runtime-yaml "/app/runtimes/claude-agent.yaml") \
    || { log "render-prompt.ts failed"; echo "{}" > "$stage_dir/outputs.json"; return 4; }

  local system_append task_prompt
  system_append=$(echo "$rendered" | jq -r .system_prompt_append)
  task_prompt=$(echo "$rendered" | jq -r .task_prompt)

  # Session-scratch dir the SDK uses for transcript.jsonl + intervention-tail
  local session_dir="/tmp/ark-${ISO_SESSION_ID}-${stage}"
  local prompt_file="$session_dir/task.txt"
  mkdir -p "$session_dir"
  printf '%s' "$task_prompt" > "$prompt_file"

  # Workdir snapshot BEFORE
  local before_head before_dirty
  before_head=$(git -C "$WORKDIR" rev-parse HEAD)
  before_dirty=$([ -z "$(git -C "$WORKDIR" status --porcelain)" ] && echo false || echo true)

  # Build inputs.json -- the contract surface CP would also emit
  jq -n \
    --arg stage "$stage" \
    --arg session_id "$ISO_SESSION_ID" \
    --arg session_dir "$session_dir" \
    --arg workdir "$WORKDIR" \
    --arg prompt_file "$prompt_file" \
    --arg system_append "$system_append" \
    --arg task_prompt "$task_prompt" \
    --arg model "$ISO_MODEL" \
    --arg tenant "default" \
    --arg max_turns "200" \
    --arg compat "bedrock" \
    --arg before_head "$before_head" \
    --arg before_branch "$ISO_BRANCH" \
    --arg before_dirty "$before_dirty" \
    --arg base_url "$ANTHROPIC_BASE_URL" \
    --arg headers_prefix "${ANTHROPIC_CUSTOM_HEADERS:0:35}..." \
    '{
      stage: $stage,
      env: {
        ARK_SESSION_ID: $session_id,
        ARK_SESSION_HANDLE: ("ark-" + $session_id),
        ARK_SESSION_DIR: $session_dir,
        ARK_WORKTREE: $workdir,
        ARK_PROMPT_FILE: $prompt_file,
        ARK_STAGE: $stage,
        ARK_MAX_TURNS: $max_turns,
        ARK_MODEL: $model,
        ARK_COMPAT: $compat,
        ARK_TENANT_ID: $tenant,
        ANTHROPIC_API_KEY: "dummy",
        ANTHROPIC_BASE_URL: $base_url,
        ANTHROPIC_CUSTOM_HEADERS: $headers_prefix
      },
      task_file_content: $task_prompt,
      system_prompt_append: $system_append,
      workdir_before: { head: $before_head, branch: $before_branch, dirty: ($before_dirty == "true") }
    }' > "$stage_dir/inputs.json"

  # Invoke the SDK launcher with the production-shaped env
  log "invoking launch.ts (stage=$stage model=$ISO_MODEL)"
  local start_ts end_ts
  start_ts=$(date +%s%3N)
  ARK_SESSION_ID="$ISO_SESSION_ID" \
  ARK_SESSION_HANDLE="ark-${ISO_SESSION_ID}" \
  ARK_SESSION_DIR="$session_dir" \
  ARK_WORKTREE="$WORKDIR" \
  ARK_PROMPT_FILE="$prompt_file" \
  ARK_STAGE="$stage" \
  ARK_MAX_TURNS="200" \
  ARK_MODEL="$ISO_MODEL" \
  ARK_COMPAT="bedrock" \
  ARK_TENANT_ID="default" \
  ARK_SYSTEM_PROMPT_APPEND="$system_append" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL" \
  ANTHROPIC_CUSTOM_HEADERS="$ANTHROPIC_CUSTOM_HEADERS" \
  IS_SANDBOX="1" \
    bun /app/packages/core/runtimes/claude-agent/launch.ts \
      > "$stage_dir/stdout.log" \
      2> "$stage_dir/stderr.log"
  local exit_code=$?
  end_ts=$(date +%s%3N)
  local duration_ms=$((end_ts - start_ts))
  log "stage[$stage] exit=$exit_code duration=${duration_ms}ms"

  # Copy transcript if it exists
  if [ -f "$session_dir/transcript.jsonl" ]; then
    cp "$session_dir/transcript.jsonl" "$stage_dir/transcript.jsonl"
  else
    : > "$stage_dir/transcript.jsonl"
  fi

  # Parse terminal_reason + cost + final assistant message from transcript
  local terminal_reason cost_usd final_msg
  terminal_reason=$(jq -s 'map(select(.type=="result")) | last | .terminal_reason // ""' "$stage_dir/transcript.jsonl" 2>/dev/null || echo '""')
  cost_usd=$(jq -s 'map(select(.type=="result")) | last | .total_cost_usd // 0' "$stage_dir/transcript.jsonl" 2>/dev/null || echo 0)
  final_msg=$(jq -s 'map(select(.type=="assistant")) | last | .message.content // [] | map(select(.type=="text"))[0].text // ""' "$stage_dir/transcript.jsonl" 2>/dev/null || echo '""')

  # Workdir snapshot AFTER
  local after_head new_commits
  after_head=$(git -C "$WORKDIR" rev-parse HEAD)
  if [ "$after_head" != "$before_head" ]; then
    new_commits=$(git -C "$WORKDIR" log --pretty=format:'{"sha":"%H","subject":"%s"}' "$before_head".."$after_head" | jq -s '.')
  else
    new_commits="[]"
  fi

  jq -n \
    --arg stage "$stage" \
    --argjson exit_code "$exit_code" \
    --argjson duration_ms "$duration_ms" \
    --argjson terminal_reason "$terminal_reason" \
    --argjson cost_usd "$cost_usd" \
    --argjson final_msg "$final_msg" \
    --arg after_head "$after_head" \
    --arg before_head "$before_head" \
    --argjson new_commits "$new_commits" \
    '{
      stage: $stage,
      exit_code: $exit_code,
      terminal_reason: $terminal_reason,
      total_cost_usd: $cost_usd,
      duration_ms: $duration_ms,
      final_assistant_msg: $final_msg,
      workdir_before: { head: $before_head },
      workdir_after:  { head: $after_head },
      new_commits: $new_commits,
      commit_count: ($new_commits | length)
    }' > "$stage_dir/outputs.json"

  log "stage[$stage] commits added=$(jq '.commit_count' < "$stage_dir/outputs.json") terminal=$(jq -r '.terminal_reason' < "$stage_dir/outputs.json")"
  return "$exit_code"
}

# ── pr stage ────────────────────────────────────────────────────────────────
# Delegates to do-pr-stage.ts which imports the SAME pure helpers production
# uses (detectGitHost, parseCreatePrUrl, fallbackBranchUrl) from
# packages/core/services/worktree/pr.ts. This matches what `createWorktreePR`
# does for Bitbucket: push + parse Create-PR URL from stderr + fallback to
# branch URL. NO REST API call is made for BB -- that's production behaviour.
run_pr_stage() {
  local stage_dir="$CONTRACT_DIR/pr"
  mkdir -p "$stage_dir"
  log "=== stage[pr] ==="
  local start_ts end_ts
  start_ts=$(date +%s%3N)

  # do-pr-stage.ts handles `git remote set-url origin <authed>` itself.
  ARK_WORKDIR="$WORKDIR" \
  ARK_BRANCH="$ISO_BRANCH" \
  ARK_AUTHED_URL="$AUTHED_URL" \
  ARK_ORIGINAL_URL="$ISO_REPO" \
    bun /opt/iso/do-pr-stage.ts \
      > "$stage_dir/pr_output.json" \
      2> "$stage_dir/pr_stderr.log"
  local bun_exit=$?
  log "do-pr-stage.ts exit=$bun_exit"

  # pr_output.json is the leaf-helpers envelope; reshape into the stage's
  # outputs.json contract (same shape the plan/impl stages emit + pr fields).
  local pr_url="" push_exit="-1" terminal_reason="unknown" host="unknown"
  if [ -s "$stage_dir/pr_output.json" ]; then
    pr_url=$(jq -r '.pr_url // ""'         "$stage_dir/pr_output.json")
    push_exit=$(jq '.push_exit // -1'      "$stage_dir/pr_output.json")
    terminal_reason=$(jq -r '.terminal_reason // "unknown"' "$stage_dir/pr_output.json")
    host=$(jq -r '.host // "unknown"'      "$stage_dir/pr_output.json")
  fi
  log "pr stage: push_exit=$push_exit pr_url=$pr_url host=$host terminal=$terminal_reason"

  # Dump captured push stderr to the pod log so failures are debuggable.
  if [ -s "$stage_dir/pr_stderr.log" ]; then
    echo "===== pr_stderr ====="
    head -c 4000 "$stage_dir/pr_stderr.log"
    echo
  fi

  end_ts=$(date +%s%3N)
  local duration_ms=$((end_ts - start_ts))
  local exit_code=0
  if [ "$bun_exit" -ne 0 ] || [ "$push_exit" -ne 0 ] || [ -z "$pr_url" ]; then
    exit_code=1
  fi

  jq -n \
    --argjson exit_code "$exit_code" \
    --argjson duration_ms "$duration_ms" \
    --arg pr_url "$pr_url" \
    --argjson push_exit "$push_exit" \
    --arg branch "$ISO_BRANCH" \
    --arg host "$host" \
    --arg terminal_reason "$terminal_reason" \
    '{stage:"pr", exit_code:$exit_code, duration_ms:$duration_ms, push_exit:$push_exit, branch:$branch, host:$host, terminal_reason:$terminal_reason, pr_url:$pr_url}' \
    > "$stage_dir/outputs.json"

  return "$exit_code"
}

# ── finalize ────────────────────────────────────────────────────────────────
finalize() {
  log "=== finalize ==="
  local tmpl="/opt/iso/CONTRACT.md.tmpl"
  local out="$CONTRACT_DIR/CONTRACT.md"
  if [ ! -f "$tmpl" ]; then
    log "WARN: tmpl missing at $tmpl; skipping CONTRACT.md generation"
    return 0
  fi

  # Pull values from outputs.json files for substitution
  local plan_exit plan_term plan_commits plan_dur plan_cost
  plan_exit=$(jq '.exit_code' "$CONTRACT_DIR/plan/outputs.json" 2>/dev/null || echo null)
  plan_term=$(jq -r '.terminal_reason' "$CONTRACT_DIR/plan/outputs.json" 2>/dev/null || echo "")
  plan_commits=$(jq '.commit_count' "$CONTRACT_DIR/plan/outputs.json" 2>/dev/null || echo 0)
  plan_dur=$(jq '.duration_ms' "$CONTRACT_DIR/plan/outputs.json" 2>/dev/null || echo 0)
  plan_cost=$(jq '.total_cost_usd' "$CONTRACT_DIR/plan/outputs.json" 2>/dev/null || echo 0)

  local impl_exit impl_term impl_commits impl_dur impl_cost
  impl_exit=$(jq '.exit_code' "$CONTRACT_DIR/implement/outputs.json" 2>/dev/null || echo null)
  impl_term=$(jq -r '.terminal_reason' "$CONTRACT_DIR/implement/outputs.json" 2>/dev/null || echo "")
  impl_commits=$(jq '.commit_count' "$CONTRACT_DIR/implement/outputs.json" 2>/dev/null || echo 0)
  impl_dur=$(jq '.duration_ms' "$CONTRACT_DIR/implement/outputs.json" 2>/dev/null || echo 0)
  impl_cost=$(jq '.total_cost_usd' "$CONTRACT_DIR/implement/outputs.json" 2>/dev/null || echo 0)

  local pr_exit pr_dur pr_url
  pr_exit=$(jq '.exit_code' "$CONTRACT_DIR/pr/outputs.json" 2>/dev/null || echo null)
  pr_dur=$(jq '.duration_ms' "$CONTRACT_DIR/pr/outputs.json" 2>/dev/null || echo 0)
  pr_url=$(jq -r '.pr_url' "$CONTRACT_DIR/pr/outputs.json" 2>/dev/null || echo "")

  sed \
    -e "s|{{run_id}}|$ISO_SESSION_ID|g" \
    -e "s|{{date}}|$(date -u +%Y-%m-%dT%H:%M:%SZ)|g" \
    -e "s|{{cluster}}|pai-risk-mlops-platform|g" \
    -e "s|{{image}}|ark:${ARK_IMAGE_TAG:-(unknown)}|g" \
    -e "s|{{repo}}|$ISO_REPO|g" \
    -e "s|{{branch}}|$ISO_BRANCH|g" \
    -e "s|{{summary}}|$ISO_SUMMARY|g" \
    -e "s|{{plan.exit_code}}|$plan_exit|g" \
    -e "s|{{plan.terminal_reason}}|$plan_term|g" \
    -e "s|{{plan.commit_count}}|$plan_commits|g" \
    -e "s|{{plan.duration_ms}}|$plan_dur|g" \
    -e "s|{{plan.cost_usd}}|$plan_cost|g" \
    -e "s|{{plan.notes}}||g" \
    -e "s|{{implement.exit_code}}|$impl_exit|g" \
    -e "s|{{implement.terminal_reason}}|$impl_term|g" \
    -e "s|{{implement.commit_count}}|$impl_commits|g" \
    -e "s|{{implement.duration_ms}}|$impl_dur|g" \
    -e "s|{{implement.cost_usd}}|$impl_cost|g" \
    -e "s|{{implement.notes}}||g" \
    -e "s|{{pr.exit_code}}|$pr_exit|g" \
    -e "s|{{pr.duration_ms}}|$pr_dur|g" \
    -e "s|{{pr.notes}}||g" \
    -e "s|{{pr.url}}|$pr_url|g" \
    "$tmpl" > "$out"

  # Print the contract tree + per-stage outputs.json so run.sh can scrape via pod log
  echo
  echo "===== CONTRACT TREE ====="
  (cd "$CONTRACT_DIR" && find . -type f | sort)
  echo
  echo "===== CONTRACT.md ====="
  cat "$out"
  for stage in plan implement pr; do
    echo
    echo "===== outputs.json [$stage] ====="
    cat "$CONTRACT_DIR/$stage/outputs.json" 2>/dev/null || echo "(missing)"
  done
  for stage in plan implement pr; do
    echo
    echo "===== inputs.json [$stage] ====="
    cat "$CONTRACT_DIR/$stage/inputs.json" 2>/dev/null || echo "(missing)"
  done
}

# ── main ────────────────────────────────────────────────────────────────────
FAILS=0

run_stage plan      /app/agents/planner.yaml || FAILS=$((FAILS+1))
run_stage implement /app/agents/worker.yaml  || FAILS=$((FAILS+1))
run_pr_stage                                 || FAILS=$((FAILS+1))

finalize

log "=== done. failed stages: $FAILS ==="
exit "$FAILS"
