/**
 * AppContext boot internals: pre-container bootstrap + the post-container
 * rehydration sweeps that re-arm process-local session machinery a daemon
 * restart would orphan.
 */

import { mkdirSync } from "fs";
import { buildSqliteDrizzle, buildPostgresDrizzle, type DrizzleClient } from "./drizzle/index.js";
import type { DatabaseAdapter } from "./database/index.js";
import { ComputeTemplateRepository as ComputeTemplateRepositoryCtor } from "./repositories/index.js";
import { setLogArkDir } from "./observability/structured-log.js";
import { setProfilesArkDir } from "./services/profile.js";
import type { AppContext } from "./app.js";

// ── Pre-container bootstrap ─────────────────────────────────────────────────

export function initFilesystem(app: AppContext): void {
  // Hosted mode: the conductor is a stateless multi-tenant control-plane
  // process. Per-process arkDir paths are not tenant-scoped and are lost
  // on pod restart, so we never materialise them. The structured-log file
  // sink and the profiles store both no-op when their arkDir is null --
  // skipping the setLog*/setProfiles* calls keeps them that way.
  //
  // We also stamp `ARK_MODE=hosted` on the process env so leaf helpers
  // (`claude/trust.ts`, anything that can't take an AppContext) can gate
  // local-fs writes without re-importing AppContext.
  //
  // Local mode keeps the existing behaviour: mkdir the four standard dirs
  // (ark/tracks/worktrees/logs) and bind the JSONL log + profiles file to
  // arkDir so subsequent writes land on disk.
  if (app.mode.kind === "hosted") {
    process.env.ARK_MODE = "hosted";
    return;
  }

  for (const dir of [app.config.dirs.ark, app.config.dirs.tracks, app.config.dirs.worktrees, app.config.dirs.logs]) {
    mkdirSync(dir, { recursive: true });
  }
  setLogArkDir(app.config.dirs.ark);
  setProfilesArkDir(app.config.dirs.ark);
}

/** Opens the DB adapter + matching drizzle client. The caller assigns the
 *  drizzle client onto AppContext (it owns that field). */
export async function openDatabase(app: AppContext): Promise<{ db: DatabaseAdapter; drizzle: DrizzleClient }> {
  // `app.mode` lazily builds a `preBootMode` when the container isn't up
  // yet -- safe at boot-time because `buildAppMode` is a pure function of
  // config. All downstream dialect decisions read `mode.database.dialect`
  // instead of re-sniffing `databaseUrl`, so this is the ONE place in the
  // codebase that converts a URL into a dialect + constructs the adapter.
  if (app.mode.database.dialect === "postgres") {
    const { PostgresAdapter } = await import("./database/postgres.js");
    const adapter = new PostgresAdapter(app.mode.database.url!);
    // Expose a drizzle client sharing the same postgres.js connection so
    // repository rewrites (Phase B of the cutover) can opt in incrementally
    // without spinning up a second pool.
    return { db: adapter, drizzle: buildPostgresDrizzle(adapter.connection) };
  }
  // bun:sqlite + BunSqliteAdapter are loaded lazily so the worker, which
  // only runs in Postgres mode, can boot under Node without these imports
  // failing at module load time. See feedback memory on the Bun <-> Temporal
  // worker SDK V8 isolate hang -- the worker now runs on Node.
  const { Database } = await import("bun:sqlite");
  const { BunSqliteAdapter } = await import("./database/index.js");
  const rawDb = new Database(app.config.dbPath);
  rawDb.run("PRAGMA journal_mode = WAL");
  rawDb.run("PRAGMA busy_timeout = 5000");
  return { db: new BunSqliteAdapter(rawDb), drizzle: buildSqliteDrizzle(rawDb) };
}

export async function initSchema(app: AppContext, db: DatabaseAdapter): Promise<void> {
  // Schema bootstrap + ongoing migrations both flow through AppMode.migrations.
  // The capability is dialect-bound at construction; the runner records
  // every applied version in `ark_schema_migrations`. Backwards compat for
  // pre-migration installs (laptop SQLite + the running pai-risk-mlops
  // Postgres) is handled inside the runner: if the apply log is empty but
  // the canonical legacy `compute` table exists, 001_initial is recorded
  // as already-applied so its body doesn't re-run.
  await app.mode.migrations.apply(db);
  await app.mode.computeBootstrap.seed(db);
}

