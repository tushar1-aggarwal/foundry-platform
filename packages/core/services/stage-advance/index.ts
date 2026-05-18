/**
 * StageAdvanceService -- stage advancement, completion, agent handoff,
 * action execution, and non-Claude transcript parsing.
 *
 * Implementation lives in `advance.ts`; this barrel re-exports the class
 * and the public types so external callers can keep importing from
 * `services/stage-advance/index.js`.
 */

export { StageAdvanceService } from "./advance.js";
export type { StageAdvanceDeps, IdempotencyCapable, StageOpResult } from "./types.js";
