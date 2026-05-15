/**
 * CLI commands for tenant-scoped secrets management.
 *
 *   ark secrets list
 *   ark secrets set <NAME>              # reads value from stdin if piped,
 *                                       # otherwise prompts with masked input
 *   ark secrets delete <NAME> [--yes]   # --yes skips the confirm prompt
 *   ark secrets get <NAME> [--print]    # refuses to print to a TTY without --print
 *
 * All subcommands dispatch via ArkClient against secret/*. Tenant resolution
 * lives server-side: the `--tenant` flag is still accepted for explicit
 * override, but defaulting falls back to the server's auth context.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getArkClient, getInProcessApp } from "../app-client.js";
import { runAction } from "./_shared.js";
import type { SecretType } from "../../core/secrets/types.js";
import { registerDescribeCommand } from "./secrets/describe.js";
import {
  tenantPath,
  teamPath,
  userPath,
  tenantPrefix,
  teamPrefix,
  userPrefix,
  parsePath,
} from "../../secrets/resolver/index.js";

/**
 * Translate a CLI --scope + --scope-id pair into the full path under
 * `/ark/<tid>/...` where the secret lives. `tenant` scope is special-cased
 * to null so the CLI can keep writing the LEGACY flat shape on bare
 * invocation (back-compat: `~/.ark/secrets.json` stays unchanged).
 *
 * For team scope the operator passes a slash- or comma-delimited list of
 * segments via --scope-id (most-specific first), e.g. `--scope team
 * --scope-id platform/eng` -> `/ark/<tid>/teams/platform/eng/<KEY>`.
 */
type Scope = "tenant" | "team" | "user";

function parseScopeOpt(scope?: string): Scope {
  const s = (scope ?? "tenant").toLowerCase();
  if (s !== "tenant" && s !== "team" && s !== "user") {
    throw new Error(`Invalid --scope '${scope}'. Allowed: tenant, team, user`);
  }
  return s;
}

function parseTeamSegments(scopeId: string): string[] {
  // Accept slash or comma separators so operators can use whichever fits
  // their shell quoting situation.
  const parts = scopeId.split(/[\/,]/).filter((s) => s.length > 0);
  if (parts.length === 0) throw new Error("--scope-id must name at least one team segment");
  return parts;
}

interface ResolvedScope {
  scope: Scope;
  /** Full path under /ark/, or null when the scope is `tenant` AND
   *  back-compat-tenant mode is requested (we keep writing the flat name). */
  fullPath: string | null;
  /** Prefix used for listAt() queries on this scope. */
  prefix: string;
}

function resolveScopeForKey(tenantId: string, scope: Scope, scopeId: string | undefined, key: string): ResolvedScope {
  if (scope === "tenant") {
    if (scopeId) throw new Error("--scope-id must NOT be set for --scope tenant");
    // Back-compat: bare/`--scope tenant` invocation keeps the legacy flat shape.
    return { scope, fullPath: null, prefix: tenantPrefix(tenantId) };
  }
  if (!scopeId) throw new Error(`--scope-id is required for --scope ${scope}`);
  if (scope === "user") {
    return { scope, fullPath: userPath(tenantId, scopeId, key), prefix: userPrefix(tenantId, scopeId) };
  }
  // team
  const segments = parseTeamSegments(scopeId);
  return { scope, fullPath: teamPath(tenantId, segments, key), prefix: teamPrefix(tenantId, segments) };
}

function resolveScopePrefix(tenantId: string, scope: Scope, scopeId: string | undefined): string {
  if (scope === "tenant") {
    if (scopeId) throw new Error("--scope-id must NOT be set for --scope tenant");
    return tenantPrefix(tenantId);
  }
  if (!scopeId) throw new Error(`--scope-id is required for --scope ${scope}`);
  if (scope === "user") return userPrefix(tenantId, scopeId);
  return teamPrefix(tenantId, parseTeamSegments(scopeId));
}

