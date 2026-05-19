/**
 * Conductor-side reader for arkd's generic `hooks` channel
 * (`/channel/hooks/subscribe`). Replaces the SSH `-R 19100:localhost:19100`
 * reverse tunnel that previously carried hook callbacks back to the
 * conductor. The agent's launcher hooks publish on the local arkd's `hooks`
 * channel; arkd buffers envelopes; this module subscribes as NDJSON and
 * dispatches each envelope into the existing handler pipelines so nothing
 * downstream changes shape.
 *
 * Channel reports + agent-to-agent relays travel the same channel. Pre-SSM
 * arkd would POST these directly to `${conductor}/api/channel/<sid>` and
 * `${conductor}/api/relay`, which only worked because the SSH `-R` tunnel
 * mapped the compute's `localhost:19100` back to the dev-box conductor.
 * Under pure SSM there is no reverse path, so arkd publishes those payloads
 * as `channel-report` / `channel-relay` envelopes on the same `hooks`
 * channel and we drain them here, dispatching through `handleReport` and
 * the channel-relay path respectively. See `arkd/routes/channel.ts` for
 * publishers and `arkd/routes/channels.ts` for the generic pub/sub.
 *
 * One reader per remote compute, keyed by compute name. Started when the
 * compute becomes reachable (right after the forward tunnel is up). The
 * reader follows the compute's *current* arkd: if the underlying arkd URL
 * changes (k8s provisions a fresh ephemeral pod per stage/session), the
 * stale reader is torn down and a new one is bound to the new URL so the
 * per-name keying never pins us to a dead pod.
 *
 * Resilience: the reader auto-reconnects with backoff on any error
 * other than an explicit stop. Failures are logged but never thrown --
 * a flaky network can't kill the conductor.
 */

import type { Session } from "../../../types/index.js";
import type { AppContext } from "../../app.js";
import type { OrchestrationDeps } from "../deps.js";
import { depsFromApp } from "../deps.js";
import { processHookPayload } from "./hook-status.js";
import { handleReport } from "./report-pipeline.js";
import type { OutboundMessage } from "./channel-types.js";
import { deliverToChannel } from "./deliver.js";
import { logDebug, logInfo, logWarn } from "../../observability/structured-log.js";
import { ArkdClient } from "../../../arkd/client/index.js";

interface ConsumerEntry {
  computeName: string;
  /**
   * The arkd base URL this consumer is bound to. Tracked so a compute
   * whose underlying arkd moved (k8s provisions a fresh ephemeral pod ->
   * fresh arkd URL per stage/session) re-targets instead of the
   * per-computeName dedup pinning the consumer to a dead pod forever.
   */
  arkdUrl: string;
  /**
   * The session whose ensureReachable (re)started this consumer. Used only
   * to attach durable subscribe/stream-error diagnostics to a session's
   * event log so "did the consumer for my pod actually subscribe?" is
   * answerable forever, not just from ephemeral process logs.
   */
  triggerSessionId?: string;
  /**
   * Compute-scoped (rehydrate) consumers have no owning session. Resolves
   * the compute's *current* arkd URL from shared state (the computes repo +
   * compute impl). Returns null once the compute no longer resolves an arkd
   * (pod gone / compute torn down) -- the replica-agnostic stop signal for a
   * consumer that nothing else will ever call stopArkdEventsConsumer for.
   */
  resolveArkdUrl?: () => Promise<string | null>;
  abort: AbortController;
  stopped: boolean;
}

// Compute-scoped consumers self-terminate after this many consecutive
// connect/stream failures with no recovery. There is no owning session and
// no shared registry, so failure-to-reach IS the correct lifetime signal:
// the backing ephemeral pod is genuinely gone and nothing else will stop us.
const COMPUTE_SCOPED_MAX_CONSECUTIVE_FAILURES = 8;

const consumers = new Map<string, ConsumerEntry>();

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 30_000;

interface NdjsonHookFrame {
  kind: "hook";
  session: string | null;
  query: string;
  body: unknown;
  ts: string;
}

interface NdjsonChannelReportFrame {
  kind: "channel-report";
  session: string;
  tenantId: string | null;
  body: unknown;
  ts: string;
}

interface NdjsonChannelRelayFrame {
  kind: "channel-relay";
  tenantId: string | null;
  body: unknown;
  ts: string;
}

type NdjsonFrame = NdjsonHookFrame | NdjsonChannelReportFrame | NdjsonChannelRelayFrame;

/**
 * Start the consumer for a compute. Idempotent: a second call for the
 * same compute is a no-op and returns the existing entry's controller.
 *
 * `arkdUrl` is the arkd HTTP base URL (already routed through the
 * forward tunnel, e.g. `http://localhost:59431`). `arkdToken` is the
 * shared bearer; passed straight through.
 */
