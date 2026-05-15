/**
 * CLI integration tests for `ark secrets ...` subcommands.
 *
 * These exercise the action handlers directly (via the exported
 * `performSecretSet` / `performBlobUpload` helpers) rather than spawning
 * the full CLI subprocess -- the intent is to cover that the new --type
 * and --metadata flags propagate into `app.secrets.set` /
 * `app.secrets.setBlob`, and that listing / describing surfaces them.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppContext } from "../../core/app.js";
import { setInProcessApp } from "../app-client.js";
import { performSecretSet, performBlobUpload } from "../commands/secrets.js";

let app: AppContext;
let tenantId: string;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setInProcessApp(app);
  tenantId = app.config.authSection.defaultTenant ?? "default";
});

afterAll(async () => {
  setInProcessApp(null);
  await app?.shutdown();
});

beforeEach(async () => {
  // Wipe between tests so each one sees an empty tenant. The file
  // provider's list() returns both legacy flat names and path-shaped
  // names; route each via the matching delete primitive.
  for (const r of await app.secrets.list(tenantId)) {
    if (r.name.startsWith("/ark/") && app.secrets.deleteAtPath) {
      await app.secrets.deleteAtPath(r.name);
    } else {
      await app.secrets.delete(tenantId, r.name);
    }
  }
  // Also walk the full /ark/<tid>/ prefix for any path-shaped entries
  // that escaped the legacy list above.
  const entries = await app.secrets.listAt(`/ark/${tenantId}/`);
  for (const e of entries) {
    if (app.secrets.deleteAtPath) await app.secrets.deleteAtPath(e.name);
  }
  for (const r of await app.secrets.listBlobsDetailed(tenantId)) {
    await app.secrets.deleteBlob(tenantId, r.name);
  }
});

describe("ark secrets set --type and --metadata", () => {
  test("stores type and metadata on the secret ref", async () => {
    await performSecretSet("BB_KEY", "PEM_BODY", {
      type: "ssh-private-key",
      metadata: { host: "bitbucket.org" },
    });
    const refs = await app.secrets.list(tenantId);
    const bb = refs.find((r) => r.name === "BB_KEY");
    expect(bb).toBeTruthy();
    expect(bb?.type).toBe("ssh-private-key");
    expect(bb?.metadata).toEqual({ host: "bitbucket.org" });
  });

  test("rejects an unknown --type value", async () => {
    await expect(performSecretSet("FOO", "v", { type: "not-a-type" as any, metadata: {} })).rejects.toThrow(
      /Invalid --type/,
    );
  });

  test("defaults type to env-var when caller does not specify", async () => {
    await performSecretSet("FOO", "v", { type: "env-var", metadata: {} });
    const refs = await app.secrets.list(tenantId);
    expect(refs.find((r) => r.name === "FOO")?.type).toBe("env-var");
  });
});

describe("ark secrets blob upload --type and --metadata", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "ark-cli-blob-"));
    writeFileSync(join(tmp, ".credentials.json"), "{}");
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("stores type and metadata on the blob ref", async () => {
    const count = await performBlobUpload("claude", tmp, {
      type: "generic-blob",
      metadata: { target_path: "~/.claude" },
    });
    expect(count).toBe(1);
    const refs = await app.secrets.listBlobsDetailed(tenantId);
    const claude = refs.find((r) => r.name === "claude");
    expect(claude).toBeTruthy();
    expect(claude?.type).toBe("generic-blob");
    expect(claude?.metadata).toEqual({ target_path: "~/.claude" });
  });

  test("rejects an unknown --type value", async () => {
    await expect(performBlobUpload("nope", tmp, { type: "bogus" as any, metadata: {} })).rejects.toThrow(
      /Invalid --type/,
    );
  });
});

/**
 * Drive a secrets subcommand through Commander and capture stdout. We wire
 * the registered commands onto a fresh root each call so we don't carry
 * state between tests.
 */
async function captureSecretsCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { Command } = await import("commander");
  const { registerSecretsCommands } = await import("../commands/secrets.js");
  const root = new Command();
  root.exitOverride();
  registerSecretsCommands(root);

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: any[]) => stdoutLines.push(a.map(String).join(" "));
  console.error = (...a: any[]) => stderrLines.push(a.map(String).join(" "));
  try {
    await root.parseAsync(["node", "ark", ...args]);
  } finally {
    console.log = origLog;
    console.error = origErr;
    // Commander actions may set process.exitCode for non-zero CLI exits;
    // reset so the test runner does not inherit a stale non-zero code.
    process.exitCode = 0;
  }
  return { stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n") };
}

