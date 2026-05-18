/**
 * Probe the Phase 2 hierarchical resolver for a given (tenant, user, team-chain)
 * shape. Prints the resolved env map -- useful for verifying SSM precedence.
 *
 * Usage:
 *   source /tmp/ark-ssm-env.sh
 *   bun scripts/test-resolver.ts <tenantId> <userId> <teamSegment...>
 *
 * Example:
 *   bun scripts/test-resolver.ts t-4b3073a52f7a u-e506a9cb65a4 platform
 */
import { AppContext } from "../packages/core/app.js";
import { loadAppConfig } from "../packages/core/config.js";
import { HierarchicalSecretResolver } from "../packages/secrets/resolver/index.js";

async function main() {
  const tenantId = process.argv[2];
  const userId = process.argv[3] === "null" || !process.argv[3] ? null : process.argv[3];
  const teamChain = process.argv.slice(4);

  if (!tenantId) {
    console.error("usage: bun scripts/test-resolver.ts <tenantId> <userId|null> [<teamSegment>...]");
    process.exit(2);
  }

  const config = await loadAppConfig();
  const app = new AppContext(config);
  await app.boot();
  try {
    const resolver = new HierarchicalSecretResolver(app.secrets);
    const env = await resolver.resolveAll({ tenant_id: tenantId, user_id: userId }, teamChain);
    console.log("Inputs:");
    console.log(`  tenant_id  = ${tenantId}`);
    console.log(`  user_id    = ${userId ?? "<none>"}`);
    console.log(`  team_chain = [${teamChain.join(", ")}]`);
    console.log("");
    console.log("Resolved env (key=value):");
    const entries = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
    for (const [k, v] of entries) {
      const masked = k === "TEST_SSM_RESOLUTION" ? v : `<redacted ${v.length}B>`;
      console.log(`  ${k} = ${masked}`);
    }
    console.log("");
    console.log(`TEST_SSM_RESOLUTION = ${env.TEST_SSM_RESOLUTION ?? "<missing>"}`);
  } finally {
    await app.shutdown();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
