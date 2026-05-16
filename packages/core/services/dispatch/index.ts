/**
 * DispatchService -- resolve compute + launch the agent for the current stage.
 *
 * Implementation lives in `dispatch-core.ts`; this barrel re-exports the
 * class and the public types so external callers can keep importing from
 * `services/dispatch/index.js` without knowing about the internal split.
 *
 * Internal split:
 *   types.ts            -- DispatchDeps interface + callback shapes
 *   compute-resolve.ts  -- per-stage compute resolution + template cloning
 *   secrets-resolve.ts  -- stage + runtime secret merge
 *   dispatch-hosted.ts  -- hosted-mode scheduler delegation
 *   dispatch-fanout.ts  -- fork / fan-out split
 *   dispatch-core.ts    -- main dispatch + resume body (the class itself)
 */

export { DispatchService } from "./dispatch-core.js";
export type { DispatchDeps, DispatchResult } from "./types.js";
