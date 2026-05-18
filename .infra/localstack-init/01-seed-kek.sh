#!/bin/sh
# Idempotent seed for the dev master KEK. Runs once on LocalStack ready-d.
# Produces a 32-byte random key, base64-encoded -- matches SsmKekBackend
# (packages/secrets/kek/ssm.ts).
set -eu

PARAM="/ark/kek/dev"
REGION="${AWS_DEFAULT_REGION:-ap-south-1}"

if awslocal ssm get-parameter --name "$PARAM" --with-decryption \
    --region "$REGION" >/dev/null 2>&1; then
  echo "[localstack-init] $PARAM already exists -- skipping"
  exit 0
fi

# `openssl rand -base64 32` -> 44 chars incl. padding; decodes to 32 raw bytes.
VALUE=$(openssl rand -base64 32)

awslocal ssm put-parameter \
  --name "$PARAM" \
  --type SecureString \
  --value "$VALUE" \
  --region "$REGION" \
  --description "Ark master KEK (LocalStack dev) -- 32 random bytes b64." \
  >/dev/null

echo "[localstack-init] seeded $PARAM"
