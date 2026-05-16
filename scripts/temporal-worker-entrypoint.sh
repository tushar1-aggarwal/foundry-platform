#!/usr/bin/env bash
set -euo pipefail
ARK_DIR="${ARK_DIR:-/root/.ark}"
mkdir -p "$ARK_DIR"

# Pre-populate test secrets in this worker's encrypted file backend. The host
# server's file backend uses a different machine-scoped encryption key, so
# secrets set via RPC on the host are unreadable here. The runtime dispatch
# validator requires CLAUDE_CODE_OAUTH_TOKEN for the claude-code agents in
# the e2e flows; fake-claude doesn't read it but launch is rejected without.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  # The FileSecretsProvider derives its encryption key from hostname+user+arch
  # and the *runtime's* version of scrypt. The worker reads under tsx/Node, so
  # seed under the same runtime to avoid AES-GCM auth failures from key drift.
  # Wipe any prior secrets.json that may have been written by a different
  # runtime (e.g. an earlier Bun-based seeder).
  rm -f "$ARK_DIR/secrets.json"
  tsx -e "import('./packages/core/secrets/file-provider.js').then(async (m) => { const p = new m.FileSecretsProvider(process.env.ARK_DIR || '/root/.ark'); await p.set('default', 'CLAUDE_CODE_OAUTH_TOKEN', process.env.CLAUDE_CODE_OAUTH_TOKEN, { type: 'env-var' }); console.log('seeded CLAUDE_CODE_OAUTH_TOKEN'); }).catch((e) => { console.error('seed failed:', e.message); });" || true
fi

# Start arkd in the background. LocalCompute.getArkdUrl() hard-codes
# http://localhost:<port>; the real claude-code executor uses arkd for
# workspace clones (prepareWorkspace), hook subscriptions (ensureReachable),
# and the launcher's settings.json bakes the arkd hook URL into the agent's
# .claude/settings.local.json. Co-locating arkd here means proc 1 (this
# entrypoint's exec'd tsx worker.ts) and proc 2 (arkd) share localhost so
# the LocalCompute contract is satisfied inside one container.
#
# Use bun (image base) for arkd because arkd uses Bun.spawn -- it cannot
# run under tsx/Node. The temporal-worker process itself runs under tsx
# because the Temporal SDK needs v8.promiseHooks which Bun's V8 doesn't
# expose; the two coexist in this image.
ARK_ARKD_PORT="${ARK_ARKD_PORT:-19300}"
ARKD_CONDUCTOR_URL="${ARK_CONDUCTOR_URL:-http://host.docker.internal:8422}"
echo "[entrypoint] starting arkd on :${ARK_ARKD_PORT} (conductor=${ARKD_CONDUCTOR_URL})"
bun packages/cli/index.ts arkd --port "${ARK_ARKD_PORT}" --conductor-url "${ARKD_CONDUCTOR_URL}" \
  > /tmp/arkd.log 2>&1 &
ARKD_PID=$!

# Wait for arkd /health up to 30s before exec'ing the worker. Without this
# probe, the worker can fire the first activity before arkd is bound, which
# breaks LocalCompute.prepareWorkspace and the hook publish path.
for i in $(seq 1 60); do
  if curl -sf "http://localhost:${ARK_ARKD_PORT}/health" >/dev/null 2>&1; then
    echo "[entrypoint] arkd ready (pid=${ARKD_PID})"
    break
  fi
  if ! kill -0 "${ARKD_PID}" 2>/dev/null; then
    echo "[entrypoint] arkd died during startup, log:" >&2
    cat /tmp/arkd.log >&2 || true
    exit 1
  fi
  sleep 0.5
done

# tee (not a bare redirect) so logs reach BOTH the container stdout
# (kubectl logs) AND a durable logfile that startProcessTraceShipping
# flushes to the blob store -- conductor/worker history must survive pod
# death (the hook-pipeline regression was invisible because it didn't).
exec tsx packages/core/temporal/worker.ts 2>&1 | tee /tmp/ark-temporal-worker.log