/**
 * The set of secret types accepted by `ark secrets set` / `ark secrets blob upload`.
 * Mirrors `SecretType` from packages/core/secrets/types.ts; kept as a runtime
 * constant so the CLI can reject unknown values before we even hit the
 * provider.
 */
const ALLOWED_TYPES = ["env-var", "ssh-private-key", "generic-blob", "kubeconfig"] as const;
type AllowedType = (typeof ALLOWED_TYPES)[number];

function assertAllowedType(t: string): asserts t is AllowedType {
  if (!ALLOWED_TYPES.includes(t as AllowedType)) {
    throw new Error(`Invalid --type '${t}'. Allowed: ${ALLOWED_TYPES.join(", ")}`);
  }
}

/** Commander option callback: accumulate repeatable `--metadata key=value` flags into a record. */
function metadataCollector(val: string, prev: Record<string, string>): Record<string, string> {
  const eq = val.indexOf("=");
  if (eq < 0) throw new Error(`Invalid --metadata: '${val}' (expected key=value)`);
  return { ...prev, [val.slice(0, eq)]: val.slice(eq + 1) };
}

/** Resolve the tenant id we should write secrets under in CLI context. */
function defaultTenantId(app: Awaited<ReturnType<typeof getInProcessApp>>): string {
  return app.config.authSection.defaultTenant ?? "default";
}

export interface SecretSetOptions {
  description?: string;
  type: string;
  metadata?: Record<string, string>;
  /** Scope (tenant/team/user). Default tenant -- legacy flat write. */
  scope?: string;
  /** Required for team and user scopes. Slash- or comma-delimited segments for team. */
  scopeId?: string;
}

/**
 * Core set-secret logic, factored out so tests can drive it without having
 * to fake stdin / TTY. The CLI action handler is a thin wrapper that
 * resolves the value (stdin or masked prompt) and then delegates here.
 *
 * Routing:
 *   - `--scope tenant` (default) -> app.secrets.set(tenantId, name, value, ...)
 *     keeps writing the legacy flat shape, so back-compat is preserved.
 *   - `--scope team|user` -> app.secrets.setAtPath(tenantId, fullPath, value, ...)
 *     writes the literal path-shaped entry.
 */
export async function performSecretSet(name: string, value: string, opts: SecretSetOptions): Promise<void> {
  assertAllowedType(opts.type);
  if (value.length === 0) {
    throw new Error("Refusing to store an empty secret value.");
  }
  const app = await getInProcessApp();
  const tenantId = defaultTenantId(app);
  const scope = parseScopeOpt(opts.scope);
  const resolved = resolveScopeForKey(tenantId, scope, opts.scopeId, name);
  const setOpts = {
    description: opts.description,
    type: opts.type as SecretType,
    metadata: opts.metadata ?? {},
  };
  if (resolved.fullPath == null) {
    // tenant scope -- legacy flat write.
    await app.secrets.set(tenantId, name, value, setOpts);
  } else {
    if (!app.secrets.setAtPath) {
      throw new Error("Configured secrets backend does not implement setAtPath");
    }
    await app.secrets.setAtPath(tenantId, resolved.fullPath, value, setOpts);
  }
}

export interface BlobUploadOptions {
  type: string;
  metadata?: Record<string, string>;
}

/**
 * Core blob-upload logic. Reads every regular file in `dir` (non-recursive)
 * and writes them as a single named blob via the in-process secrets backend.
 * Throws on bad type / empty dir / not-a-directory rather than calling
 * process.exit so tests can exercise the path directly.
 */
export async function performBlobUpload(name: string, dir: string, opts: BlobUploadOptions): Promise<number> {
  assertAllowedType(opts.type);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`'${dir}' is not a directory`);
  }
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  if (entries.length === 0) {
    throw new Error(`Directory '${dir}' has no files`);
  }
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    files[entry.name] = readFileSync(join(dir, entry.name));
  }
  const app = await getInProcessApp();
  const tenantId = defaultTenantId(app);
  await app.secrets.setBlob(tenantId, name, files, {
    type: opts.type as SecretType,
    metadata: opts.metadata ?? {},
  });
  return entries.length;
}