export async function seedComputeTemplates(app: AppContext, db: DatabaseAdapter): Promise<void> {
  if (!app.config.computeTemplates?.length) return;
  // Seed under the `__system__` sentinel tenant. Every tenant-scoped
  // `computeTemplates.list/get` unions in system rows, so hosted
  // deployments see the seeded blueprints from every tenant without
  // duplicating one row per tenant. A tenant can override any system
  // template by creating one of the same name under their own tenant_id.
  const { SYSTEM_TENANT_ID } = await import("./repositories/compute-template.js");
  const tmplRepo = new ComputeTemplateRepositoryCtor(db);
  tmplRepo.setTenant(SYSTEM_TENANT_ID);
  for (const tmpl of app.config.computeTemplates) {
    if (!(await tmplRepo.get(tmpl.name))) {
      await tmplRepo.create({
        name: tmpl.name,
        description: tmpl.description,
        compute: tmpl.compute,
        isolation: tmpl.isolation,
        config: tmpl.config,
      });
    }
  }
}

// ── Post-container rehydration (daemon-restart resilience) ───────────────────

/**
 * Re-dispatch for_each sessions that were mid-loop when the daemon last
 * stopped. The ForEachDispatcher sees `config.for_each_checkpoint` and
 * resumes (skipping completed iterations, retrying the in-flight one).
 * Best-effort background task -- errors must not block daemon start.
 */
