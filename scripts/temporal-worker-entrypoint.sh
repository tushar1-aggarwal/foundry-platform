#!/usr/bin/env bash
set -euo pipefail
ARK_DIR="${ARK_DIR:-/root/.ark}"
PLUGIN_DIR="$ARK_DIR/plugins/executors"
FLOW_DIR="$ARK_DIR/flows"
mkdir -p "$PLUGIN_DIR" "$FLOW_DIR"
# Install fake claude-code plugin -- overrides the real claude-code executor
# in this worker container with an in-process stub so the heavy tmux+launch
# pipeline doesn't blow past the 60s heartbeat timeout on dispatchStageActivity.
# Only loaded when the file is present, so prod images that don't ship e2e/
# fixtures won't shadow the real claude-code executor.
[ -f /app/e2e/fixtures/fake-claude-code-executor.mjs ] && cp /app/e2e/fixtures/fake-claude-code-executor.mjs "$PLUGIN_DIR/claude-code.mjs"
# Install e2e flow fixtures if present
if [ -d /app/e2e/fixtures/flows ]; then
  cp /app/e2e/fixtures/flows/*.yaml "$FLOW_DIR/" 2>/dev/null || true
fi
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
exec tsx packages/core/temporal/worker.ts
