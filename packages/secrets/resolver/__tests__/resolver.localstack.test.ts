/**
 * End-to-end resolver test against LocalStack SSM. Seeds 4 paths,
 * runs resolveAll for tenant_id=t1, user_id=u1, teamChain=["eng"], and
 * asserts user-wins-over-team-wins-over-tenant.
 *
 * Docker is auto-detected -- this entire describe block is skipped
 * when docker isn't reachable so CI without docker stays green.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";
import { AwsSecretsProvider } from "../../../core/secrets/aws-provider.js";
import { HierarchicalSecretResolver } from "../resolver.js";
import {
  startLocalStackSsm,
  isDockerAvailable,
  setLocalStackCredentials,
  type LocalStackSsmHandle,
} from "../../kek/__tests__/localstack-ssm-helper.js";

const dockerOk = await isDockerAvailable();
const d = dockerOk ? describe : describe.skip;

d("HierarchicalSecretResolver (LocalStack)", () => {
  let ls: LocalStackSsmHandle;
  let restoreCreds: () => void;
  let ssm: SSMClient;

  beforeAll(async () => {
    ls = await startLocalStackSsm();
    restoreCreds = setLocalStackCredentials().restore;
    ssm = new SSMClient({ endpoint: ls.endpoint, region: "us-east-1" });
  }, 120_000);

  afterAll(async () => {
    try {
      ssm?.destroy();
    } catch {
      /* best-effort */
    }
    restoreCreds?.();
    await ls?.stop();
  }, 30_000);

  it("walks user -> team -> tenant and merges with user-wins precedence", async () => {
    // Seed:
    //   /ark/t1/tenant/A           -> "tenant-a"   (gets overridden)
    //   /ark/t1/tenant/B           -> "tenant-b"   (gets overridden by team)
    //   /ark/t1/teams/eng/B        -> "team-b"
    //   /ark/t1/users/u1/A         -> "user-a"
    // Expected: { A: "user-a", B: "team-b" }
    const seed: Array<[string, string]> = [
      ["/ark/t1/tenant/A", "tenant-a"],
      ["/ark/t1/tenant/B", "tenant-b"],
      ["/ark/t1/teams/eng/B", "team-b"],
      ["/ark/t1/users/u1/A", "user-a"],
    ];
    for (const [Name, Value] of seed) {
      await ssm.send(
        new PutParameterCommand({
          Name,
          Value,
          Type: "SecureString",
          Overwrite: true,
        }),
      );
    }

    const provider = new AwsSecretsProvider({ region: "us-east-1", client: ssm });
    const resolver = new HierarchicalSecretResolver(provider);

    const env = await resolver.resolveAll({ tenant_id: "t1", user_id: "u1" }, ["eng"]);
    expect(env).toEqual({ A: "user-a", B: "team-b" });
  }, 60_000);
});
