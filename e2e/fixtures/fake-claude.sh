#!/usr/bin/env bash
# Stand-in for the real `claude` binary in e2e tests. Invoked through the real
# claude-code executor; replaces only the LLM-call body. POSTs a CompletionReport
# to the conductor's channel HTTP endpoint and exits.
#
# Env contract:
#   ARK_SESSION_ID            required
#   ARK_STAGE                 required
#   ARK_CONDUCTOR_URL or ARK_CONDUCTOR_PORT
#   ARK_WORKDIR               cwd of the agent (the cloned repo)
#   ARK_DIR                   ark data dir (used for env-log audit trail)
#   ARK_FAKE_CLAUDE_FAIL_STAGE optional: when equals ARK_STAGE, emit an
#                              AuthError CompletionReport and exit 0. Falls
#                              back to reading /tmp/ark-fail-stage so the
#                              host test can inject a fail stage without
#                              rebuilding the worker container.

set -euo pipefail

# Read the failure-injection flag file written by register-fixtures via
# `docker exec` if the env var wasn't set in the launcher's launchEnv (the
# normal path -- LocalCompute doesn't pipe this env through).
if [[ -z "${ARK_FAKE_CLAUDE_FAIL_STAGE:-}" ]] && [[ -r /tmp/ark-fail-stage ]]; then
  ARK_FAKE_CLAUDE_FAIL_STAGE="$(tr -d '[:space:]' < /tmp/ark-fail-stage || true)"
fi

# ARK_SESSION_ID and ARK_STAGE are not set directly by the claude-code runtime,
# but ARK_SESSION_DIR is (form: <arkDir>/tracks/<sessionId>). Fall back to
# deriving SESSION_ID from there and STAGE from the task prompt at task.txt.
if [[ -z "${ARK_SESSION_ID:-}" ]] && [[ -n "${ARK_SESSION_DIR:-}" ]]; then
  ARK_SESSION_ID="$(basename "$ARK_SESSION_DIR")"
fi
if [[ -z "${ARK_STAGE:-}" ]] && [[ -n "${ARK_SESSION_DIR:-}" ]] && [[ -f "$ARK_SESSION_DIR/task.txt" ]]; then
  ARK_STAGE="$(grep -oE "running the '[^']+' stage" "$ARK_SESSION_DIR/task.txt" | head -1 | sed -E "s/running the '([^']+)' stage/\1/")"
fi
SESSION_ID="${ARK_SESSION_ID:?ARK_SESSION_ID is required}"
STAGE="${ARK_STAGE:?ARK_STAGE is required}"
WORKDIR="${ARK_WORKDIR:-$PWD}"
ARK_DIR_VAL="${ARK_DIR:-/tmp}"

if [[ -n "${ARK_CONDUCTOR_URL:-}" ]]; then
  CONDUCTOR_URL="${ARK_CONDUCTOR_URL}"
else
  PORT="${ARK_CONDUCTOR_PORT:-19102}"
  CONDUCTOR_URL="http://localhost:${PORT}"
fi

# 1. Audit trail for credential-resolution debugging.
mkdir -p "${ARK_DIR_VAL}/agent-envs"
printenv > "${ARK_DIR_VAL}/agent-envs/${STAGE}.log"

# Deliver a CompletionReport via JSON-RPC channel/deliver. The legacy
# REST endpoint POST /api/channel/:sessionId was removed
# (see packages/conductor/handlers/channel.ts:5-8); all channel traffic now
# flows through /api/rpc.
deliver_report() {
  local report_json="$1"
  local rpc_body
  rpc_body="$(cat <<EOF
{"jsonrpc":"2.0","id":"fake-claude-${SESSION_ID}-${STAGE}","method":"channel/deliver","params":{"sessionId":"${SESSION_ID}","report":${report_json}}}
EOF
)"
  # Retry the POST with backoff. The restart-then-fail test KILLS the
  # conductor mid-implement; without retries, the report is lost and the
  # workflow never sees the AuthError, leaving the session stuck instead of
  # transitioning to status=failed. The old in-process plugin shadow wrote
  # directly through handleReport(app,...) which was durable in the DB;
  # the HTTP path needs explicit retries to match that guarantee.
  local attempts=20
  local delay=1
  for i in $(seq 1 $attempts); do
    if curl -fsS -X POST "${CONDUCTOR_URL}/api/rpc" \
        -H "Content-Type: application/json" \
        -d "$rpc_body" >/dev/null 2>&1; then
      return 0
    fi
    sleep $delay
    if [ $delay -lt 5 ]; then delay=$((delay+1)); fi
  done
  return 0
}

# Poll session/read via the conductor RPC until session.status === "running"
# before firing any report. Without this wait the dispatch chain's
# finalizeLaunch + projectStage(running) can land AFTER our channel/deliver
# (which flips status to "ready"), overwriting "ready" back to "running" --
# at which point awaitStageCompletionActivity polls forever because the
# terminal status never sticks. Mirrors the old fake-claude-code plugin's
# 5s wait loop + 200ms grace.
wait_for_running() {
  local deadline=$(( $(date +%s) + 5 ))
  while (( $(date +%s) < deadline )); do
    local resp
    resp="$(curl -fsS -X POST "${CONDUCTOR_URL}/api/rpc" \
      -H "Content-Type: application/json" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":\"poll-${SESSION_ID}-${STAGE}\",\"method\":\"session/read\",\"params\":{\"sessionId\":\"${SESSION_ID}\"}}" 2>/dev/null || true)"
    if echo "$resp" | grep -q '"status":"running"'; then
      sleep 0.2
      return 0
    fi
    sleep 0.05
  done
}
wait_for_running

