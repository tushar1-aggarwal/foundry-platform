import type { Command } from "commander";
import chalk from "chalk";
import type { ComputeAxes, ComputeKindName, IsolationKindName } from "../../../types/index.js";
import { getInProcessApp } from "../../app-client.js";
import { ComputePoolManager } from "../../../core/compute/pool.js";
import { runAction } from "../_shared.js";

/** Parse a "compute_kind/isolation_kind" CLI token into a ComputeAxes. */
function parseAxes(token: string): ComputeAxes {
  const [ck, ik] = token.split("/").map((s) => s.trim());
  if (!ck || !ik) {
    throw new Error(`Invalid compute pair "${token}" -- expected "compute_kind/isolation_kind" (e.g. ec2/direct)`);
  }
  return { compute_kind: ck as ComputeKindName, isolation_kind: ik as IsolationKindName };
}

export function registerPoolCommands(computeCmd: Command) {
  const pool = computeCmd.command("pool").description("Manage compute pools");

  pool
    .command("create")
    .description("Create a compute pool")
    .argument("<name>", "Pool name")
    .option("--compute <ck/ik>", 'Compute pair "compute_kind/isolation_kind" (e.g. ec2/direct)', "ec2/direct")
    .option("--min <n>", "Minimum warm instances", "0")
    .option("--max <n>", "Maximum instances", "10")
    .option("--size <size>", "Instance size (provider-specific)", "m")
    .option("--region <region>", "Region (provider-specific)")
    .option("--image <image>", "Container image (provider-specific)")
    .action(async (name, opts) => {
      await runAction("compute pool create", async () => {
        const app = await getInProcessApp();
        const manager = new ComputePoolManager(app);
        const config: Record<string, unknown> = {};
        if (opts.size) config.size = opts.size;
        if (opts.region) config.region = opts.region;
        if (opts.image) config.image = opts.image;
        const pool = await manager.createPool({
          name,
          compute: parseAxes(opts.compute),
          min: parseInt(opts.min, 10),
          max: parseInt(opts.max, 10),
          config,
        });
        console.log(chalk.green(`Pool '${pool.name}' created`));
        console.log(`  Compute: ${pool.compute.compute_kind}/${pool.compute.isolation_kind}`);
        console.log(`  Min:     ${pool.min}`);
        console.log(`  Max:     ${pool.max}`);
      });
    });

  pool
    .command("list")
    .description("List compute pools")
    .action(async () => {
      await runAction("compute pool list", async () => {
        const app = await getInProcessApp();
        const manager = new ComputePoolManager(app);
        const pools = await manager.listPools();
        if (!pools.length) {
          console.log(chalk.dim("No pools. Create one: ark compute pool create <name> --provider ec2"));
          return;
        }
        console.log(
          `  ${"NAME".padEnd(20)} ${"COMPUTE".padEnd(16)} ${"MIN".padEnd(5)} ${"MAX".padEnd(5)} ${"ACTIVE".padEnd(8)} AVAIL`,
        );
        for (const p of pools) {
          const compute = `${p.compute.compute_kind}/${p.compute.isolation_kind}`;
          console.log(
            `  ${p.name.padEnd(20)} ${compute.padEnd(16)} ${String(p.min).padEnd(5)} ${String(p.max).padEnd(5)} ${String(p.active).padEnd(8)} ${p.available}`,
          );
        }
      });
    });

  pool
    .command("delete")
    .description("Delete a compute pool")
    .argument("<name>", "Pool name")
    .action(async (name) => {
      await runAction("compute pool delete", async () => {
        const app = await getInProcessApp();
        const manager = new ComputePoolManager(app);
        const deleted = await manager.deletePool(name);
        if (deleted) {
          console.log(chalk.green(`Pool '${name}' deleted`));
        } else {
          console.log(chalk.red(`Pool '${name}' not found`));
        }
      });
    });
}
