/**
 * `ark secrets describe <name>` -- show a secret's type, metadata,
 * description, and a one-line preview of where the secret will land at
 * dispatch time. Looks up both string secrets and blob secrets so the
 * same command works for either shape.
 *
 * No values are ever printed: this command is metadata-only by design.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { runAction } from "../_shared.js";
import { getInProcessApp } from "../../app-client.js";
import { tenantPrefix, teamPrefix, userPrefix, parsePath } from "../../../secrets/resolver/index.js";

function parseScope(s: string | undefined): "tenant" | "team" | "user" {
  const v = (s ?? "tenant").toLowerCase();
  if (v !== "tenant" && v !== "team" && v !== "user") {
    throw new Error(`Invalid --scope '${s}'. Allowed: tenant, team, user`);
  }
  return v;
}

function scopePrefix(tenantId: string, scope: "tenant" | "team" | "user", scopeId: string | undefined): string {
  if (scope === "tenant") {
    if (scopeId) throw new Error("--scope-id must NOT be set for --scope tenant");
    return tenantPrefix(tenantId);
  }
  if (!scopeId) throw new Error(`--scope-id is required for --scope ${scope}`);
  if (scope === "user") return userPrefix(tenantId, scopeId);
  const segments = scopeId.split(/[\/,]/).filter((p) => p.length > 0);
  if (segments.length === 0) throw new Error("--scope-id must name at least one team segment");
  return teamPrefix(tenantId, segments);
}

/**
 * One-liner placement preview keyed by secret type. Reflects the phase
 * roadmap from the typed-secrets plan -- env-var is wired today; the
 * other types will fill in as the per-provider placers land.
 */
const PLACER_SUMMARY: Record<string, string> = {
  "env-var": "every provider exports as $name on the launcher",
  "ssh-private-key": "(Phase 2) EC2 places at ~/.ssh/id_<name>",
  "generic-blob": "(Phase 3) k8s mounts at metadata.target_path; others write files",
  kubeconfig: "(Phase 3) only the k8s provisioner consumes this",
};

export function registerDescribeCommand(secretsCmd: Command): void {
  secretsCmd
    .command("describe <name>")
    .description("Print a secret's type, metadata, and the providers that will place it")
    .option("--scope <scope>", "Lookup scope: tenant | team | user (default: tenant)", "tenant")
    .option("--scope-id <id>", "Required for team/user scope (team: slash- or comma-delimited segments)")
    .action(async (name: string, opts) => {
      await runAction("secrets describe", async () => {
        const app = await getInProcessApp();
        const tenantId = app.config.authSection.defaultTenant ?? "default";
        const scope = parseScope(opts?.scope);
        if (scope === "tenant" && !opts?.scopeId) {
          // Back-compat tenant lookup (covers blobs too).
          const refs = await app.secrets.list(tenantId);
          const blobs = await app.secrets.listBlobsDetailed(tenantId);
          const ref = refs.find((r) => r.name === name) ?? blobs.find((r) => r.name === name);
          if (!ref) {
            console.error(chalk.red(`Secret '${name}' not found in tenant '${tenantId}'.`));
            process.exitCode = 1;
            return;
          }
          console.log(chalk.bold(ref.name));
          console.log(`  Type:        ${ref.type}`);
          console.log(`  Metadata:    ${JSON.stringify(ref.metadata)}`);
          console.log(`  Description: ${(ref as { description?: string }).description ?? ""}`);
          console.log(`  Updated:     ${ref.updated_at}`);
          console.log(`  Placement:   ${PLACER_SUMMARY[ref.type] ?? "unknown type"}`);
          return;
        }
        // Path-aware lookup -- list under the scope's prefix and match by KEY.
        const prefix = scopePrefix(tenantId, scope, opts?.scopeId);
        const entries = await app.secrets.listAt(prefix);
        const hit = entries.find((e) => parsePath(e.name)?.key === name);
        if (!hit) {
          console.error(chalk.red(`Secret '${name}' not found at ${prefix}.`));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.bold(name));
        console.log(`  Path:        ${hit.name}`);
        console.log(`  Scope:       ${scope}`);
      });
    });
}
