#!/usr/bin/env bash
# Orchestrator: runs all ec2-isolation scripts in order.
#
# Usage:
#   ./run.sh                    # full chain: preflight → register → patch → dispatch
#   ./run.sh --skip-preflight   # skip preflight (e.g. you just ran it)
#   ./run.sh --skip-patch       # skip cred injection (creds already injected & still valid)
#   ./run.sh --skip-register    # skip compute-row registration (already exists)
#   ./run.sh --dry-run          # only show what would happen
#
# Stops at the first hard failure.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SKIP_PREFLIGHT=0
SKIP_REGISTER=0
SKIP_PATCH=0
SKIP_DISPATCH=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --skip-preflight) SKIP_PREFLIGHT=1 ;;
    --skip-register)  SKIP_REGISTER=1 ;;
    --skip-patch)     SKIP_PATCH=1 ;;
    --skip-dispatch)  SKIP_DISPATCH=1 ;;
    --dry-run)        DRY=1 ;;
    -h|--help)
      sed -n '1,15p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

run() {
  local label="$1"; shift
  echo
  echo "════════════════════════════════════════════════════════════════════════════"
  echo "  $label"
  echo "════════════════════════════════════════════════════════════════════════════"
  if [ "$DRY" -eq 1 ]; then
    echo "[dry-run] $*"
    return 0
  fi
  "$@" || { echo "FATAL: $label failed" >&2; exit 1; }
}

[ "$SKIP_PREFLIGHT" -eq 1 ] || run "1/4 preflight"        "$SCRIPT_DIR/preflight.sh"
[ "$SKIP_REGISTER"  -eq 1 ] || run "2/4 register-compute" "$SCRIPT_DIR/register-compute.sh"
[ "$SKIP_PATCH"     -eq 1 ] || run "3/4 patch-worker-creds" "$SCRIPT_DIR/patch-worker-creds.sh"
[ "$SKIP_DISPATCH"  -eq 1 ] || run "4/4 dispatch-session"  "$SCRIPT_DIR/dispatch-session.sh"

echo
echo "Done. Check the dispatch log above for the new session id and tail its events:"
echo "  k_get /api/v1/namespaces/ark/pods?labelSelector=session-id=<sid>"
echo "  ark-worker logs:  k_get /api/v1/namespaces/ark/pods/<ark-worker-pod>/log"