export function startArkdEventsConsumer(
  deps: OrchestrationDeps,
  computeName: string,
  arkdUrl: string,
  arkdToken: string | null,
  triggerSessionId?: string,
  resolveArkdUrl?: () => Promise<string | null>,
): void {
  const app = deps.app!;
  const existing = consumers.get(computeName);
  if (existing && !existing.stopped) {
    if (existing.arkdUrl === arkdUrl) {
      logDebug("conductor", `arkd-events: already running for compute=${computeName}`);
      return;
    }
    // The compute's arkd moved (k8s ephemeral pod-per-stage/session gives a
    // fresh arkd URL each dispatch). The old loop is reconnecting against a
    // dead pod and the per-computeName dedup would otherwise pin us there
    // forever -- every later pod's hook stream (AgentMessage/PreToolUse/...)
    // would never reach the conductor. Tear it down and re-target.
    logInfo("conductor", `arkd-events: retargeting compute=${computeName} ${existing.arkdUrl} -> ${arkdUrl}`);
    existing.stopped = true;
    existing.abort.abort();
    consumers.delete(computeName);
  }
  const abort = new AbortController();
  const entry: ConsumerEntry = {
    computeName,
    arkdUrl,
    triggerSessionId,
    resolveArkdUrl,
    abort,
    stopped: false,
  };
  consumers.set(computeName, entry);
  void runConsumerLoop(app, entry, arkdUrl, arkdToken);
  logInfo("conductor", `arkd-events: consumer started for compute=${computeName} url=${arkdUrl}`);
}

/** Stop a consumer if any. Idempotent. */
export function stopArkdEventsConsumer(computeName: string): void {
  const entry = consumers.get(computeName);
  if (!entry) return;
  entry.stopped = true;
  entry.abort.abort();
  consumers.delete(computeName);
  logInfo("conductor", `arkd-events: consumer stopped for compute=${computeName}`);
}

/** Diagnostic helper: how many consumers are running. */
export function arkdEventsConsumerCount(): number {
  return consumers.size;
}

/**
 * Long-running loop that opens `/channel/hooks/subscribe` and stays
 * connected until told to stop. On any error other than a deliberate
 * abort, reconnects with exponential backoff (250ms -> 30s, jitter).
 * Reset to the floor on each successful read.
 */
async function runConsumerLoop(
  app: AppContext,
  entry: ConsumerEntry,
  arkdUrl: string,
  arkdToken: string | null,
): Promise<void> {
  let backoff = RECONNECT_MIN_MS;
  let consecutiveFailures = 0;
  while (!entry.stopped) {
    // A session-scoped consumer (k8s ephemeral pod-per-session) exists only
    // to drain THAT session's pod hooks. Its registry is an in-memory map
    // local to one process; with multiple temporal-worker replicas the
    // destroy/stop activity can land on a different replica than the one
    // that started this loop (or the session row can be GC'd before
    // destroyComputeActivity runs), so stopArkdEventsConsumer never reaches
    // it and it reconnect-loops a dead pod forever. Tie lifetime to the
    // session: once it is terminal or gone, the pod is being/already
    // destroyed -- there is nothing left to drain. Replica-agnostic
    // (every replica reads the same session row). Compute-scoped
    // rehydrated consumers (no triggerSessionId) are unaffected.
    if (entry.triggerSessionId) {
      try {
        const s = await app.sessions.get(entry.triggerSessionId);
        const terminal = !s || ["completed", "failed", "stopped", "cancelled", "deleting"].includes(s.status as string);
        if (terminal) {
          logInfo(
            "conductor",
            `arkd-events: session ${entry.triggerSessionId} ${s ? s.status : "gone"} -- stopping consumer compute=${entry.computeName}`,
          );
          entry.stopped = true;
          entry.abort.abort();
          consumers.delete(entry.computeName);
          return;
        }
      } catch {
        /* transient DB blip -- keep draining, re-check next cycle */
      }
    } else {
      // Compute-scoped (rehydrate) consumer: no owning session, no shared
      // registry. If the compute no longer resolves an arkd URL the backing
      // pod is gone and this loop would otherwise reconnect a dead address
      // forever (a different replica's stopArkdEventsConsumer can never
      // reach this process-local map). That is the correct lifetime here,
      // not a band-aid. Replica-agnostic: every replica resolves the same
      // computes-repo state.
      if (entry.resolveArkdUrl) {
        try {
          const current = await entry.resolveArkdUrl();
          if (!current) {
            logInfo(
              "conductor",
              `arkd-events: compute=${entry.computeName} no longer resolves an arkd url -- stopping consumer`,
            );
            entry.stopped = true;
            entry.abort.abort();
            consumers.delete(entry.computeName);
            return;
          }
        } catch {
          /* transient resolve blip -- failure bound below still bounds us */
        }
      }
      if (consecutiveFailures >= COMPUTE_SCOPED_MAX_CONSECUTIVE_FAILURES) {
        logInfo(
          "conductor",
          `arkd-events: compute=${entry.computeName} unreachable after ${consecutiveFailures} consecutive failures -- pod gone, stopping consumer`,
        );
        entry.stopped = true;
        entry.abort.abort();
        consumers.delete(entry.computeName);
        return;
      }
    }
    try {
      await readHooksChannelOnce(app, entry, arkdUrl, arkdToken);
      // Clean stream end (server closed) -- reconnect immediately.
      backoff = RECONNECT_MIN_MS;
      consecutiveFailures = 0;
    } catch (err: unknown) {
      if (entry.stopped) return;
      consecutiveFailures++;
      const msg = (err as { message?: string })?.message ?? String(err);
      logWarn("conductor", `arkd-events: stream error compute=${entry.computeName}: ${msg}`);
      // Durable: a subscribe/stream failure against this pod's arkd is the
      // single most common reason hooks never reach the timeline. Without
      // this it's invisible (the loop just silently reconnect-backoffs).
      if (entry.triggerSessionId) {
        await app.events
          .log(entry.triggerSessionId, "arkd_consumer_stream_error", {
            actor: "system",
            data: { compute: entry.computeName, arkdUrl: entry.arkdUrl, message: msg },
          })
          .catch(() => {});
      }
    }
    if (entry.stopped) return;
    const jitter = Math.random() * 0.25 * backoff;
    const delay = Math.min(backoff + jitter, RECONNECT_MAX_MS);
    await sleep(delay, entry.abort.signal);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }
}

