/**
 * Diagnostics RPCs -- read durable process traces (conductor-daemon,
 * temporal-worker) shipped to the blob store by startProcessTraceShipping.
 *
 * These survive pod death, so an operator can answer "what was the
 * conductor / temporal-worker doing" long after the pod is gone -- the
 * gap that made the hook-pipeline regression undiagnosable.
 */

import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";

const KNOWN_COMPONENTS = new Set(["conductor-daemon", "temporal-worker"]);

export function registerDiagnosticsHandlers(router: Router, app: AppContext): void {
  router.handle("diagnostics/processLog", async (params) => {
    const { component, tail } = extract<{ component: string; tail?: number }>(params, ["component"]);
    if (!KNOWN_COMPONENTS.has(component)) {
      throw new RpcError(
        `Unknown component '${component}'. Known: ${[...KNOWN_COMPONENTS].join(", ")}`,
        ErrorCodes.INVALID_PARAMS,
      );
    }
    const { readProcessTrace } = await import("../../core/observability/process-trace.js");
    const read = await readProcessTrace(app, component, { tail });
    if (read.tooLarge) {
      throw new RpcError(
        `${component} trace is ${read.size} bytes, over the cap -- pass tail=<N> to read the tail`,
        ErrorCodes.INVALID_PARAMS,
      );
    }
    return { content: read.content, size: read.size, exists: read.exists };
  });
}