describe("ark secrets list TYPE column", () => {
  test("renders TYPE column for string secrets", async () => {
    await performSecretSet("FOO", "v", { type: "env-var", metadata: {} });
    await performSecretSet("BB_KEY", "v", {
      type: "ssh-private-key",
      metadata: { host: "bitbucket.org" },
    });
    const { stdout } = await captureSecretsCommand(["secrets", "list"]);
    expect(stdout).toContain("TYPE");
    expect(stdout).toMatch(/FOO\s+env-var/);
    expect(stdout).toMatch(/BB_KEY\s+ssh-private-key/);
  });

  test("renders TYPE column for blob list", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ark-cli-blob-list-"));
    try {
      writeFileSync(join(tmp, "a.txt"), "x");
      await performBlobUpload("claude", tmp, {
        type: "generic-blob",
        metadata: { target_path: "~/.claude" },
      });
      const { stdout } = await captureSecretsCommand(["secrets", "blob", "list"]);
      expect(stdout).toContain("TYPE");
      expect(stdout).toMatch(/claude\s+generic-blob/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("ark secrets set --scope routing", () => {
  test("default --scope tenant writes the legacy flat name", async () => {
    await performSecretSet("BARE", "v", { type: "env-var", metadata: {} });
    const refs = await app.secrets.list(tenantId);
    expect(refs.map((r) => r.name)).toContain("BARE");
    // The path-aware lookup also surfaces it at /ark/<tid>/tenant/BARE
    const entries = await app.secrets.listAt(`/ark/${tenantId}/tenant/`);
    expect(entries.find((e) => e.name.endsWith("/BARE"))).toBeTruthy();
  });

  test("--scope user --scope-id u1 writes at /ark/<tid>/users/u1/<KEY>", async () => {
    await performSecretSet("USER_KEY", "v", {
      type: "env-var",
      metadata: {},
      scope: "user",
      scopeId: "u1",
    });
    const entries = await app.secrets.listAt(`/ark/${tenantId}/users/u1/`);
    expect(entries.map((e) => e.name)).toEqual([`/ark/${tenantId}/users/u1/USER_KEY`]);
    // ...and NOT at tenant prefix.
    const tenantEntries = await app.secrets.listAt(`/ark/${tenantId}/tenant/`);
    expect(tenantEntries.find((e) => e.name.endsWith("/USER_KEY"))).toBeUndefined();
  });

  test("--scope team --scope-id platform/eng writes at multi-segment team path", async () => {
    await performSecretSet("TEAM_KEY", "v", {
      type: "env-var",
      metadata: {},
      scope: "team",
      scopeId: "platform/eng",
    });
    const entries = await app.secrets.listAt(`/ark/${tenantId}/teams/platform/eng/`);
    expect(entries.map((e) => e.name)).toEqual([`/ark/${tenantId}/teams/platform/eng/TEAM_KEY`]);
  });

  test("rejects --scope team without --scope-id", async () => {
    await expect(performSecretSet("X", "v", { type: "env-var", metadata: {}, scope: "team" })).rejects.toThrow(
      /scope-id is required/,
    );
  });

  test("rejects --scope tenant with --scope-id", async () => {
    await expect(
      performSecretSet("X", "v", { type: "env-var", metadata: {}, scope: "tenant", scopeId: "anything" }),
    ).rejects.toThrow(/must NOT be set/);
  });

  test("rejects an unknown --scope value", async () => {
    await expect(performSecretSet("X", "v", { type: "env-var", metadata: {}, scope: "global" })).rejects.toThrow(
      /Invalid --scope/,
    );
  });
});

describe("ark secrets list --scope routing", () => {
  test("list --scope user enumerates by KEY column", async () => {
    await performSecretSet("FOO", "v", {
      type: "env-var",
      metadata: {},
      scope: "user",
      scopeId: "u1",
    });
    const { stdout } = await captureSecretsCommand(["secrets", "list", "--scope", "user", "--scope-id", "u1"]);
    expect(stdout).toContain("KEY");
    expect(stdout).toContain("FOO");
    expect(stdout).toContain(`/ark/${tenantId}/users/u1/FOO`);
  });
});

describe("ark secrets describe", () => {
  test("prints type, metadata, and placement preview for a string secret", async () => {
    await performSecretSet("BB", "v", {
      type: "ssh-private-key",
      metadata: { host: "bitbucket.org" },
    });
    const { stdout } = await captureSecretsCommand(["secrets", "describe", "BB"]);
    expect(stdout).toContain("Type:        ssh-private-key");
    expect(stdout).toContain('"host":"bitbucket.org"');
    expect(stdout).toContain("Placement:");
    expect(stdout).toContain("EC2 places at ~/.ssh/id_<name>");
  });

  test("falls back to blob lookup when name is not a string secret", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ark-cli-describe-blob-"));
    try {
      writeFileSync(join(tmp, "a.txt"), "x");
      await performBlobUpload("claude", tmp, {
        type: "generic-blob",
        metadata: { target_path: "~/.claude" },
      });
      const { stdout } = await captureSecretsCommand(["secrets", "describe", "claude"]);
      expect(stdout).toContain("Type:        generic-blob");
      expect(stdout).toContain('"target_path":"~/.claude"');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("reports a missing secret on stderr", async () => {
    const { stderr } = await captureSecretsCommand(["secrets", "describe", "MISSING"]);
    expect(stderr).toMatch(/MISSING.*not found/);
  });
});
