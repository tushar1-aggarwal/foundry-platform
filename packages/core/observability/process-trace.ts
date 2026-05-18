/**
 * Durable process-trace shipping.
 *
 * Long-lived Ark processes (conductor daemon, temporal-worker) write their
 * logs to an ephemeral pod-local file. When the pod dies the operational
 * history dies with it -- which is exactly why the hook-pipeline regression
 * was undiagnosable for so long. This ships a process's logfile to the
 * durable blob store on an interval and at shutdown, retrievable long after
 * the pod is gone. Same philosophy as captureWorkerForensics, for processes
 * instead of sessions. Reuses session-forensic's tail/cap helpers so the
 * read semantics match (no silent truncation).
 */

import { promises as fs } from "node:fs";
import type { AppContext } from "../app.js";
import { encodeLocator, LOCAL_TENANT_ID } from "../storage/blob-store.js";
import { isForensicTooLarge, applyForensicTail } from "../services/session-forensic.js";
import { logDebug } from "./structured-log.js";

const DIAGNOSTICS_NS = "diagnostics";
const DEFAULT_INTERVAL_MS = 30_000;
/** Ship at most the last 8MB of the logfile (matches forensic capture cap). */
const TRACE_CAP_BYTES = 8 * 1024 * 1024;

export interface ProcessTraceShipper {
  stop(): void;
}

function traceKey(component: string) {
  return { tenantId: LOCAL_TENANT_ID, namespace: DIAGNOSTICS_NS, id: component, filename: `${component}.log` };
}

/**
 * Begin periodically shipping `logfilePath` to durable storage under
 * `component`. Best-effort: a read/put failure is swallowed (a flaky blob
 * backend must never destabilise the process whose logs we're capturing).
 * Flushes once more on SIGTERM/beforeExit so the final state survives.
 */
export function startProcessTraceShipping(
  app: AppContext,
  component: string,
  logfilePath: string,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): ProcessTraceShipper {
  let stopped = false;

  const flush = async (): Promise<void> => {
    try {
      const buf = await fs.readFile(logfilePath).catch(() => null);
      if (!buf || buf.byteLength === 0) return;
      const slice = buf.byteLength > TRACE_CAP_BYTES ? buf.subarray(buf.byteLength - TRACE_CAP_BYTES) : buf;
      await app.blobStore.put(traceKey(component), Buffer.from(slice), {
        contentType: "text/plain",
        maxBytes: TRACE_CAP_BYTES,
      });
    } catch (e) {
      logDebug("observability", `process-trace: flush failed for ${component}: ${(e as Error)?.message ?? e}`);
    }
  };

  const timer = setInterval(() => {
    if (!stopped) void flush();
  }, intervalMs);
  // Don't keep the event loop alive solely for trace shipping.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }

  const onExit = (): void => {
    void flush();
  };
  process.once("SIGTERM", onExit);
  process.once("beforeExit", onExit);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      process.removeListener("SIGTERM", onExit);
      process.removeListener("beforeExit", onExit);
      void flush();
    },
  };
}

export interface ProcessTraceReadResult {
  content: string;
  size: number;
  exists: boolean;
  tooLarge: boolean;
}

/**
 * Read a process's durable trace back. Mirrors readSessionForensic's
 * contract: full content under the cap, explicit `tooLarge` over it with
 * no tail, or an exact line-boundary tail -- never a silent partial.
 */
export async function readProcessTrace(
  app: AppContext,
  component: string,
  opts: { tail?: number } = {},
): Promise<ProcessTraceReadResult> {
  try {
    const locator = encodeLocator(traceKey(component));
    const { bytes } = await app.blobStore.get(locator, LOCAL_TENANT_ID);
    const size = bytes.byteLength;
    if (isForensicTooLarge(size, opts.tail)) {
      return { content: "", size, exists: true, tooLarge: true };
    }
    return { content: applyForensicTail(bytes.toString("utf-8"), opts.tail), size, exists: true, tooLarge: false };
  } catch {
    return { content: "", size: 0, exists: false, tooLarge: false };
  }
}
