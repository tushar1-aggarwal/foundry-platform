#!/usr/bin/env bash
# Expand platform-ark IAM policy to allow:
#   - ec2:DescribeInstances, ec2:DescribeNetworkInterfaces (attach to existing)
#   - ec2:StartInstances, ec2:StopInstances (warm-pool / idle resume)
#   - ssm:StartSession (open SSM port-forward)
#   - ssm:TerminateSession (cleanup)
#   - ssm:DescribeInstanceInformation (verify SSM agent online)
#   - ssm:DescribeSessions (reuse logic in EC2Compute.setupTransport)
#
# Uses `aws iam create-policy-version --set-as-default`. AWS-managed policies
# keep up to 5 versions; we prune the oldest non-default if at the limit.
#
# Idempotent: if the policy already includes every action we want, exits 0
# without creating a new version.

set -euo pipefail

: "${AWS_PROFILE:=pai-risk-mlops}"
POLICY_ARN="arn:aws:iam::880170353725:policy/platform-ark"

# Required actions, sorted for stable diffs.
REQ_EC2=(
  ec2:DescribeInstances
  ec2:DescribeNetworkInterfaces
  ec2:StartInstances
  ec2:StopInstances
)
REQ_SSM=(
  ssm:DescribeInstanceInformation
  ssm:DescribeSessions
  ssm:StartSession
  ssm:TerminateSession
)

echo "==> reading current default policy version"
VER=$(AWS_PROFILE="$AWS_PROFILE" aws iam get-policy --policy-arn "$POLICY_ARN" --query 'Policy.DefaultVersionId' --output text)
DOC=$(AWS_PROFILE="$AWS_PROFILE" aws iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$VER" \
  --query 'PolicyVersion.Document' --output json)
echo "    current default = $VER"

# Idempotency check: does the doc already contain every required action?
NEEDED=()
for a in "${REQ_EC2[@]}" "${REQ_SSM[@]}"; do
  if ! echo "$DOC" | jq -e --arg a "$a" '[.Statement[].Action] | flatten | index($a)' >/dev/null; then
    NEEDED+=("$a")
  fi
done
if [ "${#NEEDED[@]}" -eq 0 ]; then
  echo "==> policy already grants every required action. nothing to do."
  exit 0
fi
echo "==> missing actions: ${NEEDED[*]}"

# Build new document = existing statements + 2 new sids.
NEW_DOC=$(echo "$DOC" | jq '
  .Statement += [
    {
      Sid: "Ec2InstancesForEC2Compute",
      Effect: "Allow",
      Action: ["ec2:DescribeInstances","ec2:DescribeNetworkInterfaces","ec2:StartInstances","ec2:StopInstances"],
      Resource: "*"
    },
    {
      Sid: "SsmSessionManagerForEC2Compute",
      Effect: "Allow",
      Action: ["ssm:DescribeInstanceInformation","ssm:DescribeSessions","ssm:StartSession","ssm:TerminateSession"],
      Resource: "*"
    }
  ]
')

# Prune oldest non-default version if we are at the 5-version limit.
COUNT=$(AWS_PROFILE="$AWS_PROFILE" aws iam list-policy-versions --policy-arn "$POLICY_ARN" \
  --query 'length(Versions)' --output text)
if [ "$COUNT" -ge 5 ]; then
  OLDEST_NONDEFAULT=$(AWS_PROFILE="$AWS_PROFILE" aws iam list-policy-versions --policy-arn "$POLICY_ARN" \
    --query 'sort_by(Versions[?IsDefaultVersion==`false`], &CreateDate)[0].VersionId' --output text)
  echo "==> at 5-version limit; deleting oldest non-default = $OLDEST_NONDEFAULT"
  AWS_PROFILE="$AWS_PROFILE" aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLDEST_NONDEFAULT"
fi

echo "==> creating new policy version + setting as default"
AWS_PROFILE="$AWS_PROFILE" aws iam create-policy-version \
  --policy-arn "$POLICY_ARN" \
  --policy-document "$NEW_DOC" \
  --set-as-default \
  --query 'PolicyVersion.{version:VersionId,isDefault:IsDefaultVersion,created:CreateDate}'
