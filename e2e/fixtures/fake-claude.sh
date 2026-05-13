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
#                              AuthError CompletionReport and exit 0.

set -euo pipefail

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
  curl -fsS -X POST "${CONDUCTOR_URL}/api/rpc" \
    -H "Content-Type: application/json" \
    -d "$rpc_body" || true
}

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
fi

# 4. Success CompletionReport.
deliver_report '{"type":"completed","sessionId":"'"${SESSION_ID}"'","stage":"'"${STAGE}"'","summary":"stub completed '"${STAGE}"' stage","filesChanged":[],"commits":[]}'
