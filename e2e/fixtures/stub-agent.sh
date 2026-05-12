#!/usr/bin/env bash
# Stub agent for e2e testing.
#
# Reads ARK_SESSION_ID, ARK_STAGE, and ARK_CONDUCTOR_URL (or derives
# conductor URL from ARK_CONDUCTOR_PORT) from the environment, then posts
# a CompletionReport to the conductor's channel HTTP endpoint.
#
# This script replaces the real LLM agent body. Everything before
# (dispatch chain, compute resolution, executor launch) and after
# (conductor report handling, stage advance) stays real.
set -euo pipefail

SESSION_ID="${ARK_SESSION_ID:?ARK_SESSION_ID is required}"
STAGE="${ARK_STAGE:?ARK_STAGE is required}"

# Derive conductor URL from ARK_CONDUCTOR_URL or fall back to ARK_CONDUCTOR_PORT.
if [[ -n "${ARK_CONDUCTOR_URL:-}" ]]; then
  CONDUCTOR_URL="${ARK_CONDUCTOR_URL}"
else
  PORT="${ARK_CONDUCTOR_PORT:-19102}"
  CONDUCTOR_URL="http://localhost:${PORT}"
fi

case "${STAGE}" in
  plan)
    SUMMARY="Plan: implement get_cpu_usage by reading /proc/stat on linux, host_statistics on darwin"
    FILES='[]'
    ;;
  implement)
    SUMMARY="Implementation: added get_cpu_usage to src/sys/cpu.ts"
    FILES='["src/sys/cpu.ts"]'
    ;;
  *)
    SUMMARY="Stub agent completed stage ${STAGE}"
    FILES='[]'
    ;;
esac

# Brief pause to let the tmux pane fully attach (if running via tmux) and
# to mimic the real agent doing some work.
sleep 1

# Post a CompletionReport to the conductor via JSON-RPC `channel/deliver`.
# The legacy REST route POST /api/channel/:sessionId was removed when the
# control plane consolidated on the JSON-RPC surface; agents now go through
# arkd which forwards via the same RPC, but this stub bypasses arkd so we
# call /api/rpc directly.
#
# Transport selection: curl is the canonical choice and is present on the
# direct-mode host. Inside the docker-isolation sidecar (oven/bun:canary
# image with bootstrap.skip=true) curl is NOT installed but `bun` is -- use
# `bun fetch` as a fallback so the script works in both contexts without a
# separate sidecar variant.
BODY="{\
\"jsonrpc\":\"2.0\",\
\"id\":\"stub-agent-${SESSION_ID}-${STAGE}\",\
\"method\":\"channel/deliver\",\
\"params\":{\
\"sessionId\":\"${SESSION_ID}\",\
\"report\":{\
\"type\":\"completed\",\
\"sessionId\":\"${SESSION_ID}\",\
\"stage\":\"${STAGE}\",\
\"summary\":\"${SUMMARY}\",\
\"filesChanged\":${FILES},\
\"commits\":[]}}}"

if command -v curl >/dev/null 2>&1; then
  curl -fsS -X POST "${CONDUCTOR_URL}/api/rpc" \
    -H 'Content-Type: application/json' \
    -d "${BODY}"
elif command -v bun >/dev/null 2>&1; then
  CONDUCTOR_URL="${CONDUCTOR_URL}" BODY="${BODY}" bun -e '
    const r = await fetch(process.env.CONDUCTOR_URL + "/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: process.env.BODY,
    });
    if (!r.ok) {
      console.error("stub-agent fetch failed:", r.status, await r.text());
      process.exit(1);
    }
  '
else
  echo "stub-agent: neither curl nor bun is available -- cannot post completion" >&2
  exit 1
fi

exit 0
