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

SESSION_ID="${ARK_SESSION_ID:?ARK_SESSION_ID is required}"
STAGE="${ARK_STAGE:?ARK_STAGE is required}"
WORKDIR="${ARK_WORKDIR:-}"
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

# 2. Failure injection (restart-then-fail test).
if [[ "${ARK_FAKE_CLAUDE_FAIL_STAGE:-}" == "${STAGE}" ]]; then
  curl -fsS -X POST "${CONDUCTOR_URL}/api/channel/${SESSION_ID}" \
    -H "Content-Type: application/json" \
    -d '{"ok": false, "error": {"type":"AuthError","message":"401 Unauthorized"}}' \
    || true
  exit 0
fi

# 3. On implement stage, make a real commit so create_pr has something to push.
if [[ "${STAGE}" == "implement" ]] && [[ -n "${WORKDIR}" ]] && [[ -d "${WORKDIR}/.git" ]]; then
  cd "${WORKDIR}"
  echo "stub commit at $(date -u +%FT%TZ)" >> NOTES.md
  git -c user.email=stub@ark.local -c user.name=stub-implementer add NOTES.md
  git -c user.email=stub@ark.local -c user.name=stub-implementer commit -m "stub-implementer: ${SESSION_ID}"
fi

# 4. Success CompletionReport.
curl -fsS -X POST "${CONDUCTOR_URL}/api/channel/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -d "{\"ok\": true, \"summary\": \"stub completed ${STAGE} stage\"}"
