#!/usr/bin/env bash
# Trigger a docs-flow session against the pai-risk-mlops production ark control
# plane and poll it to a terminal state. Lives outside the e2e test runner so
# it's runnable as a one-shot smoke test (no Bun, no test harness).
#
# Usage:
#   ARK_AUTH_TOKEN=<token> ./scripts/test-prod-docs-session.sh \
#     [--repo URL] [--summary TEXT] [--flow FLOW] [--timeout SECONDS]
#
# Defaults target the same inputs the browser e2e used:
#   repo:     https://bitbucket.org/paytmteam/foundry-test-repo
#   flow:     docs
#   summary:  "Add one paragraph for architecture.md file"
#   timeout:  180s (polls every 3s; bumps to 600s for real-LLM runs)
#
# Auth: the prod ingress requires a tenant token. Fetch with
#       `curl https://<host>/api/rpc -d '{"method":"auth/token", ...}'`
#       or grab one from your authenticated browser session's localStorage
#       under `ark_auth_token`. Pass via env so it doesn't end up in shell
#       history.

set -euo pipefail

HOST="${ARK_HOST:-https://ark.internal.ap-south-1.platform.mlops.pai.mypaytm.com}"
REPO="${ARK_REPO:-https://bitbucket.org/paytmteam/foundry-test-repo}"
SUMMARY="${ARK_SUMMARY:-Add one paragraph for architecture.md file}"
FLOW="${ARK_FLOW:-docs}"
TIMEOUT="${ARK_TIMEOUT:-180}"
TOKEN="${ARK_AUTH_TOKEN:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)    REPO="$2"; shift 2;;
    --summary) SUMMARY="$2"; shift 2;;
    --flow)    FLOW="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --host)    HOST="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

if [ -z "$TOKEN" ]; then
  echo "ARK_AUTH_TOKEN is required. Grab one from your browser's" >&2
  echo "localStorage['ark_auth_token'] after signing in at $HOST." >&2
  exit 1
fi

rpc() {
  local method="$1"
  local params="$2"
  local id
  id="rpc-$RANDOM"
  curl -sS -X POST "$HOST/api/rpc" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"$id\",\"method\":\"$method\",\"params\":$params}"
}

echo "== Creating session =="
echo "  host:    $HOST"
echo "  flow:    $FLOW"
echo "  repo:    $REPO"
echo "  summary: $SUMMARY"
echo ""

CREATE_BODY=$(jq -nc \
  --arg flow "$FLOW" --arg repo "$REPO" --arg summary "$SUMMARY" \
  '{flow: $flow, repo: $repo, summary: $summary, dispatch: true}')

CREATE_RESP=$(rpc "session/create" "$CREATE_BODY")
echo "$CREATE_RESP" | jq -e '.result.id' >/dev/null \
  || { echo "create failed:"; echo "$CREATE_RESP" | jq; exit 1; }

SID=$(echo "$CREATE_RESP" | jq -r '.result.id')
echo "  session id: $SID"
echo "  $HOST/#/sessions/$SID"
echo ""
echo "== Polling (timeout ${TIMEOUT}s) =="

START=$(date +%s)
LAST_STAGE=""
LAST_STATUS=""
while :; do
  ELAPSED=$(( $(date +%s) - START ))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "TIMEOUT after ${TIMEOUT}s"
    break
  fi

  GET_RESP=$(rpc "session/get" "$(jq -nc --arg id "$SID" '{id: $id}')")
  STAGE=$(echo "$GET_RESP" | jq -r '.result.stage // ""')
  STATUS=$(echo "$GET_RESP" | jq -r '.result.status // ""')
  ERROR=$(echo "$GET_RESP" | jq -r '.result.error // ""')

  if [ "$STAGE" != "$LAST_STAGE" ] || [ "$STATUS" != "$LAST_STATUS" ]; then
    printf "  [%4ss] stage=%-12s status=%-10s\n" "$ELAPSED" "$STAGE" "$STATUS"
    LAST_STAGE="$STAGE"
    LAST_STATUS="$STATUS"
  fi

  case "$STATUS" in
    completed|failed|cancelled|archived)
      echo ""
      echo "== Terminal: $STATUS =="
      [ -n "$ERROR" ] && [ "$ERROR" != "null" ] && echo "  error: $ERROR"
      echo "$GET_RESP" | jq '.result | {id, flow, stage, status, error, orchestrator, workflow_id, workflow_run_id, updated_at}'
      [ "$STATUS" = "completed" ] && exit 0 || exit 1
      ;;
  esac

  sleep 3
done

exit 1