/** Sleep for `ms` milliseconds, or return early when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Open the hooks channel subscribe stream once and pump until end / error /
 * abort. Delegates to `ArkdClient.subscribeToChannel` so there is exactly
 * one WS client implementation in the codebase.
 *
 * The Promise returned by `subscribeToChannel` resolves only after the
 * server's "subscribed" ack -- at which point the subscriber is registered
 * server-side. This gives the reconnect loop a clean signal: if the loop
 * exits the `for await` cleanly (socket closed by peer), it reconnects
 * after backoff; if it throws (error, abort), the outer loop handles it.
 */
async function readHooksChannelOnce(
  app: AppContext,
  entry: ConsumerEntry,
  arkdUrl: string,
  arkdToken: string | null,
): Promise<void> {
  const client = new ArkdClient(arkdUrl, { token: arkdToken ?? undefined });

  const iterable = await client.subscribeToChannel("hooks", { signal: entry.abort.signal });
  logInfo("conductor", `arkd-events: ws connected compute=${entry.computeName}`);
  // Durable proof the consumer actually subscribed (ack received) to this
  // pod's hooks channel. arkd_consumer_attached + this + arkd_hook_received
  // form the full causal chain in the session event log; a gap pinpoints
  // the broken link without spelunking ephemeral process logs.
  if (entry.triggerSessionId) {
    await app.events
      .log(entry.triggerSessionId, "arkd_consumer_subscribed", {
        actor: "system",
        data: { compute: entry.computeName, arkdUrl: entry.arkdUrl },
      })
      .catch(() => {});
  }

  for await (const frame of iterable) {
    if (entry.stopped) return;
    // dispatchFrame is async; we don't await so frames are independent and
    // don't back-pressure the WS reader. Errors are caught inside.
    void dispatchFrame(app, JSON.stringify(frame));
  }
}

/**
 * Tenant-scope an AppContext by id, mirroring what `appForRequest` does
 * for the live HTTP path. `null` / empty strings fall through to the
 * unscoped app (the local-mode default), which matches the pre-fix
 * behaviour when the agent didn't send `X-Ark-Tenant-Id`.
 */
function scopeApp(app: AppContext, tenantId: string | null): AppContext {
  if (!tenantId) return app;
  try {
    return app.forTenant(tenantId);
  } catch {
    return app;
  }
}

/**
 * Parse one NDJSON line and route it to the right downstream handler.
 * Currently `hook`, `channel-report`, and `channel-relay` are emitted;
 * unknown kinds are logged and ignored so arkd / publishers can introduce
 * new envelope types without breaking the conductor.
 */
