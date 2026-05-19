import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient, getInProcessApp } from "../../app-client.js";
import { runAction } from "../_shared.js";

export function registerTemplateCommands(computeCmd: Command) {
  const template = computeCmd.command("template").description("Manage compute templates");

  template
    .command("list")
    .description("List compute templates")
    .action(async () => {
      await runAction("compute template list", async () => {
        const app = await getInProcessApp();
        const templates = await app.computeTemplates.list();
        const configTemplates = app.config.computeTemplates ?? [];
        const dbNames = new Set(templates.map((t) => t.name));
        type TemplateRow = { name: string; description?: string; compute?: string; isolation?: string };
        const rows: TemplateRow[] = [
          ...templates.map((t) => ({
            name: t.name,
            description: t.description,
            compute: t.compute,
            isolation: t.isolation,
          })),
          ...configTemplates
            .filter((t) => !dbNames.has(t.name))
            .map((t) => ({ name: t.name, description: t.description, compute: t.compute, isolation: t.isolation })),
        ];

        if (!rows.length) {
          console.log(chalk.dim("No templates. Add to ~/.ark/config.yaml:"));
          console.log(chalk.dim("  compute_templates:"));
          console.log(chalk.dim("    gpu-large:"));
          console.log(chalk.dim("      compute: ec2"));
          console.log(chalk.dim("      isolation: direct"));
          console.log(chalk.dim("      region: us-east-1"));
          return;
        }

        console.log(`  ${"NAME".padEnd(20)} ${"COMPUTE/ISOLATION".padEnd(22)} DESCRIPTION`);
        for (const t of rows) {
          const ax = `${t.compute ?? "-"}/${t.isolation ?? "-"}`;
          console.log(`  ${t.name.padEnd(20)} ${ax.padEnd(22)} ${t.description ?? ""}`);
        }
      });
    });

  template
    .command("show")
    .description("Show a compute template")
    .argument("<name>", "Template name")
    .action(async (name) => {
      await runAction("compute template show", async () => {
        const app = await getInProcessApp();
        let tmpl: any = await app.computeTemplates.get(name);
        if (!tmpl) {
          const cfgTmpl = (app.config.computeTemplates ?? []).find((t) => t.name === name);
          if (cfgTmpl) tmpl = cfgTmpl;
        }
        if (!tmpl) {
          console.log(chalk.red(`Template '${name}' not found.`));
          return;
        }
        console.log(chalk.bold(tmpl.name));
        if (tmpl.description) console.log(`  Description: ${tmpl.description}`);
        console.log(`  Compute:    ${tmpl.compute ?? "-"}`);
        console.log(`  Isolation:  ${tmpl.isolation ?? "-"}`);
        console.log(`  Config:`);
        for (const [k, v] of Object.entries(tmpl.config ?? {})) {
          console.log(`    ${k}: ${JSON.stringify(v)}`);
        }
      });
    });

  template
    .command("create")
    .description("Create a compute template (convenience alias for 'compute create --template')")
    .argument("<name>", "Template name")
    .requiredOption("--compute <kind>", "Compute kind (local, ec2, k8s)")
    .requiredOption("--isolation <kind>", "Isolation kind (direct, docker, compose, devcontainer, worktree)")
    .option("--description <desc>", "Description")
    .option("--size <size>", "Instance size (ec2)")
    .option("--arch <arch>", "Architecture (ec2)")
    .option("--aws-region <region>", "AWS region (ec2)")
    .option("--aws-profile <profile>", "AWS profile (ec2)")
    .option("--image <image>", "Docker image (docker)")
    .option("--namespace <ns>", "K8s namespace (k8s)")
    .action(async (name, opts) => {
      await runAction("compute template create", async () => {
        const config: Record<string, unknown> = {};
        if (opts.size) config.size = opts.size;
        if (opts.arch) config.arch = opts.arch;
        if (opts.awsRegion) config.region = opts.awsRegion;
        if (opts.awsProfile) config.aws_profile = opts.awsProfile;
        if (opts.image) config.image = opts.image;
        if (opts.namespace) config.namespace = opts.namespace;

        const ark = await getArkClient();
        await ark.computeCreate({
          name,
          compute: opts.compute,
          isolation: opts.isolation,
          config,
          is_template: true,
        } as any);

        console.log(chalk.green(`Created TEMPLATE '${name}' (${opts.compute}/${opts.isolation})`));
        for (const [k, v] of Object.entries(config)) {
          console.log(`  ${k}: ${v}`);
        }
      });
    });

  template
    .command("delete")
    .description("Delete a compute template")
    .argument("<name>", "Template name")
    .action(async (name) => {
      await runAction("compute template delete", async () => {
        const app = await getInProcessApp();
        app.computeTemplates.delete(name);
        console.log(chalk.green(`Template '${name}' deleted`));
      });
    });
}
