/**
 * @ark/secrets -- envelope encryption, KEK custody, tenant DEK management,
 * per-secret cipher, resolver. v1 ships the KEK seam only.
 *
 * See docs/superpowers/specs/2026-05-13-hierarchical-secrets-design.md and
 * docs/superpowers/specs/2026-05-14-ssm-kek-backend.md.
 */
export type { KekBackend, LoadedKek } from "./kek/backend.js";
export { KekLoadError } from "./kek/backend.js";
export { SecureBuffer } from "./kek/memory.js";
export type { KekConfig } from "./kek/load.js";
export { loadMasterKey, selectKekBackend, parseKekConfigFromEnv } from "./kek/load.js";
