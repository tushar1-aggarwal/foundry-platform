/**
 * One-shot tenant seed. Bypasses the RPC tenant-admin gate by talking
 * directly to TenantsService. Run with:
 *
 *   AWS_PROFILE=... ARK_KEK_BACKEND=... ARK_KEK_SSM_PARAMETER=... \
 *     ARK_SECRETS_BACKEND=aws bun scripts/seed-tenant.ts <slug> <name>
 *
 * NOTE: stop the daemon first to avoid concurrent boot-time migrations
 *       against the same SQLite file.
 */
import { AppContext } from "../packages/core/app.js";
import { loadAppConfig } from "../packages/core/config.js";

async function main() {
  const slug = process.argv[2];
  const name = process.argv[3] ?? slug;
  if (!slug) {
    console.error("usage: bun scripts/seed-tenant.ts <slug> [name]");
    process.exit(2);
  }
  const config = await loadAppConfig();
  const app = new AppContext(config);
  await app.boot();
  try {
    const tenant = await app.tenants.create({ slug, name });
    console.log(JSON.stringify(tenant, null, 2));
  } finally {
    await app.shutdown();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