async function dispatchFrame(app: AppContext, line: string): Promise<void> {
  let frame: NdjsonFrame;
  try {
    frame = JSON.parse(line) as NdjsonFrame;
  } catch {
    logWarn("conductor", `arkd-events: malformed JSON line; ignoring`);
    return;
  }
  if (!frame || typeof (frame as { kind?: unknown }).kind !== "string") {
    // Server keepalive frames are `{}` -- they exist to keep the HTTP/1.1
    // connection from idle-closing on the SSM tunnel / intermediate proxies.
    // Don't warn on them; only warn on genuinely-malformed frames.
    if (frame && Object.keys(frame as object).length > 0) {
      logWarn("conductor", `arkd-events: untyped frame; ignoring`);
    }
    return;
  }
  if (frame.kind === "hook") {
    // Build a synthetic Request/URL that the handler can read session + payload from.
    const url = new URL(`http://internal/hooks/status${frame.query ? "?" + frame.query : ""}`);
    const sessionId = url.searchParams.get("session");
    if (!sessionId) {
      logWarn("conductor", `arkd-events: hook frame missing session param`);
      return;
    }
    const payload = frame.body as Record<string, unknown>;
    const hookEvent = typeof payload?.hook_event_name === "string" ? payload.hook_event_name : "unknown";
    try {
      const s = await app.sessions.get(sessionId);
      if (!s) {
        logDebug("conductor", `arkd-events: hook handler session not found session=${sessionId}`);
        // Durable trace: a hook arrived for a session the conductor can't
        // resolve. Without this the loss is silent and undiagnosable later.
        await app.events
          .log(sessionId, "arkd_hook_dropped", {
            actor: "system",
            data: { event: hookEvent, reason: "session_not_found" },
          })
          .catch(() => {});
        return;
      }
      // Durable, session-attached proof the hook pipeline delivered this
      // hook to the conductor (survives pod death; queryable via
      // session/events forever). Pairs with arkd_consumer_attached.
      await app.events
        .log(sessionId, "arkd_hook_received", { actor: "system", data: { event: hookEvent } })
        .catch(() => {});
      await processHookPayload(app, sessionId, s, payload);
      await app.events
        .log(sessionId, "arkd_hook_persisted", { actor: "system", data: { event: hookEvent } })
        .catch(() => {});
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      logWarn("conductor", `arkd-events: hook dispatch threw: ${msg}`);
      await app.events
        .log(sessionId, "arkd_hook_error", { actor: "system", data: { event: hookEvent, message: msg } })
        .catch(() => {});
    }
    return;
  }
  if (frame.kind === "channel-report") {
    // Mirror the legacy `/api/channel/:sessionId` HTTP route on conductor.ts:
    // resolve the tenant-scoped app, then run `handleReport`. Tenant scoping
    // is critical -- without it a hosted-mode conductor would write the
    // session update against the wrong tenant's repo and the UI would never
    // see the completion.
    const scoped = scopeApp(app, frame.tenantId);
    const report = frame.body as OutboundMessage;
    try {
      await handleReport(depsFromApp(scoped), frame.session, report);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      logWarn("conductor", `arkd-events: channel-report dispatch threw for session=${frame.session}: ${msg}`);
    }
    return;
  }
  if (frame.kind === "channel-relay") {
    // Mirror the legacy `/api/relay` HTTP route. The relay payload looks up
    // the target session, computes the channel port, and pushes a `steer`
    // payload via `deliverToChannel` (which already prefers arkd over direct
    // HTTP and re-scopes by the target session's own tenant).
    const scoped = scopeApp(app, frame.tenantId);
    const relay = frame.body as { from: string; target: string; message: string };
    if (!relay || typeof relay.target !== "string") {
      logWarn("conductor", `arkd-events: channel-relay missing target; ignoring`);
      return;
    }
    try {
      const targetSession = await scoped.sessions.get(relay.target);
      if (targetSession) {
        const channelPort = scoped.sessions.channelPort(relay.target);
        const payload = {
          type: "steer",
          message: relay.message,
          from: relay.from,
          sessionId: relay.target,
        };
        await deliverToChannel(scoped, targetSession as Session, channelPort, payload);
      }
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      logWarn("conductor", `arkd-events: channel-relay dispatch threw target=${relay.target}: ${msg}`);
    }
    return;
  }
  logDebug("conductor", `arkd-events: unhandled frame kind=${(frame as { kind: string }).kind}`);
}

/** Test helper: drop all consumers without going through the network. */
export function _resetArkdEventsConsumers(): void {
  for (const entry of consumers.values()) {
    entry.stopped = true;
    entry.abort.abort();
  }
  consumers.clear();
}
