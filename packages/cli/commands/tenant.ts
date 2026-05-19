/**
 * CLI commands for tenant management:
 *   ark tenant list / create / update / delete / suspend / resume
 *   ark tenant policy *   (admin/tenant/policy/* over RPC)
 *
 * Every tenant-lifecycle command dispatches via ArkClient against the
 * admin/tenant/* handlers. Policy commands also go through ArkClient now
 * that admin/tenant/policy/* is wired on the server.
 */

import type { Command } from "commander";
import chalk from "chalk";
import type { ComputeAxes, ComputeKindName, IsolationKindName } from "../../types/index.js";
import { getArkClient } from "../app-client.js";
import { runAction } from "./_shared.js";

/** Parse a "compute_kind/isolation_kind" CLI token into a ComputeAxes. */
function parseAxes(token: string): ComputeAxes {
  const [ck, ik] = token.split("/").map((s) => s.trim());
  if (!ck || !ik) {
    throw new Error(`Invalid compute pair "${token}" -- expected "compute_kind/isolation_kind" (e.g. k8s/direct)`);
  }
  return { compute_kind: ck as ComputeKindName, isolation_kind: ik as IsolationKindName };
}

/** Render a compute pair as "compute_kind/isolation_kind". */
function fmtAxes(a: { compute_kind: string; isolation_kind: string }): string {
  return `${a.compute_kind}/${a.isolation_kind}`;
}