# 2. Failure injection (restart-then-fail test).
if [[ "${ARK_FAKE_CLAUDE_FAIL_STAGE:-}" == "${STAGE}" ]]; then
  deliver_report '{"type":"error","sessionId":"'"${SESSION_ID}"'","stage":"'"${STAGE}"'","error":"AuthError: 401 Unauthorized"}'
  exit 0
fi

# 3. On implement stage, make a real commit so create_pr has something to push.
if [[ "${STAGE}" == "implement" ]] && [[ -n "${WORKDIR}" ]] && [[ -d "${WORKDIR}/.git" ]]; then
  cd "${WORKDIR}"
  # Create a session-owned branch so createWorktreePR can force-push it.
  BRANCH_NAME="ark-s-${SESSION_ID}"
  git checkout -b "$BRANCH_NAME" 2>/dev/null || git checkout "$BRANCH_NAME"
  echo "stub commit at $(date -u +%FT%TZ)" >> NOTES.md
  git -c user.email=stub@ark.local -c user.name=stub-implementer add NOTES.md
  git -c user.email=stub@ark.local -c user.name=stub-implementer commit -m "stub-implementer: ${SESSION_ID}"

  # Persist branch on the session row so createWorktreePR finds it without
  # rev-parsing HEAD (the pr action may run from a different filesystem
  # context where the worktree dir doesn't exist). Mirrors what the old
  # in-process plugin shadow did via app.sessions.update().
  update_body="$(cat <<EOF
{"jsonrpc":"2.0","id":"fake-claude-${SESSION_ID}-${STAGE}-branch","method":"session/update","params":{"sessionId":"${SESSION_ID}","fields":{"branch":"${BRANCH_NAME}"}}}
EOF
)"
  curl -fsS -X POST "${CONDUCTOR_URL}/api/rpc" \
    -H "Content-Type: application/json" \
    -d "$update_body" >/dev/null 2>&1 || true
fi

# 4. Publish a representative PostToolUse hook to the in-container arkd
# (Mode A.1 sidecar). Exercises the arkd hook-publish + WS-relay channel
# that the real claude binary would use; fake-claude was previously bypassing
# it entirely. Soft failure (`|| true`) so a missing arkd doesn't break the
# test -- the conductor-side channel/deliver below is still authoritative.
ARKD_PORT_VAL="${ARK_ARKD_PORT:-19300}"
ARKD_HOOK_URL="http://localhost:${ARKD_PORT_VAL}/channel/hooks/publish"
HOOK_TS="$(date -u +%FT%TZ)"
hook_body="$(cat <<EOF
{"sessionId":"${SESSION_ID}","stage":"${STAGE}","event":"PostToolUse","tool":"fake-claude","timestamp":"${HOOK_TS}","summary":"stub PostToolUse for ${STAGE}"}
EOF
)"
curl -fsS -X POST "${ARKD_HOOK_URL}" \
  -H "Content-Type: application/json" \
  -d "$hook_body" >/dev/null 2>&1 || true

# 5. Success CompletionReport.
deliver_report '{"type":"completed","sessionId":"'"${SESSION_ID}"'","stage":"'"${STAGE}"'","summary":"stub completed '"${STAGE}"' stage","filesChanged":[],"commits":[]}'
