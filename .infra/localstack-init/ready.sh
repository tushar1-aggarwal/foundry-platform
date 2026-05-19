#!/usr/bin/env bash
# Bind-mounted into the dev LocalStack container at
# /etc/localstack/init/ready.d/ready.sh. LocalStack runs every script in
# ready.d once via `bash` after services report READY (mode bits ignored),
# so this works even on a 644 bind-mount. `awslocal` is bundled in the
# image -- no external aws-cli image to pull. `|| true` keeps it idempotent
# across container restarts with PERSISTENCE=0 (bucket is recreated cleanly).
set -euo pipefail
BUCKET="${ARK_S3_BUCKET:-ark-local}"
awslocal s3 mb "s3://${BUCKET}" || true
echo "[localstack-init] bucket ${BUCKET} ready"
