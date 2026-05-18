/**
 * Session-lifecycle sub-services. Each owns one concern over a shared
 * `SessionLifecycleDeps` cradle-slice and is registered directly in the DI
 * container (no aggregating facade). Callers reach them via AppContext:
 * `app.sessionCreator`, `app.sessionTerminator`, `app.sessionSuspender`,
 * `app.sessionForker`, `app.sessionReviewer`.
 */

export { SessionCreator, resolveGitHubUrl } from "./create.js";
export { SessionTerminator } from "./terminate.js";
export { SessionSuspender } from "./suspend.js";
export { SessionForker } from "./fork-clone.js";
export { SessionReviewer, renderReworkPrompt } from "./review.js";

export type {
  SessionLifecycleDeps,
  SessionOpResult,
  StartSessionOpts,
  VerificationResult,
  VerifyScriptRunner,
} from "./types.js";
