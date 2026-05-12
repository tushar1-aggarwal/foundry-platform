/**
 * Register e2e flow + agent fixtures into a running hosted ark server via RPC.
 *
 * Hosted mode seeds builtins from <repo>/flows/definitions/ at boot
 * (packages/core/di/seed-builtins.ts), which does NOT include e2e/fixtures/.
 * To avoid permanently polluting flows/definitions/ with test-only YAMLs we
 * register them via flow/create + agent/create RPC after the server boots.
 *
 * Local mode does this in-process inside startLocalServer (calls
 * app.flows.save directly). This helper is the hosted-mode equivalent.
 */
import { readFileSync } from "fs";
import { resolve, join } from "path";
import YAML from "yaml";
import type { RpcClient } from "./rpc-client.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");

/**
 * Restart the temporal-worker container so its in-process DbResourceStore
 * cache is wiped and reseeded from Postgres. Without this, the worker
 * caches the empty flow list at boot and can't see fixtures registered
 * after via RPC -- session/start succeeds but the workflow's loadFlowActivity
 * fails with "Flow not found: e2e-docs-review".
 */
async function restartTemporalWorker(): Promise<void> {
  const proc = Bun.spawn(["docker", "restart", "ark-e2e-temporal-worker-1"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  // Give the worker a moment to re-register with Temporal.
  await Bun.sleep(3000);
}

async function createOrIgnore(
  rpc: RpcClient,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  try {
    await rpc.call(method, params);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // The hosted server's resource stores reject duplicate names. In test 2's
    // beforeAll Postgres state has already been seeded by test 1 (same docker
    // stack, same volume). Idempotency: swallow "already exists" only.
    if (/already exists/i.test(msg)) return;
    throw err;
  }
}

export async function registerE2eFixtures(rpc: RpcClient): Promise<void> {
  // claude-code runtime declares CLAUDE_CODE_OAUTH_TOKEN as a required secret
  // and dispatch validates it before launching the agent. Fake-claude doesn't
  // read it, but the runtime contract still demands a non-empty value.
  await rpc.call("secret/set", {
    tenant: "default",
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    value: "e2e-test-dummy-oauth-token",
    type: "env-var",
  });

  // Hosted mode seeds no compute targets at boot; the test references
  // compute=local everywhere, so create it before any session/start.
  await createOrIgnore(rpc, "compute/create", {
    name: "local",
    compute: "local",
    isolation: "direct",
    config: {},
  });

  const flowDef = YAML.parse(
    readFileSync(join(REPO_ROOT, "e2e/fixtures/flows/e2e-docs-review.yaml"), "utf-8"),
  );
  await createOrIgnore(rpc, "flow/create", { name: "e2e-docs-review", ...flowDef });

  const plannerDef = YAML.parse(
    readFileSync(join(REPO_ROOT, "e2e/fixtures/agents/stub-planner.yaml"), "utf-8"),
  );
  await createOrIgnore(rpc, "agent/create", { name: "stub-planner", ...plannerDef });

  const implDef = YAML.parse(
    readFileSync(join(REPO_ROOT, "e2e/fixtures/agents/stub-implementer.yaml"), "utf-8"),
  );
  await createOrIgnore(rpc, "agent/create", { name: "stub-implementer", ...implDef });

  // The temporal-worker container booted before this test ran and cached
  // an empty flow/agent list. Restart it so it re-reads from Postgres.
  await restartTemporalWorker();
}