/** Read the entire stdin to a string. Used when the caller pipes a value in. */
async function readStdin(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

/**
 * Prompt the user for a secret value. Masks each keystroke with "*" on a
 * TTY. Falls back to plain readline when stdin isn't a TTY (shouldn't
 * happen -- the caller is supposed to pipe in that case -- but we cover it).
 */
async function promptMasked(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    return await new Promise<string>((resolve) =>
      rl.question(prompt, (ans) => {
        rl.close();
        resolve(ans);
      }),
    );
  }
  stdout.write(prompt);
  return await new Promise<string>((resolve) => {
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "") {
          // Ctrl-C -- bail with a non-zero exit so shell scripts notice.
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        buf += ch;
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

export function registerSecretsCommands(program: Command): void {
  const group = program.command("secrets").description("Manage tenant-scoped secrets (env vars for sessions)");

  group
    .command("list")
    .description("List secret names (values are never returned)")
    .option("--scope <scope>", "Listing scope: tenant | team | user (default: tenant)", "tenant")
    .option("--scope-id <id>", "Required for team/user scope (team: slash- or comma-delimited segments)")
    .action(async (opts) => {
      await runAction("secrets list", async () => {
        const app = await getInProcessApp();
        const tenantId = defaultTenantId(app);
        const scope = parseScopeOpt(opts.scope);
        if (scope === "tenant" && !opts.scopeId) {
          // Back-compat: bare invocation prints the legacy flat names.
          const refs = await app.secrets.list(tenantId);
          if (refs.length === 0) {
            console.log(chalk.dim("No secrets configured."));
            return;
          }
          console.log(`  ${"NAME".padEnd(28)} ${"TYPE".padEnd(18)} ${"UPDATED".padEnd(24)} DESCRIPTION`);
          for (const r of refs) {
            const desc = r.description ?? "";
            console.log(`  ${r.name.padEnd(28)} ${r.type.padEnd(18)} ${(r.updated_at ?? "").padEnd(24)} ${desc}`);
          }
          return;
        }
        // Path-aware listing for team/user (and explicit tenant) scopes.
        const prefix = resolveScopePrefix(tenantId, scope, opts.scopeId);
        const entries = await app.secrets.listAt(prefix);
        if (entries.length === 0) {
          console.log(chalk.dim(`No secrets at ${prefix}`));
          return;
        }
        console.log(`  ${"KEY".padEnd(28)} PATH`);
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const parsed = parsePath(e.name);
          const key = parsed?.key ?? "<unparseable>";
          console.log(`  ${key.padEnd(28)} ${e.name}`);
        }
      });
    });

  group
    .command("set")
    .description("Create or replace a secret. Reads value from stdin if piped, otherwise prompts.")
    .argument("<name>", "Secret name (ASCII [A-Z0-9_]+)")
    .option("-d, --description <text>", "Human-readable description")
    .option("--type <type>", "Secret type (env-var, ssh-private-key, generic-blob, kubeconfig)", "env-var")
    .option("--metadata <kv>", "Repeatable key=value metadata pair", metadataCollector, {} as Record<string, string>)
    .option("--scope <scope>", "Write scope: tenant | team | user (default: tenant)", "tenant")
    .option("--scope-id <id>", "Required for team/user scope (team: slash- or comma-delimited segments)")
    .action(async (name: string, opts) => {
      await runAction("secrets set", async () => {
        assertAllowedType(opts.type);
        let value: string;
        if (!process.stdin.isTTY) {
          value = (await readStdin()).replace(/\r?\n$/, "");
        } else {
          value = await promptMasked(`Value for ${name}: `);
        }
        if (value.length === 0) {
          console.error(chalk.red("Refusing to store an empty secret value."));
          process.exitCode = 2;
          return;
        }
        await performSecretSet(name, value, {
          description: opts.description,
          type: opts.type,
          metadata: opts.metadata ?? {},
          scope: opts.scope,
          scopeId: opts.scopeId,
        });
        console.log(chalk.green(`Secret '${name}' stored.`));
      });
    });

  group
    .command("delete")
    .description("Delete a secret.")
    .argument("<name>", "Secret name")
    .option("-y, --yes", "Skip the confirm prompt")
    .option("--scope <scope>", "Delete scope: tenant | team | user (default: tenant)", "tenant")
    .option("--scope-id <id>", "Required for team/user scope (team: slash- or comma-delimited segments)")
    .action(async (name: string, opts) => {
      await runAction("secrets delete", async () => {
        if (!opts.yes) {
          const answer = await new Promise<string>((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question(`Delete secret '${name}'? [y/N] `, (a) => {
              rl.close();
              resolve(a.trim().toLowerCase());
            });
          });
          if (answer !== "y" && answer !== "yes") {
            console.log("Aborted.");
            return;
          }
        }
        const scope = parseScopeOpt(opts.scope);
        if (scope === "tenant" && !opts.scopeId) {
          // Back-compat: bare delete still goes through the RPC client so
          // remote / multi-tenant control planes work unchanged.
          const ark = await getArkClient();
          const removed = await ark.secretDelete(name);
          if (removed) {
            console.log(chalk.green(`Deleted secret '${name}'.`));
          } else {
            console.log(chalk.yellow(`No secret '${name}' (idempotent).`));
          }
          return;
        }
        // Path-aware delete via the in-process app for non-tenant scopes.
        const app = await getInProcessApp();
        const tenantId = defaultTenantId(app);
        const resolved = resolveScopeForKey(tenantId, scope, opts.scopeId, name);
        if (!resolved.fullPath) {
          // Defensive: scope==tenant with --scope-id was rejected above.
          throw new Error("scope resolution did not produce a full path");
        }
        if (!app.secrets.deleteAtPath) {
          throw new Error("Configured secrets backend does not implement deleteAtPath");
        }
        const removed = await app.secrets.deleteAtPath(resolved.fullPath);
        if (removed) {
          console.log(chalk.green(`Deleted secret '${name}' at ${resolved.fullPath}.`));
        } else {
          console.log(chalk.yellow(`No secret at ${resolved.fullPath} (idempotent).`));
        }
      });
    });

  // ── Blob (multi-file) subcommands ────────────────────────────────────
  //
  // A blob is a named bag of files, uploaded from a directory on disk.
  // Used today for claude subscription credentials (`~/.claude/`) where
  // the "secret" is really a small directory, not a single string.

  const blob = group.command("blob").description("Manage multi-file secret blobs (directory-shaped secrets)");

  blob
    .command("list")
    .description("List blob names (contents are never returned)")
    .action(async () => {
      await runAction("secrets blob list", async () => {
        const app = await getInProcessApp();
        const tenantId = defaultTenantId(app);
        const refs = await app.secrets.listBlobsDetailed(tenantId);
        if (refs.length === 0) {
          console.log(chalk.dim("No blob secrets configured."));
          return;
        }
        console.log(`  ${"NAME".padEnd(28)} ${"TYPE".padEnd(18)} ${"UPDATED".padEnd(24)}`);
        for (const r of refs) {
          console.log(`  ${r.name.padEnd(28)} ${r.type.padEnd(18)} ${(r.updated_at ?? "").padEnd(24)}`);
        }
      });
    });

  blob
    .command("upload")
    .description("Upload a directory as a named blob. Reads every file in <dir> (non-recursive).")
    .argument("<name>", "Blob name (lowercase kebab-case, <=63 chars)")
    .argument("<dir>", "Directory to upload")
    .option("--type <type>", "Secret type (env-var, ssh-private-key, generic-blob, kubeconfig)", "generic-blob")
    .option("--metadata <kv>", "Repeatable key=value metadata pair", metadataCollector, {} as Record<string, string>)
    .action(async (name: string, dir: string, opts) => {
      await runAction("secrets blob upload", async () => {
        const count = await performBlobUpload(name, dir, {
          type: opts.type,
          metadata: opts.metadata ?? {},
        });
        console.log(chalk.green(`Blob '${name}' uploaded (${count} file${count === 1 ? "" : "s"}).`));
      });
    });

  blob
    .command("download")
    .description("Download a blob into a directory. Creates the directory if missing.")
    .argument("<name>", "Blob name")
    .argument("<dir>", "Target directory")
    .action(async (name: string, dir: string) => {
      await runAction("secrets blob download", async () => {
        const ark = await getArkClient();
        const blobData = await ark.secretBlobGet(name);
        if (!blobData) {
          console.error(chalk.red(`Blob '${name}' not found`));
          process.exitCode = 1;
          return;
        }
        mkdirSync(dir, { recursive: true });
        const files = Object.keys(blobData.files);
        for (const filename of files) {
          const bytes = Buffer.from(blobData.files[filename], "base64");
          writeFileSync(join(dir, filename), bytes, { mode: 0o600 });
        }
        console.log(
          chalk.green(`Blob '${name}' written to ${dir} (${files.length} file${files.length === 1 ? "" : "s"}).`),
        );
      });
    });

  blob
    .command("delete")
    .description("Delete a blob.")
    .argument("<name>", "Blob name")
    .option("-y, --yes", "Skip the confirm prompt")
    .action(async (name: string, opts) => {
      await runAction("secrets blob delete", async () => {
        if (!opts.yes) {
          const answer = await new Promise<string>((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question(`Delete blob '${name}'? [y/N] `, (a) => {
              rl.close();
              resolve(a.trim().toLowerCase());
            });
          });
          if (answer !== "y" && answer !== "yes") {
            console.log("Aborted.");
            return;
          }
        }
        const ark = await getArkClient();
        const removed = await ark.secretBlobDelete(name);
        if (removed) console.log(chalk.green(`Deleted blob '${name}'.`));
        else console.log(chalk.yellow(`No blob '${name}' (idempotent).`));
      });
    });

  group
    .command("get")
    .description("Print a secret value to stdout. Refuses TTY stdout without --print.")
    .argument("<name>", "Secret name")
    .option("--print", "Allow printing to a TTY (default: refuse to prevent shoulder surfing)")
    .option("--scope <scope>", "Read scope: tenant | team | user (default: tenant)", "tenant")
    .option("--scope-id <id>", "Required for team/user scope (team: slash- or comma-delimited segments)")
    .action(async (name: string, opts) => {
      await runAction("secrets get", async () => {
        if (process.stdout.isTTY && !opts.print) {
          console.error(
            chalk.red(
              "Refusing to print a secret to a TTY. Re-run with --print, or pipe the output (e.g. `ark secrets get FOO | pbcopy`).",
            ),
          );
          process.exitCode = 2;
          return;
        }
        const scope = parseScopeOpt(opts.scope);
        let value: string | null;
        if (scope === "tenant" && !opts.scopeId) {
          const ark = await getArkClient();
          value = await ark.secretGet(name);
        } else {
          const app = await getInProcessApp();
          const tenantId = defaultTenantId(app);
          const resolved = resolveScopeForKey(tenantId, scope, opts.scopeId, name);
          if (!resolved.fullPath) {
            throw new Error("scope resolution did not produce a full path");
          }
          if (!app.secrets.getAtPath) {
            throw new Error("Configured secrets backend does not implement getAtPath");
          }
          value = await app.secrets.getAtPath(resolved.fullPath);
        }
        if (value === null) {
          console.error(chalk.red(`Secret '${name}' not found.`));
          process.exitCode = 1;
          return;
        }
        // Use process.stdout.write so there's no trailing newline that would
        // pollute a shell-substitution consumer ($(ark secrets get FOO)).
        process.stdout.write(value);
        if (process.stdout.isTTY) process.stdout.write("\n");
      });
    });

  registerDescribeCommand(group);
}
