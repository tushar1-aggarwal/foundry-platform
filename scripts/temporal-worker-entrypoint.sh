#!/usr/bin/env bash
set -euo pipefail
ARK_DIR="${ARK_DIR:-/root/.ark}"
PLUGIN_DIR="$ARK_DIR/plugins/executors"
FLOW_DIR="$ARK_DIR/flows"
mkdir -p "$PLUGIN_DIR" "$FLOW_DIR"
# Install stub-runner plugin (e2e only -- harmless in prod since it's only invoked when flow uses stub-runner runtime)
[ -f /app/e2e/fixtures/stub-runner-executor.mjs ] && cp /app/e2e/fixtures/stub-runner-executor.mjs "$PLUGIN_DIR/stub-runner.mjs"
# Install e2e flow fixtures if present
if [ -d /app/e2e/fixtures/flows ]; then
  cp /app/e2e/fixtures/flows/*.yaml "$FLOW_DIR/" 2>/dev/null || true
fi
exec tsx packages/core/temporal/worker.ts