export async function reconcileForEachSessions(app: AppContext): Promise<void> {
  try {
    const { logInfo: li, logError: le } = await import("./observability/structured-log.js");
    // Sweep every tenant -- a hosted deployment can have running sessions
    // across many tenant_ids, and the root repo is bound to "default" only.
    const running = await app.sessions.listAcrossTenants({ status: "running", limit: 500 });
    for (const session of running) {
      const cp = (session.config as Record<string, unknown> | null)?.for_each_checkpoint;
      if (!cp || typeof cp !== "object") continue;
      const cpTyped = cp as import("./services/flow.js").ForEachCheckpoint;

      li(
        "boot",
        `reconciling for_each session ${session.id} stage '${cpTyped.stage_name}' ` +
          `at iteration ${cpTyped.next_index}/${cpTyped.total_items}`,
      );

      // Reset to ready so dispatch can proceed (left as running when the
      // daemon crashed). Route every write + dispatch through the session's
      // tenant scope (Core P1-6).
      try {
        const tenantApp = app.forTenant(session.tenant_id);
        await tenantApp.sessions.update(session.id, { status: "ready", session_id: null });
        await tenantApp.dispatchService.dispatch(session.id);
      } catch (err: any) {
        le("boot", `reconcile for_each session ${session.id} failed: ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    try {
      const { logWarn: lw2 } = await import("./observability/structured-log.js");
      lw2("boot", `reconcileForEachSessions: scan failed: ${err?.message ?? err}`);
    } catch {
      // best-effort
    }
  }
}

/**
 * Re-register inline-flow definitions persisted under `config.inline_flow`.
 * On restart the ephemeral overlay is empty; without this, stage lookups
 * for inline-flow sessions fail (flow not found). Best-effort.
 */
export async function rehydrateInlineFlows(app: AppContext): Promise<void> {
  try {
    // Inline flow definitions persist under session.config.inline_flow
    // across all tenants. The flow store's inline overlay is process-wide
    // (keyed by name), so registering a tenant-A inline flow here is safe.
    const sessions = await app.sessions.listAcrossTenants({ limit: 1000 });
    for (const session of sessions) {
      const inlineFlow = (session.config as Record<string, unknown> | null)?.inline_flow;
      if (!inlineFlow || typeof inlineFlow !== "object") continue;
      const def = inlineFlow as import("./services/flow.js").FlowDefinition;
      if (!def.name || !Array.isArray(def.stages)) continue;
      app.flows.registerInline?.(def.name, def);
    }
  } catch {
    // Best-effort -- log nothing so tests don't see noise.
  }
}

/**
 * Re-arm status pollers + arkd events consumers for sessions that were
 * `running` when the daemon last stopped. Without this, hot-reloads
 * (`bun --watch`) and operator restarts orphan in-flight sessions: agents
 * on the worker keep going but the conductor stops polling and stops
 * draining the arkd events stream, so the UI never sees progress and the
 * session never auto-advances on completion. Closes #424.
 */
export async function rehydrateRunningSessions(app: AppContext): Promise<void> {
  const { logInfo: li, logWarn: lw } = await import("./observability/structured-log.js");
  let pollers = 0;
  let stalePortsCleared = 0;
  const computesNeedingTransport = new Map<string, string>();
  try {
    const sessions = await app.sessions.listAcrossTenants({ status: "running", limit: 500 });
    for (const session of sessions) {
      // RESILIENCE: clear `arkd_local_forward_port` on boot. It indexes a
      // SSM port-forward subprocess owned by the PREVIOUS conductor process;
      // once the daemon restarts that tunnel is dead but the port stays
      // cached on the row, so the next arkd RPC posts to a dead port
      // (ECONNREFUSED). Clearing forces the next ensureReachable to allocate
      // a fresh tunnel before any RPC fires.
      const cfg = session.config as Record<string, unknown> | null;
      if (cfg && typeof cfg.arkd_local_forward_port === "number") {
        try {
          const tenantApp = app.forTenant(session.tenant_id);
          const next = { ...cfg };
          delete next.arkd_local_forward_port;
          await tenantApp.sessions.update(session.id, { config: next });
          stalePortsCleared++;
        } catch (err: any) {
          lw("boot", `rehydrate: failed to clear stale port for ${session.id}: ${err?.message ?? err}`);
        }
      }
      if (!session.session_id || !session.compute_name) continue;
      // Track the (compute, tenant) pair so we restart consumers exactly once
      // per compute, scoped to a tenant that owns at least one session there.
      if (!computesNeedingTransport.has(session.compute_name)) {
        computesNeedingTransport.set(session.compute_name, session.tenant_id);
      }
      try {
        const { startStatusPoller } = await import("./executors/status-poller.js");
        const { resolveSessionExecutor } = await import("./executors/resolve.js");
        // Read the canonical launch_executor (set by post-launch when the
        // session was dispatched), with the agent-definition runtime as
        // fallback for legacy sessions. A wrong runtime here makes the poller
        // probe the wrong endpoint (claude-agent uses /process/status).
        const tenantApp = app.forTenant(session.tenant_id);
        const runtime = await resolveSessionExecutor(tenantApp, session);
        if (!runtime) {
          lw("boot", `rehydrate: no runtime for session ${session.id} -- skipping poller`);
          continue;
        }
        startStatusPoller(tenantApp, session.id, session.session_id, runtime);
        pollers++;
      } catch (err: any) {
        lw("boot", `rehydrate poller failed for ${session.id}: ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    lw("boot", `rehydrateRunningSessions: scan failed: ${err?.message ?? err}`);
    return;
  }

  let consumers = 0;
  for (const [computeName, tenantId] of computesNeedingTransport) {
    try {
      const tenantApp = app.forTenant(tenantId);
      const compute = await tenantApp.computes.get(computeName);
      if (!compute) continue;
      const computeImpl = tenantApp.getCompute(compute.compute_kind);
      if (!computeImpl) continue;
      const handle = computeImpl.attachExistingHandle?.({
        name: compute.name,
        status: compute.status,
        config: (compute.config ?? {}) as Record<string, unknown>,
      });
      if (!handle) continue;
      const arkdUrl = computeImpl.getArkdUrl(handle);
      if (!arkdUrl) continue;
      const { startArkdEventsConsumer } = await import("./services/channel/arkd-events-consumer.js");
      const { depsFromApp } = await import("./services/deps.js");
      // Replica-agnostic liveness: re-resolve the compute's arkd from the
      // shared computes repo each loop. Returns null once the compute / pod
      // is gone, which is how this owner-less rehydrated consumer
      // self-terminates instead of reconnect-looping a dead address.
      const resolveArkdUrl = async (): Promise<string | null> => {
        try {
          const c = await tenantApp.computes.get(computeName);
          if (!c) return null;
          const impl = tenantApp.getCompute(c.compute_kind);
          if (!impl) return null;
          const h = impl.attachExistingHandle?.({
            name: c.name,
            status: c.status,
            config: (c.config ?? {}) as Record<string, unknown>,
          });
          if (!h) return null;
          return impl.getArkdUrl(h) ?? null;
        } catch {
          return arkdUrl;
        }
      };
      startArkdEventsConsumer(
        depsFromApp(tenantApp),
        computeName,
        arkdUrl,
        process.env.ARK_ARKD_TOKEN ?? null,
        undefined,
        resolveArkdUrl,
      );
      consumers++;
    } catch (err: any) {
      lw("boot", `rehydrate consumer failed for ${computeName}: ${err?.message ?? err}`);
    }
  }

  if (pollers > 0 || consumers > 0 || stalePortsCleared > 0) {
    li(
      "boot",
      `rehydrated ${pollers} status pollers + ${consumers} events consumers, cleared ${stalePortsCleared} stale arkd-tunnel ports for in-flight sessions`,
    );
  }
}
