/**
 * Scoping override admin CLI. Dispatches to `admin/scoping/*` RPCs
 * which gate on admin role and apply the same write-time validation
 * (scope-id existence + per-key value-shape + value-in-catalog) so
 * a typo'd runtime / model / compute / flow name is rejected here
 * rather than at the next user's `session/start`.
 *
 *   ark scoping set    --scope <user|team|tenant> --scope-id <id> \
 *                      --key <key> --value <json>
 *   ark scoping list   [--scope ...] [--scope-id ...] [--key ...]
 *                      [--include-deleted]
 *   ark scoping get    <id>
 *   ark scoping delete <id>
 *                      OR
 *   ark scoping delete --scope <kind> --scope-id <id> --key <key>
 *
 * `--value` accepts a JSON literal. Examples:
 *   --value '"codex"'                       (string)
 *   --value '["docs","pr-review"]'          (string[])
 *   --value '{"mode":"auto"}'               (object)
 */

import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "../app-client.js";
import { runAction } from "./_shared.js";

type ScopeKind = "user" | "team" | "tenant";

function assertScope(scope: string | undefined): ScopeKind {
  if (scope !== "user" && scope !== "team" && scope !== "tenant") {
    console.error(chalk.red(`--scope must be one of: user, team, tenant (got '${scope}')`));
    process.exit(1);
  }
  return scope;
}

function parseJsonValue(raw: string | undefined): unknown {
  if (raw === undefined) {
    console.error(chalk.red("--value is required"));
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.error(chalk.red(`--value must be a JSON literal (got: ${raw})`));
    console.error(chalk.dim(`  e.g. --value '"codex"' for a string, --value '["docs"]' for an array`));
    process.exit(1);
  }
}

interface DisplayRow {
  id: string;
  scope_kind: string;
  scope_id: string;
  key: string;
  value_json: string;
  set_by: string | null;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * Column widths sized to the actual rows in this batch so a single
 * long `scope_id` or `key` doesn't desync alignment across the rest.
 * Fixed minimums keep narrow tables readable (single-row lists).
 */
function columnWidths(rows: DisplayRow[]) {
  const max = (sel: (r: DisplayRow) => string, floor: number) =>
    rows.reduce((w, r) => Math.max(w, sel(r).length), floor);
  return {
    id: max((r) => r.id, 36),
    scope_kind: max((r) => r.scope_kind, 7),
    scope_id: max((r) => r.scope_id, 20),
    key: max((r) => r.key, 20),
  };
}

function formatRow(row: DisplayRow, widths: ReturnType<typeof columnWidths>): string {
  const deleted = row.deleted_at ? chalk.red(" (deleted)") : "";
  const author = row.set_by ? ` by ${row.set_by}` : "";
  return `  ${row.id.padEnd(widths.id)} ${row.scope_kind.padEnd(widths.scope_kind)} ${row.scope_id.padEnd(widths.scope_id)} ${row.key.padEnd(widths.key)} ${row.value_json}${author} updated ${row.updated_at.slice(0, 19)}${deleted}`;
}

export function registerScopingCommands(program: Command) {
  const scopingCmd = program.command("scoping").description("Manage org-level scoping overrides (admin only)");

  scopingCmd
    .command("set")
    .description("Set or update a scoping override")
    .option("--scope <kind>", "Scope kind: user, team, or tenant")
    .option("--scope-id <id>", "Target id (user id, team id, or tenant id)")
    .option("--key <key>", "Override key (e.g. runtime, model, compute.default, flow.allowlist)")
    .option("--value <json>", "Value as a JSON literal (e.g. '\"codex\"' or '[\"docs\"]')")
    .action(async (opts: any) => {
      const scope = assertScope(opts.scope);
      if (!opts.scopeId) {
        console.error(chalk.red("--scope-id is required"));
        process.exit(1);
      }
      if (!opts.key) {
        console.error(chalk.red("--key is required"));
        process.exit(1);
      }
      const value = parseJsonValue(opts.value);
      await runAction("scoping set", async () => {
        const ark = await getArkClient();
        const row = await ark.scopingSet({
          scope_kind: scope,
          scope_id: opts.scopeId,
          key: opts.key,
          value,
        });
        console.log(chalk.green("Override set."));
        console.log();
        console.log(formatRow(row, columnWidths([row])));
      });
    });

  scopingCmd
    .command("list")
    .description("List scoping overrides for the calling tenant")
    .option("--scope <kind>", "Filter by scope kind (user/team/tenant)")
    .option("--scope-id <id>", "Filter by scope id")
    .option("--key <key>", "Filter by override key")
    .option("--include-deleted", "Include soft-deleted rows (tombstones)")
    .action(async (opts: any) => {
      await runAction("scoping list", async () => {
        const ark = await getArkClient();
        const { rows, truncated } = await ark.scopingListPage({
          ...(opts.scope ? { scope_kind: assertScope(opts.scope) } : {}),
          ...(opts.scopeId ? { scope_id: opts.scopeId } : {}),
          ...(opts.key ? { key: opts.key } : {}),
          ...(opts.includeDeleted ? { includeDeleted: true } : {}),
        });
        if (!rows.length) {
          console.log(chalk.dim("No scoping overrides match."));
          return;
        }
        console.log(chalk.bold(`Scoping overrides (${rows.length}):`));
        console.log();
        const widths = columnWidths(rows);
        for (const r of rows) console.log(formatRow(r, widths));
        if (truncated) {
          console.log();
          console.log(
            chalk.yellow(
              `Result hit the server's safety cap (${rows.length} rows shown). ` +
                `Some matches were omitted -- narrow the filter (--scope / --scope-id / --key) to see them.`,
            ),
          );
        }
      });
    });

  scopingCmd
    .command("get")
    .description("Show a single scoping override by id")
    .argument("<id>", "Override row id")
    .action(async (id: string) => {
      await runAction("scoping get", async () => {
        const ark = await getArkClient();
        const row = await ark.scopingGet(id);
        console.log(formatRow(row, columnWidths([row])));
      });
    });

  scopingCmd
    .command("delete")
    .description("Soft-delete a scoping override")
    .argument("[id]", "Override row id (alternative to --scope/--scope-id/--key)")
    .option("--scope <kind>", "Composite delete: scope kind")
    .option("--scope-id <scope-id>", "Composite delete: scope id")
    .option("--key <key>", "Composite delete: key")
    .action(async (id: string | undefined, opts: any) => {
      const hasComposite = Boolean(opts.scope || opts.scopeId || opts.key);
      if (id && hasComposite) {
        console.error(chalk.red("Pass EITHER an id OR --scope/--scope-id/--key, not both"));
        process.exit(1);
      }
      if (!id && !hasComposite) {
        console.error(chalk.red("Pass an id OR --scope/--scope-id/--key"));
        process.exit(1);
      }
      await runAction("scoping delete", async () => {
        const ark = await getArkClient();
        let ok = false;
        if (id) {
          ok = await ark.scopingDelete({ id });
        } else {
          if (!opts.scope || !opts.scopeId || !opts.key) {
            console.error(chalk.red("composite delete requires --scope, --scope-id, AND --key"));
            process.exit(1);
          }
          ok = await ark.scopingDelete({
            scope_kind: assertScope(opts.scope),
            scope_id: opts.scopeId,
            key: opts.key,
          });
        }
        if (ok) {
          console.log(chalk.green("Override deleted."));
        } else {
          console.log(chalk.yellow("No live override matched (already deleted or never existed)."));
        }
      });
    });
}
