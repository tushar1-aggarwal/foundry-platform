/**
 * Compose lifecycle for the e2e suite.
 *
 * The Makefile target wraps these calls; they live in TS too so a debug run
 * via `bun e2e/control-plane.test.ts` can self-contain its stack lifecycle.
 *
 * Skips bring-up/tear-down when ARK_E2E_STACK_RUNNING=1 -- useful when an
 * operator already brought up the e2e stack in another terminal and just
 * wants to iterate on the test code without paying the 15s cold-start tax.
 */

import { Connection, Client } from "@temporalio/client";

const COMPOSE_FILE = ".infra/docker-compose.e2e.yaml";
const PROJECT_NAME = "ark-e2e";

// Matches the worker's task-queue derivation in packages/core/temporal/worker.ts:40.
const TEMPORAL_ADDRESS = "localhost:7234";
const TEMPORAL_NAMESPACE = "default";
const TEMPORAL_TASK_QUEUE = "ark.default.stages";

let cachedCli: string[] | null = null;

async function pickComposeCli(): Promise<string[]> {
  if (cachedCli) return cachedCli;
  // Prefer the v2 plugin (`docker compose`); fall back to the standalone
  // `docker-compose` binary which is still common on macOS Docker Desktop
  // installs that haven't migrated to the v2 plugin path.
  const probe = Bun.spawn(["docker", "compose", "version"], { stdout: "ignore", stderr: "ignore" });
  if ((await probe.exited) === 0) {
    cachedCli = ["docker", "compose"];
  } else {
    cachedCli = ["docker-compose"];
  }
  return cachedCli;
}

/**
 * Block until the Temporal worker has at least one poller registered on the
 * stages task queue. Compose's `--wait` only proves the worker *process* is
 * up (via the pgrep healthcheck), not that it has finished connecting to
 * Temporal and registered as a poller. Without this gate, the first test
 * after stackUp() races the worker's poll-registration: session/start fires,
 * the workflow lands on the task queue, and no activity worker ever picks
 * it up because the worker is still mid-init.
 *
 * Uses describeTaskQueue (gRPC) which returns the live poller list. Polls
 * every 500ms up to 90s, throws on timeout.
 */
async function waitForTemporalWorkerPolling(): Promise<void> {
  const deadline = Date.now() + 90_000;
  let connection: Connection | null = null;
  let client: Client | null = null;
  try {
    connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
    client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        const resp = await client.workflowService.describeTaskQueue({
          namespace: TEMPORAL_NAMESPACE,
          taskQueue: { name: TEMPORAL_TASK_QUEUE },
        });
        if ((resp.pollers?.length ?? 0) > 0) return;
      } catch (e) {
        lastErr = e;
      }
      await Bun.sleep(500);
    }
    throw new Error(
      `Temporal worker did not register as a poller on ${TEMPORAL_TASK_QUEUE} within 90s` +
        (lastErr ? ` (last error: ${String((lastErr as Error)?.message ?? lastErr)})` : ""),
    );
  } finally {
    if (connection) await connection.close();
  }
}

export async function up(): Promise<void> {
  // When the Makefile already brought up the stack (ARK_E2E_STACK_RUNNING=1),
  // skip the compose call but ALWAYS wait for the worker to be polling. The
  // make target's `docker compose up --wait` only blocks on healthchecks
  // (process-alive), not on Temporal poller registration -- so even on the
  // pre-up path we must do an explicit poll-readiness probe before the first
  // test issues session/start.
  if (process.env.ARK_E2E_STACK_RUNNING !== "1") {
    const cli = await pickComposeCli();
    const proc = Bun.spawn([...cli, "-f", COMPOSE_FILE, "-p", PROJECT_NAME, "up", "-d", "--wait"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`docker compose up failed (exit ${code})`);
  }
  await waitForTemporalWorkerPolling();
}

export async function down(): Promise<void> {
  if (process.env.ARK_E2E_STACK_RUNNING === "1") return;
  const cli = await pickComposeCli();
  const proc = Bun.spawn([...cli, "-f", COMPOSE_FILE, "-p", PROJECT_NAME, "down", "-v"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}