export function registerTenantCommands(program: Command) {
  const tenant = program.command("tenant").description("Manage tenant settings");
  const policy = tenant.command("policy").description("Manage tenant compute policies");

  // ── Tenant lifecycle ─────────────────────────────────────────────────

  tenant
    .command("list")
    .description("List all tenants")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      await runAction("tenant list", async () => {
        const ark = await getArkClient();
        const rows = await ark.adminTenantList();
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (!rows.length) {
          console.log(chalk.dim("No tenants yet."));
          return;
        }
        console.log(`  ${"ID".padEnd(22)} ${"SLUG".padEnd(20)} ${"NAME".padEnd(24)} STATUS`);
        for (const t of rows) {
          console.log(`  ${t.id.padEnd(22)} ${t.slug.padEnd(20)} ${t.name.padEnd(24)} ${t.status}`);
        }
      });
    });

  tenant
    .command("create")
    .description("Create a new tenant")
    .argument("<slug>", "Kebab-case slug (unique)")
    .option("--name <name>", "Human-readable name (defaults to slug)")
    .option("--json", "Output raw JSON")
    .action(async (slug, opts) => {
      await runAction("tenant create", async () => {
        const ark = await getArkClient();
        const t = await ark.adminTenantCreate({ slug, name: opts.name ?? slug });
        if (opts.json) console.log(JSON.stringify(t, null, 2));
        else console.log(chalk.green(`Tenant created: ${t.id} (slug=${t.slug})`));
      });
    });

  tenant
    .command("update")
    .description("Update a tenant's slug / name / status")
    .argument("<id>", "Tenant id or slug")
    .option("--slug <slug>", "New slug")
    .option("--name <name>", "New name")
    .option("--status <status>", "active | suspended | archived")
    .action(async (id, opts) => {
      await runAction("tenant update", async () => {
        const ark = await getArkClient();
        const current = await ark.adminTenantGet(id);
        if (!current) {
          console.log(chalk.red(`Tenant '${id}' not found`));
          return;
        }
        const t = await ark.adminTenantUpdate({
          id: current.id,
          ...(opts.slug ? { slug: opts.slug } : {}),
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.status ? { status: opts.status } : {}),
        });
        console.log(chalk.green(`Tenant updated: ${t?.id}`));
      });
    });

  tenant
    .command("delete")
    .description("Delete a tenant (cascades teams + memberships, leaves sessions/computes behind)")
    .argument("<id>", "Tenant id or slug")
    .action(async (id) => {
      await runAction("tenant delete", async () => {
        const ark = await getArkClient();
        const current = await ark.adminTenantGet(id);
        if (!current) {
          console.log(chalk.red(`Tenant '${id}' not found`));
          return;
        }
        const ok = await ark.adminTenantDelete(current.id);
        console.log(ok ? chalk.green(`Tenant deleted: ${current.id}`) : chalk.red("Delete failed"));
      });
    });

  tenant
    .command("suspend")
    .description("Set tenant status to 'suspended'")
    .argument("<id>", "Tenant id or slug")
    .action(async (id) => {
      await runAction("tenant suspend", async () => {
        const ark = await getArkClient();
        const current = await ark.adminTenantGet(id);
        if (!current) {
          console.log(chalk.red(`Tenant '${id}' not found`));
          return;
        }
        await ark.adminTenantSetStatus(current.id, "suspended");
        console.log(chalk.yellow(`Tenant '${current.id}' suspended`));
      });
    });

  tenant
    .command("resume")
    .description("Set tenant status to 'active'")
    .argument("<id>", "Tenant id or slug")
    .action(async (id) => {
      await runAction("tenant resume", async () => {
        const ark = await getArkClient();
        const current = await ark.adminTenantGet(id);
        if (!current) {
          console.log(chalk.red(`Tenant '${id}' not found`));
          return;
        }
        await ark.adminTenantSetStatus(current.id, "active");
        console.log(chalk.green(`Tenant '${current.id}' active`));
      });
    });

  // ── Policy subcommands (RPC: admin/tenant/policy/*) ──────────────────

  policy
    .command("set")
    .description("Set compute policy for a tenant")
    .argument("<tenant-id>", "Tenant ID")
    .option(
      "--allow <ck/ik>",
      'Allowed compute pair "compute_kind/isolation_kind" (repeatable, e.g. k8s/direct)',
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option("--default <ck/ik>", 'Default compute pair "compute_kind/isolation_kind"', "k8s/direct")
    .option("--max-sessions <n>", "Maximum concurrent sessions", "10")
    .option("--max-cost <usd>", "Maximum daily cost in USD")
    .action(async (tenantId, opts) => {
      await runAction("tenant policy set", async () => {
        const ark = await getArkClient();
        const allowedCompute = (opts.allow as string[]).map(parseAxes);
        const defaultCompute = parseAxes(opts.default);

        await ark.tenantPolicySet({
          tenant_id: tenantId,
          allowed_compute: allowedCompute,
          default_compute: defaultCompute,
          max_concurrent_sessions: parseInt(opts.maxSessions, 10),
          max_cost_per_day_usd: opts.maxCost ? parseFloat(opts.maxCost) : null,
        });

        console.log(chalk.green(`Policy set for tenant '${tenantId}'`));
        console.log(
          `  Allowed compute: ${allowedCompute.length > 0 ? allowedCompute.map(fmtAxes).join(", ") : "(all)"}`,
        );
        console.log(`  Default compute: ${fmtAxes(defaultCompute)}`);
        console.log(`  Max sessions:    ${opts.maxSessions}`);
        if (opts.maxCost) {
          console.log(`  Max daily cost:  $${opts.maxCost}`);
        }
      });
    });

  policy
    .command("get")
    .description("Get compute policy for a tenant")
    .argument("<tenant-id>", "Tenant ID")
    .action(async (tenantId) => {
      await runAction("tenant policy get", async () => {
        const ark = await getArkClient();
        const p = await ark.tenantPolicyGet(tenantId);

        if (!p) {
          console.log(chalk.dim(`No explicit policy for tenant '${tenantId}'. Default policy applies.`));
          console.log(chalk.dim("  Allowed compute: (all)"));
          console.log(chalk.dim("  Default compute: k8s/direct"));
          console.log(chalk.dim("  Max sessions:    10"));
          return;
        }

        console.log(chalk.bold(`Policy for tenant '${tenantId}'`));
        console.log(
          `  Allowed compute: ${p.allowed_compute.length > 0 ? p.allowed_compute.map(fmtAxes).join(", ") : "(all)"}`,
        );
        console.log(`  Default compute: ${fmtAxes(p.default_compute)}`);
        console.log(`  Max sessions:    ${p.max_concurrent_sessions}`);
        if (p.max_cost_per_day_usd !== null) {
          console.log(`  Max daily cost:  $${p.max_cost_per_day_usd}`);
        }
        if (p.compute_pools.length > 0) {
          console.log(`  Compute pools:`);
          for (const pool of p.compute_pools) {
            console.log(
              `    - ${pool.pool_name} (${pool.compute.compute_kind}/${pool.compute.isolation_kind}) min=${pool.min} max=${pool.max}`,
            );
          }
        }
      });
    });

  policy
    .command("list")
    .description("List all tenant compute policies")
    .action(async () => {
      await runAction("tenant policy list", async () => {
        const ark = await getArkClient();
        const policies = await ark.tenantPolicyList();

        if (!policies.length) {
          console.log(chalk.dim("No tenant policies configured. Default policy applies to all tenants."));
          return;
        }

        console.log(
          `  ${"TENANT".padEnd(20)} ${"ALLOWED".padEnd(28)} ${"DEFAULT".padEnd(14)} ${"MAX SESS".padEnd(10)} COST/DAY`,
        );
        for (const p of policies) {
          const allowed = p.allowed_compute.length > 0 ? p.allowed_compute.map(fmtAxes).join(",") : "(all)";
          const cost = p.max_cost_per_day_usd !== null ? `$${p.max_cost_per_day_usd}` : "-";
          console.log(
            `  ${p.tenant_id.padEnd(20)} ${allowed.padEnd(28)} ${fmtAxes(p.default_compute).padEnd(14)} ${String(p.max_concurrent_sessions).padEnd(10)} ${cost}`,
          );
        }
      });
    });

  policy
    .command("delete")
    .description("Delete compute policy for a tenant")
    .argument("<tenant-id>", "Tenant ID")
    .action(async (tenantId) => {
      await runAction("tenant policy delete", async () => {
        const ark = await getArkClient();
        const deleted = await ark.tenantPolicyDelete(tenantId);

        if (deleted) {
          console.log(chalk.green(`Policy deleted for tenant '${tenantId}'`));
        } else {
          console.log(chalk.red(`No policy found for tenant '${tenantId}'`));
        }
      });
    });

  // ── Claude auth subcommands (RPC: admin/tenant/auth/*) ──────────────
  //
  // Per-tenant binding between the tenant and the credential material used
  // at dispatch. Two modes:
  //   - api_key         -> `secret_ref` is a string secret name
  //                        (becomes `ANTHROPIC_API_KEY` at dispatch).
  //   - subscription_blob -> `secret_ref` is a blob name
  //                        (materialized as a per-session k8s Secret at
  //                         `/root/.claude`).

  const auth = tenant.command("auth").description("Manage per-tenant Claude credential bindings");

  auth
    .command("set")
    .description("Bind a tenant to a Claude credential (api-key secret OR subscription-blob).")
    .argument("<tenant-id>", "Tenant ID (or slug)")
    .option("--api-key <name>", "Bind to a string secret storing ANTHROPIC_API_KEY")
    .option("--subscription-blob <name>", "Bind to a blob secret (the ~/.claude directory)")
    .action(async (tenantId, opts) => {
      const hasKey = typeof opts.apiKey === "string" && opts.apiKey.length > 0;
      const hasBlob = typeof opts.subscriptionBlob === "string" && opts.subscriptionBlob.length > 0;
      if (hasKey === hasBlob) {
        console.error(chalk.red("Specify exactly one of --api-key or --subscription-blob."));
        process.exitCode = 2;
        return;
      }
      await runAction("tenant auth set", async () => {
        const ark = await getArkClient();
        const kind = hasKey ? "api_key" : "subscription_blob";
        const ref = hasKey ? opts.apiKey : opts.subscriptionBlob;
        const row = await ark.tenantAuthSet(tenantId, kind, ref);
        console.log(chalk.green(`Tenant '${tenantId}' bound to ${row.kind} '${row.secret_ref}'.`));
      });
    });

  auth
    .command("show")
    .description("Show the current Claude credential binding for a tenant.")
    .argument("<tenant-id>", "Tenant ID (or slug)")
    .action(async (tenantId) => {
      await runAction("tenant auth show", async () => {
        const ark = await getArkClient();
        const row = await ark.tenantAuthGet(tenantId);
        if (!row) {
          console.log(chalk.dim(`No Claude auth binding for tenant '${tenantId}'.`));
          return;
        }
        console.log(chalk.bold(`Claude auth for tenant '${row.tenant_id}'`));
        console.log(`  Kind:       ${row.kind}`);
        console.log(`  Secret ref: ${row.secret_ref}`);
        console.log(`  Updated:    ${row.updated_at}`);
      });
    });

  auth
    .command("clear")
    .description("Remove the Claude credential binding for a tenant.")
    .argument("<tenant-id>", "Tenant ID (or slug)")
    .action(async (tenantId) => {
      await runAction("tenant auth clear", async () => {
        const ark = await getArkClient();
        const ok = await ark.tenantAuthClear(tenantId);
        if (ok) console.log(chalk.green(`Cleared Claude auth for tenant '${tenantId}'.`));
        else console.log(chalk.yellow(`No binding to clear for tenant '${tenantId}'.`));
      });
    });
}
